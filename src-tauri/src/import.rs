//! Импорт карт по ссылкам: разбор текста, докачка с osu!, запись в базу, обложки.
//!
//! Всё идёт через одну очередь 60/мин. Прогресс летит событием, интерфейс не блокируется.
//! Ошибка по конкретной карте не роняет пачку.

use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::error::{AppError, Result};
use crate::model::{ImportFailure, ImportProgress, ParsedLinks};
use crate::queue::{emit_cover, emit_progress};
use crate::state::AppState;

/// Сколько id влезает в один запрос `/beatmaps?ids[]=`.
pub(crate) const BATCH: usize = 50;

/// Сколько мест в минутном окне импорт оставляет опросу лобби.
///
/// Опрос идущего матча ходит раз в 5 секунд — это 12 запросов в минуту. Если
/// очередь загружена импортом карт, результат матча нужен сейчас, а обложки
/// могут подождать, поэтому импорт до последних мест не дотягивается.
pub(crate) const LOBBY_RESERVE: usize = 12;

pub fn new_batch_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

struct Progress {
    inner: ImportProgress,
    app: AppHandle,
}

impl Progress {
    fn new(app: AppHandle, batch_id: String, total: i64) -> Self {
        Self {
            inner: ImportProgress {
                batch_id,
                stage: "queued".into(),
                done: 0,
                total,
                added: 0,
                skipped: 0,
                failed: vec![],
            },
            app,
        }
    }

    fn stage(&mut self, stage: &str) {
        self.inner.stage = stage.into();
        self.emit();
    }

    fn advance(&mut self, done: i64, added: i64, skipped: i64) {
        self.inner.done += done;
        self.inner.added += added;
        self.inner.skipped += skipped;
        self.emit();
    }

    fn fail(&mut self, reference: String, reason: String) {
        self.inner.failed.push(ImportFailure { reference, reason });
        self.inner.done += 1;
        self.emit();
    }

    fn emit(&self) {
        emit_progress(&self.app, &self.inner);
    }
}

/// Ставит найденное в работу и сразу возвращает управление.
/// Дальше всё происходит в фоне, интерфейс живой.
pub fn spawn_import(app: AppHandle, parsed: ParsedLinks) -> Result<String> {
    let batch_id = new_batch_id();
    let id = batch_id.clone();

    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_import(app.clone(), id.clone(), parsed).await {
            // Пачка целиком не смогла стартовать — сообщаем это одной строкой,
            // а не молчим.
            let state = app.state::<Arc<AppState>>();
            state.batches.finish(&id).await;
            let mut p = Progress::new(app.clone(), id, 0);
            p.fail("пачка".into(), e.to_string());
            p.stage("done");
        }
    });

    Ok(batch_id)
}

