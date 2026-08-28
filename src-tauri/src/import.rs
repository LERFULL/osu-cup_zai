//! Загрузки: очередь пачек ссылок, докачка с osu!, запись в базу, обложки.
//!
//! Отличие от старого импорта: пачки обрабатываются строго по одной, в
//! порядке постановки, и карта попадает в библиотеку только тогда, когда
//! пачка скачалась целиком — данные, скилсеты и обложки. Пока пачка
//! качается, библиотека остаётся прежней.
//!
//! Очередь живёт в базе (таблица `import_batches`), поэтому переживает
//! перезапуск приложения: недокачанные пачки подхватываются сами.
//! Авто-теги пачки (например NM на все 20 ссылок) проставляются при записи.

use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use crate::db::downloads as store;
use crate::error::{AppError, Result};
use crate::model::{ImportBatch, ImportFailure, ImportProgress, ParsedLinks};
use crate::queue::emit_progress;
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

/// Ставит пачку в конец очереди и будит обработчик. Возвращает запись —
/// фронт сразу покажет её в списке со статусом «в очереди».
pub fn enqueue(
    app: AppHandle,
    parsed: ParsedLinks,
    mods: Vec<String>,
    name: String,
) -> Result<ImportBatch> {
    if parsed.beatmap_ids.is_empty() && parsed.beatmapset_ids.is_empty() {
        return Err(AppError::Other("В пачке нет ни одной карты".into()));
    }

    let batch_id = new_batch_id();
    let state = app.state::<Arc<AppState>>();
    let batch = state.db.with(|conn| {
        store::insert(
            conn,
            &batch_id,
            &name,
            &mods,
            &parsed.beatmap_ids,
            &parsed.beatmapset_ids,
        )
    })?;

    // Будим обработчик ДО ensure_runner: если он уже спит, уведомление
    // оставит ему разрешение, если его нет — ensure_runner поднимет новый.
    state.queue_notify.notify_one();
    ensure_runner(&app);
    changed(&app);
    Ok(batch)
}

/// Повтор пачки: снова в очередь с нуля. Готовые карты при загрузке
/// обновятся, а не задвоятся — запись идёт через `upsert`.
pub fn retry(app: AppHandle, batch_id: &str) -> Result<ImportBatch> {
    let state = app.state::<Arc<AppState>>();
    let batch = state.db.with(|conn| {
        store::reset(conn, batch_id)?;
        store::get(conn, batch_id)?.ok_or_else(|| AppError::Other("Пачка не найдена".into()))
    })?;

    state.queue_notify.notify_one();
    ensure_runner(&app);
    changed(&app);
    Ok(batch)
}

/// Отмена. Ждущую пачку вычёркиваем сразу, идущую — помечаем: обработчик
/// заметит флаг на ближайшем шаге и остановится сам.
pub async fn cancel(app: AppHandle, batch_id: &str) -> Result<ImportBatch> {
    let state = app.state::<Arc<AppState>>();
    let batch = state
        .db
        .with(|conn| store::get(conn, batch_id))?
        .ok_or_else(|| AppError::Other("Пачка не найдена".into()))?;

    if batch.status == "queued" {
        state
            .db
            .with(|conn| store::set_status(conn, batch_id, "cancelled", "cancelled"))?;
    } else if batch.status == "running" {
        // Флаг отмены заметит сам обработчик; событие не шлём — статус
        // «running» в списке сменится на «cancelled», когда он остановится.
        state.batches.cancel(batch_id).await;
        return Ok(batch);
    }

    changed(&app);
    state
        .db
        .with(|conn| store::get(conn, batch_id))?
        .ok_or_else(|| AppError::Other("Пачка не найдена".into()))
}

/// Убрать пачку из списка. Идущую трогать нельзя — пусть сначала отменят.
pub fn remove(app: AppHandle, batch_id: &str) -> Result<()> {
    let state = app.state::<Arc<AppState>>();
    state.db.with(|conn| store::remove(conn, batch_id))?;
    changed(&app);
    Ok(())
}

/// Уборка finished-пачек из списка.
pub fn clear_finished(app: AppHandle) -> Result<()> {
    let state = app.state::<Arc<AppState>>();
    state.db.with(store::clear_finished)?;
    changed(&app);
    Ok(())
}

/// Поднять обработчик, если он ещё не бежит. Вызывается и при старте
/// приложения (недокачанные пачки), и после каждой постановки в очередь.
pub fn ensure_runner(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>();
    if !state.runner.take() {
        return;
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        runner_loop(handle).await;
    });
}

/// При старте приложения: пачки, застрявшие в «running» (приложение убили
/// посреди загрузки), возвращаются в очередь и докачиваются.
pub fn revive_and_run(app: &AppHandle) -> Result<()> {
    let state = app.state::<Arc<AppState>>();
    state.db.with(store::revive_stuck)?;
    ensure_runner(app);
    Ok(())
}

async fn runner_loop(app: AppHandle) {
    let state = app.state::<Arc<AppState>>();

    loop {
        match state.db.with(store::next_queued) {
            Ok(Some(batch)) => {
                if let Err(e) = run_batch(&app, &batch).await {
                    fail_batch(&app, &batch.batch_id, e.to_string());
                }
                changed(&app);
            }
            Ok(None) => {
                // Работы нет — спим до следующей постановки в очередь.
                // Раз в полминуты перепроверяем и так: от переставленных
                // уведомлений и на случай, если пачку вернули руками.
                tokio::select! {
                    _ = state.queue_notify.notified() => {}
                    _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {}
                }
            }
            // База временно недоступна — подождём и попробуем ещё раз,
            // а не молча бросим очередь с живыми пачками внутри.
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        }
    }
}

/// Пачка целиком не смогла: причина — одной записью в списке неудач,
/// статус «failed». Очередь переходит к следующей пачке.
fn fail_batch(app: &AppHandle, batch_id: &str, reason: String) {
    let state = app.state::<Arc<AppState>>();
    let _ = state.db.with(|conn| {
        let mut failed = store::get(conn, batch_id)?
            .map(|b| b.failed)
            .unwrap_or_default();
        failed.push(ImportFailure {
            reference: "пачка".into(),
            reason: reason.clone(),
        });
        store::save_progress(conn, batch_id, "failed", 0, 0, 0, 0, &failed)?;
        store::set_status(conn, batch_id, "failed", "failed")
    });
    let _ = app.emit(
        "import:progress",
        ImportProgress {
            batch_id: batch_id.into(),
            stage: "failed".into(),
            done: 0,
            total: 0,
            added: 0,
            skipped: 0,
            failed: vec![ImportFailure {
                reference: "пачка".into(),
                reason,
            }],
        },
    );
}

/// Прогресс пачки: летит событием на фронт и параллельно пишется в базу —
/// счётчики остаются честными даже после перезапуска приложения.
struct Progress {
    inner: ImportProgress,
    app: AppHandle,
}

impl Progress {
    fn new(app: AppHandle, batch: &ImportBatch) -> Self {
        Self {
            inner: ImportProgress {
                batch_id: batch.batch_id.clone(),
                stage: batch.stage.clone(),
                done: batch.done,
                total: batch.total,
                added: batch.added,
                skipped: batch.skipped,
                failed: batch.failed.clone(),
            },
            app,
        }
    }

    fn stage(&mut self, stage: &str) {
        self.inner.stage = stage.into();
        self.flush();
    }

    fn advance(&mut self, done: i64, added: i64, skipped: i64) {
        self.inner.done += done;
        self.inner.added += added;
        self.inner.skipped += skipped;
        self.flush();
    }

    fn fail(&mut self, reference: String, reason: String) {
        self.inner.failed.push(ImportFailure { reference, reason });
        self.inner.done += 1;
        self.flush();
    }

    /// Полная перезапись счётчиков — стадия сбрасывает прогресс в ноль.
    fn reset(&mut self, stage: &str, total: i64) {
        self.inner.stage = stage.into();
        self.inner.done = 0;
        self.inner.total = total;
        self.flush();
    }