async fn run_import(app: AppHandle, batch_id: String, parsed: ParsedLinks) -> Result<()> {
    let state = app.state::<Arc<AppState>>().inner().clone();
    let creds = state.credentials()?;

    state.batches.start(&batch_id).await;

    // Наборы разворачиваем в конкретные сложности — их количество заранее неизвестно,
    // поэтому total уточняется по ходу.
    let total = (parsed.beatmap_ids.len() + parsed.beatmapset_ids.len()) as i64;
    let mut p = Progress::new(app.clone(), batch_id.clone(), total);
    p.stage("fetching");

    let mut fresh: Vec<crate::model::Beatmap> = Vec::new();

    // ── наборы: один запрос на набор, отдаёт все сложности сразу
    for set_id in &parsed.beatmapset_ids {
        if state.batches.is_cancelled(&batch_id).await {
            p.stage("cancelled");
            state.batches.finish(&batch_id).await;
            return Ok(());
        }

        state.limiter.acquire_reserving(LOBBY_RESERVE).await;
        match state.osu.beatmapset(&creds, *set_id).await {
            Ok(maps) => {
                p.inner.total += maps.len() as i64 - 1;
                fresh.extend(maps);
                p.advance(1, 0, 0);
            }
            Err(e) => p.fail(format!("набор {set_id}"), e.to_string()),
        }
    }

    // ── отдельные сложности: пачками по 50
    for chunk in parsed.beatmap_ids.chunks(BATCH) {
        if state.batches.is_cancelled(&batch_id).await {
            p.stage("cancelled");
            state.batches.finish(&batch_id).await;
            return Ok(());
        }

        state.limiter.acquire_reserving(LOBBY_RESERVE).await;
        match state.osu.beatmaps(&creds, chunk).await {
            Ok(maps) => {
                // То, что osu! не вернул, — удалённые или закрытые карты.
                let got: Vec<i64> = maps.iter().map(|m| m.beatmap_id).collect();
                for missing in chunk.iter().filter(|id| !got.contains(id)) {
                    p.fail(
                        format!("карта {missing}"),
                        "на osu! не найдена".into(),
                    );
                }
                let n = maps.len() as i64;
                fresh.extend(maps);
                p.advance(n, 0, 0);
            }
            Err(e) => {
                for id in chunk {
                    p.fail(format!("карта {id}"), e.to_string());
                }
            }
        }
    }

    // ── запись в базу одной транзакцией: карты появляются в библиотеке разом
    p.stage("saving");
    let mut added = 0i64;
    let mut skipped = 0i64;

    let to_save = fresh.clone();
    state.db.with_tx(|tx| {
        for map in &to_save {
            match crate::db::beatmaps::upsert(tx, map) {
                Ok(true) => added += 1,
                Ok(false) => skipped += 1,
                Err(e) => return Err(e),
            }
        }
        Ok(())
    })?;

    p.inner.added = added;
    p.inner.skipped = skipped;
    p.emit();

    // ── скилсеты: считаются по атрибутам, а те приходят по запросу на карту.
    // Это самая долгая часть импорта, поэтому она идёт после того, как карты
    // уже видны в библиотеке: скилсеты просто дозаполнятся позже.
    p.stage("skillsets");
    p.inner.done = 0;
    p.inner.total = fresh.len() as i64;
    p.emit();

    for map in &fresh {
        if state.batches.is_cancelled(&batch_id).await {
            break;
        }

        state.limiter.acquire_reserving(LOBBY_RESERVE).await;
        // Атрибуты без модов: скилсет — свойство самой карты, а не сочетания.
        let attr = match state.osu.attributes(&creds, map.beatmap_id, 0).await {
            Ok(a) => a,
            // Одна карта без атрибутов — не повод останавливать пачку: скилсеты
            // всегда можно проставить руками.
            Err(_) => {
                p.advance(1, 0, 0);
                continue;
            }
        };

        let guessed = crate::db::beatmaps::auto_skillsets(map, &attr);
        let id = map.beatmap_id;
        let _ = state.db.with_tx(|tx| {
            crate::db::beatmaps::put_attributes(tx, &attr)?;
            crate::db::beatmaps::suggest_skillsets(tx, id, &guessed)
        });

        p.advance(1, 0, 0);
    }

    // ── обложки: качаются после того, как карты уже видны в библиотеке
    p.stage("covers");
    let mut sets: Vec<i64> = fresh.iter().filter_map(|m| m.beatmapset_id).collect();
    sets.sort_unstable();
    sets.dedup();

    for set_id in sets {
        if state.batches.is_cancelled(&batch_id).await {
            break;
        }

        let ids: Vec<i64> = fresh
            .iter()
            .filter(|m| m.beatmapset_id == Some(set_id))
            .map(|m| m.beatmap_id)
            .collect();

        // Файл уже в кеше — качать нечего, но путь в карту прописать надо:
        // после удаления и повторного добавления строка в базе новая, а
        // обложка осталась с прошлого раза. Без этого карта выглядит
        // «без обложки», хотя картинка лежит на диске.
        if state.covers.has(set_id) {
            let path_str = state.covers.path_for(set_id).to_string_lossy().to_string();
            let _ = state.db.with(|conn| {
                for id in &ids {
                    crate::db::beatmaps::set_cover_path(conn, *id, &path_str)?;
                }
                Ok(())
            });
            for id in ids {
                emit_cover(&app, id);
            }
            continue;
        }

        // Обложки лежат на assets.ppy.sh без авторизации и в лимит API не входят.
        if let Ok(bytes) = state.osu.download_cover(set_id).await {
            if let Ok(path) = state.covers.put(set_id, &bytes) {
                let path_str = path.to_string_lossy().to_string();

                let _ = state.db.with(|conn| {
                    for id in &ids {
                        crate::db::beatmaps::set_cover_path(conn, *id, &path_str)?;
                    }
                    Ok(())
                });

                for id in ids {
                    emit_cover(&app, id);
                }
            }
        }
    }

    p.stage("done");
    state.batches.finish(&batch_id).await;
    Ok(())
}

/// Повторная попытка по тем картам, что не загрузились.
pub fn retry(app: AppHandle, failed: Vec<i64>) -> Result<String> {
    if failed.is_empty() {
        return Err(AppError::Other("Повторять нечего".into()));
    }
    spawn_import(
        app,
        ParsedLinks {
            beatmap_ids: failed,
            beatmapset_ids: vec![],
            unknown: vec![],
        },
    )
}