    fn flush(&self) {
        emit_progress(&self.app, &self.inner);

        let state = self.app.state::<Arc<AppState>>();
        let _ = state.db.with(|conn| {
            store::save_progress(
                conn,
                &self.inner.batch_id,
                &self.inner.stage,
                self.inner.done,
                self.inner.total,
                self.inner.added,
                self.inner.skipped,
                &self.inner.failed,
            )
        });
    }
}

async fn run_batch(app: &AppHandle, batch: &ImportBatch) -> Result<()> {
    let state = app.state::<Arc<AppState>>().inner().clone();
    let batch_id = batch.batch_id.clone();

    let creds = state.credentials()?;
    state.batches.start(&batch_id).await;
    let _ = state
        .db
        .with(|conn| store::set_status(conn, &batch_id, "running", "fetching"));

    let mut p = Progress::new(app.clone(), batch);
    p.stage("fetching");

    let mut fresh: Vec<crate::model::Beatmap> = Vec::new();

    // ── наборы: один запрос на набор, отдаёт все сложности сразу
    for set_id in &batch.beatmapset_ids {
        if state.batches.is_cancelled(&batch_id).await {
            return abort_cancelled(app, &batch_id, &mut p).await;
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
    for chunk in batch.beatmap_ids.chunks(BATCH) {
        if state.batches.is_cancelled(&batch_id).await {
            return abort_cancelled(app, &batch_id, &mut p).await;
        }

        state.limiter.acquire_reserving(LOBBY_RESERVE).await;
        match state.osu.beatmaps(&creds, chunk).await {
            Ok(maps) => {
                // То, что osu! не вернул, — удалённые или закрытые карты.
                let got: Vec<i64> = maps.iter().map(|m| m.beatmap_id).collect();
                for missing in chunk.iter().filter(|id| !got.contains(id)) {
                    p.fail(format!("карта {missing}"), "на osu! не найдена".into());
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

    // ── скилсеты: считаются по атрибутам, а те приходят по запросу на карту.
    // До записи в базу — карты появятся в библиотеке уже со скилсетами.
    p.reset("skillsets", fresh.len() as i64);
    let mut attrs: HashMap<i64, crate::model::BeatmapAttributes> = HashMap::new();

    for map in &fresh {
        if state.batches.is_cancelled(&batch_id).await {
            return abort_cancelled(app, &batch_id, &mut p).await;
        }

        // Атрибуты без модов уже лежат в базе (карта раньше скачивалась) —
        // второй раз за ними в сеть ходить не надо.
        let cached = state
            .db
            .with(|conn| crate::db::beatmaps::has_attributes(conn, map.beatmap_id))
            .unwrap_or(false);

        if !cached {
            state.limiter.acquire_reserving(LOBBY_RESERVE).await;
            // Одна карта без атрибутов — не повод останавливать пачку:
            // скилсеты всегда можно проставить руками.
            if let Ok(a) = state.osu.attributes(&creds, map.beatmap_id, 0).await {
                attrs.insert(map.beatmap_id, a);
            }
        }

        p.advance(1, 0, 0);
    }

    // ── обложки: тоже до записи, библиотека получает карты разом и полными
    let mut sets: Vec<i64> = fresh.iter().filter_map(|m| m.beatmapset_id).collect();
    sets.sort_unstable();
    sets.dedup();

    p.reset("covers", sets.len() as i64);

    let mut cover_paths: HashMap<i64, String> = HashMap::new();

    for set_id in &sets {
        if state.batches.is_cancelled(&batch_id).await {
            return abort_cancelled(app, &batch_id, &mut p).await;
        }

        // Файл уже в кеше — качать нечего, но путь в карту прописать надо:
        // после удаления и повторного добавления строка в базе новая, а
        // обложка осталась с прошлого раза.
        if state.covers.has(*set_id) {
            let path = state.covers.path_for(*set_id).to_string_lossy().to_string();
            for m in fresh.iter().filter(|m| m.beatmapset_id == Some(*set_id)) {
                cover_paths.insert(m.beatmap_id, path.clone());
            }
            p.advance(1, 0, 0);
            continue;
        }

        // Обложки лежат на assets.ppy.sh без авторизации и в лимит API не входят.
        if let Ok(bytes) = state.osu.download_cover(*set_id).await {
            if let Ok(path) = state.covers.put(*set_id, &bytes) {
                let path = path.to_string_lossy().to_string();
                for m in fresh.iter().filter(|m| m.beatmapset_id == Some(*set_id)) {
                    cover_paths.insert(m.beatmap_id, path.clone());
                }
            }
        }
        p.advance(1, 0, 0);
    }

    // ── запись в базу одной транзакцией: карты появляются в библиотеке
    // разом и уже с тегами пачки, скилсетами и обложками
    p.stage("saving");

    let auto_mods = batch.mods.clone();
    let to_save = fresh.clone();
    let mut added = 0i64;
    let mut skipped = 0i64;
    let mut failed: Vec<ImportFailure> = Vec::new();

    state.db.with_tx(|tx| {
        for mut map in to_save {
            if let Some(path) = cover_paths.get(&map.beatmap_id) {
                map.cover_path = Some(path.clone());
            }
            // Авто-теги пачки: та самая «одна кнопка на 20 ссылок NM».
            for m in &auto_mods {
                if !map.mods.contains(m) {
                    map.mods.push(m.clone());
                }
            }
            match crate::db::beatmaps::upsert(tx, &map) {
                Ok(true) => added += 1,
                Ok(false) => skipped += 1,
                Err(e) => failed.push(ImportFailure {
                    reference: format!("карта {}", map.beatmap_id),
                    reason: e.to_string(),
                }),
            }
        }
        Ok(())
    })?;

    // Скилсеты и атрибуты, дособранные по дороге.
    state.db.with_tx(|tx| {
        for (id, attr) in &attrs {
            crate::db::beatmaps::put_attributes(tx, attr)?;
            if let Some(map) = fresh.iter().find(|m| m.beatmap_id == *id) {
                let guessed = crate::db::beatmaps::auto_skillsets(map, attr);
                crate::db::beatmaps::suggest_skillsets(tx, *id, &guessed)?;
            }
        }
        Ok(())
    })?;

    p.inner.added = added;
    p.inner.skipped = skipped;
    if !failed.is_empty() {
        p.inner.failed.extend(failed);
    }
    p.stage("done");

    let _ = state
        .db
        .with(|conn| store::set_status(conn, &batch_id, "done", "done"));
    state.batches.finish(&batch_id).await;
    Ok(())
}

/// Пачка отменилась посреди дела: счётчики остаются как есть, статус —
/// «отменено». Это конец `run_batch`, дальше очередь возьмёт следующую.
async fn abort_cancelled(app: &AppHandle, batch_id: &str, p: &mut Progress) -> Result<()> {
    p.stage("cancelled");
    let state = app.state::<Arc<AppState>>();
    let _ = state
        .db
        .with(|conn| store::set_status(conn, batch_id, "cancelled", "cancelled"));
    state.batches.finish(batch_id).await;
    Ok(())
}

/// Событие «список очереди изменился»: фронт перечитывает его целиком.
pub fn changed(app: &AppHandle) {
    let _ = app.emit("downloads:changed", ());
}

/// Повтор по тем картам, что не загрузились в прошлой пачке: отдельная
/// пачка без тегов — теги уже стояли на неудачных картах, повторять нечего.
#[allow(dead_code)]
pub fn retry_failed_maps(app: AppHandle, failed: Vec<i64>) -> Result<ImportBatch> {
    if failed.is_empty() {
        return Err(AppError::Other("Повторять нечего".into()));
    }
    enqueue(
        app,
        ParsedLinks {
            beatmap_ids: failed,
            beatmapset_ids: vec![],
            unknown: vec![],
        },
        vec![],
        "Повтор неудачных".into(),
    )
}
