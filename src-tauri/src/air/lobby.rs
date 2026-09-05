//! Опрос мультиплеерного лобби osu!.
//!
//! Судья остаётся основным источником: баны, пики и победителя ставит он, и без
//! интернета матч идёт как раньше. Лобби добавляет к этому настоящие цифры —
//! очки, точность, комбо — и подсказывает, какая карта играется прямо сейчас.
//!
//! ## Ловушка курсора `?after=`
//!
//! Событие игры создаётся в момент **старта** карты. Когда карта заканчивается,
//! нового события не появляется: `end_time` и массив `scores` дописываются в то
//! же самое событие. А `?after=<id>` отдаёт только события со `id` строго больше
//! курсора. Значит наивное «запомнил `latest_event_id`, опрашиваю с него» даёт
//! опрос, который **никогда не покажет ни одного результата карты**.
//!
//! Поэтому курсор держится позади события той игры, результатов которой у нас
//! ещё нет, и сдвигается только после того, как скоры собраны.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::db::air::{LobbyGameSave, LobbyScoreSave};
use crate::osu::{MatchDto, MatchGameDto};
use crate::state::AppState;

/// Пока матч идёт — раз в 5 секунд. Это 12 запросов в минуту.
const POLL_EVERY: Duration = Duration::from_secs(5);

/// После серий неудач темп падает: за минуту связи не становится лучше,
/// а лимит запросов дороже.
const ERROR_EVERY: Duration = Duration::from_secs(30);

/// Сколько опросов подряд с ошибкой — повод сбавить темп.
const ERROR_STREAK: u32 = 4;

/// Одна карта из лобби в том виде, в каком её ждёт эфир.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LobbyGame {
    pub game_id: i64,
    pub beatmap_id: Option<i64>,
    pub beatmapset_id: Option<i64>,
    /// «Исполнитель — название [сложность]», если карта пришла вместе с игрой.
    pub title: Option<String>,
    pub start_time: Option<String>,
    /// `None` — карта играется прямо сейчас.
    pub end_time: Option<String>,
    pub mods: Vec<String>,
    /// Длина без учёта мода: пересчёт под мод делает страница той же формулой,
    /// что и карточка карты.
    pub total_length: Option<i64>,
    /// Пусто, пока карта не кончилась: живого счёта во время карты API не даёт.
    pub scores: Vec<LobbyScore>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LobbyScore {
    /// Сопоставление с игроком турнира идёт по нему: в лобби ник может быть другим.
    pub user_id: Option<i64>,
    pub total_score: i64,
    pub accuracy: Option<f64>,
    pub max_combo: Option<i64>,
    pub passed: bool,
    pub rank: Option<String>,
    pub mods: Vec<String>,
    pub great: Option<i64>,
    pub ok: Option<i64>,
    pub meh: Option<i64>,
    pub miss: Option<i64>,
}

/// Участник лобби. Нужен для крайнего случая «игрок зашёл под другим ником»:
/// сопоставление идёт по `user_id`, а ник из лобби показывается в пульте, чтобы
/// было видно, кого именно не удалось сопоставить.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LobbyUser {
    pub user_id: i64,
    pub username: Option<String>,
    pub avatar_url: Option<String>,
    pub country_code: Option<String>,
}

/// Что улетает на фронт после каждого опроса.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LobbyUpdate {
    /// Наш матч, а не лобби.
    pub match_id: i64,
    pub room_id: i64,
    /// Карта, которая играется прямо сейчас.
    pub current_game_id: Option<i64>,
    pub at: String,
    /// Только карты, про которые в этом ответе что-то было.
    pub games: Vec<LobbyGame>,
    /// Кто в лобби. Приходит вместе с матчем и стоит бесплатно.
    pub users: Vec<LobbyUser>,
    /// Лобби не читается. Опрос при этом продолжается: связь могла мигнуть.
    pub error: Option<String>,
}

/// Идущий опрос. Живёт, пока матч не кончится или пока эфир не остановят.
pub struct Running {
    pub match_id: i64,
    pub room_id: i64,
    alive: Arc<AtomicBool>,
}

impl Running {
    pub fn stop(&self) {
        self.alive.store(false, Ordering::SeqCst);
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

/// Курсор по событиям лобби.
///
/// Два числа вместо одного — ровно из-за ловушки: `high_water` растёт вместе с
/// `latest_event_id`, а `pending` держит событие игры, результатов которой ещё нет.
#[derive(Debug, Default, Clone, Copy)]
struct Cursor {
    high_water: Option<i64>,
    pending: Option<i64>,
}

impl Cursor {
    /// С каким `after` идти в следующий запрос.
    ///
    /// Пока есть незакрытая игра, курсор стоит **на единицу позади** её события:
    /// только так оно вернётся снова — уже со скорами.
    fn request(&self) -> Option<i64> {
        match self.pending {
            Some(event) => Some(event - 1),
            None => self.high_water,
        }
    }

    /// Учитывает ответ: двигает границу и запоминает незакрытую игру.
    fn absorb(&mut self, dto: &MatchDto, games: &[(i64, bool)]) {
        if let Some(latest) = dto.latest_event_id {
            self.high_water = Some(match self.high_water {
                Some(had) => had.max(latest),
                None => latest,
            });
        }

        // Незакрытой считаем игру, у которой нет конца или пусты скоры. Именно
        // «нет результата», а не «идёт по мнению API»: короткий промежуток между
        // концом карты и появлением скоров тоже нельзя проезжать курсором.
        self.pending = games
            .iter()
            .filter(|(_, complete)| !complete)
            .map(|(event, _)| *event)
            .min();
    }
}

/// Поднимает опрос лобби для матча. Возвращает управление сразу.
///
/// Опрос живёт, пока его не остановят явно: ошибки сети, лимита или
/// credentials не убивают его, а лишь сбавляют темп. Ключ от API пользователь
/// вправе починить посреди матча — и тогда цифры сами вернутся в эфир.
pub fn start(app: &AppHandle, state: Arc<AppState>, match_id: i64, room_id: i64) -> Running {
    let alive = Arc::new(AtomicBool::new(true));

    let app = app.clone();
    let flag = alive.clone();
    tokio::spawn(async move {
        let mut cursor = Cursor::default();
        let mut failures: u32 = 0;

        while flag.load(Ordering::SeqCst) {
            let creds = match state.credentials() {
                Ok(creds) => creds,
                Err(e) => {
                    // Ключ задан плохо или стёрся: останавливаться нельзя —
                    // пользователь может ввести его прямо посреди матча.
                    failures = failures.saturating_add(ERROR_STREAK);
                    emit(&app, fail(match_id, room_id, e.to_string()));
                    tokio::time::sleep(ERROR_EVERY).await;
                    continue;
                }
            };

            // Разрешение берём из общей очереди: лимит один на всё приложение.
            // Приоритет над импортом обеспечен с другой стороны — импорт
            // оставляет часть окна свободной (см. `RateLimiter::acquire_reserving`).
            state.limiter.acquire().await;

            match state
                .osu
                .match_state(&creds, room_id, cursor.request())
                .await
            {
                Ok(dto) => {
                    failures = 0;
                    let (games, flags) = collect(&dto);
                    cursor.absorb(&dto, &flags);

                    // Завершённые игры складываются в турнирный профиль.
                    // Считаем до emit: сам вектор `games` дальше уезжает в
                    // LobbyUpdate. Запись идемпотентна по номеру игры,
                    // повторные опросы того же события ничего не задвоят.
                    // Ошибка записи не роняет эфир: цифры на кадре важнее
                    // статистики.
                    let completed: Vec<LobbyGameSave> = games
                        .iter()
                        .filter(|g| g.end_time.is_some() && !g.scores.is_empty())
                        .map(to_save)
                        .collect();

                    emit(
                        &app,
                        LobbyUpdate {
                            match_id,
                            room_id,
                            current_game_id: dto.current_game_id,
                            at: crate::db::now_iso(),
                            games,
                            users: dto.users.iter().map(to_user).collect(),
                            error: None,
                        },
                    );

                    if !completed.is_empty() {
                        let _ = state.db.with(|conn| {
                            for game in &completed {
                                crate::db::air::save_lobby_game(conn, match_id, game)?;
                            }
                            Ok(())
                        });
                    }
                }
                Err(e) => {
                    // Связь могла мигнуть — опрос не бросаем, но говорим прямо.
                    failures += 1;
                    emit(&app, fail(match_id, room_id, e.to_string()));
                }
            }

            // Неудачи подряд сбавляют темп, удача возвращает обычный ритм.
            let pause = if failures >= ERROR_STREAK {
                ERROR_EVERY
            } else {
                POLL_EVERY
            };
            tokio::time::sleep(pause).await;
        }
    });

    Running {
        match_id,
        room_id,
        alive,
    }
}

fn fail(match_id: i64, room_id: i64, why: String) -> LobbyUpdate {
    LobbyUpdate {
        match_id,
        room_id,
        current_game_id: None,
        at: crate::db::now_iso(),
        games: Vec::new(),
        users: Vec::new(),
        error: Some(why),
    }
}

fn to_user(dto: &crate::osu::dto::MatchUserDto) -> LobbyUser {
    LobbyUser {
        user_id: dto.id,
        username: dto.username.clone(),
        avatar_url: dto.avatar_url.clone(),
        country_code: dto.country_code.clone(),
    }
}

fn to_save(game: &LobbyGame) -> LobbyGameSave {
    LobbyGameSave {
        game_id: game.game_id,
        beatmap_id: game.beatmap_id,
        beatmapset_id: game.beatmapset_id,
        title: game.title.clone(),
        start_time: game.start_time.clone(),
        end_time: game.end_time.clone(),
        mods: game.mods.clone(),
        total_length: game.total_length,
        scores: game
            .scores
            .iter()
            .map(|s| LobbyScoreSave {
                osu_user_id: s.user_id,
                total_score: s.total_score,
                accuracy: s.accuracy,
                max_combo: s.max_combo,
                passed: s.passed,
                rank: s.rank.clone(),
                mods: s.mods.clone(),
                great: s.great,
                ok: s.ok,
                meh: s.meh,
                miss: s.miss,
            })
            .collect(),
    }
}

fn emit(app: &AppHandle, update: LobbyUpdate) {
    let _ = app.emit("air:lobby", update);
}

/// Разбирает ответ: карты для эфира и пометки «результат собран» для курсора.
fn collect(dto: &MatchDto) -> (Vec<LobbyGame>, Vec<(i64, bool)>) {
    let mut games = Vec::new();
    let mut flags = Vec::new();

    for event in &dto.events {
        let Some(game) = &event.game else { continue };
        let complete = game.end_time.is_some() && !game.scores.is_empty();
        flags.push((event.id, complete));
        games.push(to_game(game));
    }

    (games, flags)
}

fn to_game(game: &MatchGameDto) -> LobbyGame {
    let map = game.beatmap.as_ref();
    LobbyGame {
        game_id: game.id,
        beatmap_id: game.beatmap_id.or_else(|| map.map(|m| m.id)),
        beatmapset_id: map.and_then(|m| m.beatmapset_id),
        title: map.map(|m| {
            let set = m.beatmapset.as_ref();
            let artist = set.map(|s| s.artist.as_str()).unwrap_or("");
            let title = set.map(|s| s.title.as_str()).unwrap_or("");
            format!("{artist} — {title} [{}]", m.version).trim().to_string()
        }),
        start_time: game.start_time.clone(),
        end_time: game.end_time.clone(),
        mods: game.mods.clone(),
        total_length: map.and_then(|m| m.total_length),
        scores: game
            .scores
            .iter()
            .map(|s| LobbyScore {
                user_id: s.user_id,
                total_score: s.total_score.unwrap_or(0),
                accuracy: s.accuracy,
                max_combo: s.max_combo,
                passed: s.passed.unwrap_or(false),
                rank: s.rank.clone(),
                mods: s.mods.clone(),
                great: s.statistics.as_ref().and_then(|x| x.great),
                ok: s.statistics.as_ref().and_then(|x| x.ok),
                meh: s.statistics.as_ref().and_then(|x| x.meh),
                miss: s.statistics.as_ref().and_then(|x| x.miss),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dto(json: &str) -> MatchDto {
        serde_json::from_str(json).expect("тестовый json валиден")
    }

    /// Ничего не происходит — курсор стоит на границе событий.
    #[test]
    fn idle_cursor_sits_on_latest() {
        let mut cursor = Cursor::default();
        let response = dto(r#"{"events": [], "latest_event_id": 40}"#);
        let (_, flags) = collect(&response);
        cursor.absorb(&response, &flags);
        assert_eq!(cursor.request(), Some(40));
    }

    /// Главная проверка: пока карта идёт, курсор стоит **позади** её события,
    /// иначе результат этой карты не вернётся никогда.
    #[test]
    fn running_game_holds_cursor_behind_its_event() {
        let mut cursor = Cursor::default();
        let response = dto(
            r#"{"latest_event_id": 51, "current_game_id": 900,
                "events": [{"id": 51, "game": {"id": 900, "beatmap_id": 7,
                            "start_time": "2026-08-16T03:51:44Z", "end_time": null,
                            "mods": ["HD"], "scores": []}}]}"#,
        );
        let (games, flags) = collect(&response);
        cursor.absorb(&response, &flags);

        assert_eq!(flags, vec![(51, false)]);
        assert_eq!(cursor.request(), Some(50), "курсор обязан отставать на единицу");
        assert_eq!(games.len(), 1);
        assert!(games[0].scores.is_empty(), "живого счёта во время карты нет");
        assert!(games[0].end_time.is_none());
    }

    /// Скоры дописались в то же событие — вот теперь курсор можно двигать.
    #[test]
    fn finished_game_releases_cursor() {
        let mut cursor = Cursor::default();
        let running = dto(
            r#"{"latest_event_id": 51, "current_game_id": 900,
                "events": [{"id": 51, "game": {"id": 900, "end_time": null, "scores": []}}]}"#,
        );
        let (_, flags) = collect(&running);
        cursor.absorb(&running, &flags);
        assert_eq!(cursor.request(), Some(50));

        let done = dto(
            r#"{"latest_event_id": 51, "current_game_id": null,
                "events": [{"id": 51, "game": {"id": 900, "beatmap_id": 7,
                            "end_time": "2026-08-16T03:53:30Z", "mods": [],
                            "scores": [{"user_id": 11, "total_score": 512340,
                                        "accuracy": 0.982, "max_combo": 740,
                                        "passed": true, "rank": "S", "mods": [],
                                        "statistics": {"great": 700, "ok": 12, "miss": 1}}]}}]}"#,
        );
        let (games, flags) = collect(&done);
        cursor.absorb(&done, &flags);

        assert_eq!(cursor.request(), Some(51), "результат собран — курсор свободен");
        let score = &games[0].scores[0];
        assert_eq!(score.total_score, 512_340);
        assert_eq!(score.max_combo, Some(740));
        assert_eq!(score.great, Some(700));
        assert!(score.passed);
    }

    /// Старое имя поля тоже читается: `score` вместо `total_score`.
    #[test]
    fn legacy_score_field_is_read() {
        let response = dto(
            r#"{"events": [{"id": 1, "game": {"id": 2, "end_time": "x",
                 "scores": [{"user_id": 5, "score": 4242, "passed": false}]}}]}"#,
        );
        let (games, _) = collect(&response);
        assert_eq!(games[0].scores[0].total_score, 4242);
        assert!(!games[0].scores[0].passed);
    }

    /// Двух незакрытых игр быть не должно, но если API прислал — держимся
    /// самой ранней: потерять результат хуже, чем перечитать лишнее.
    #[test]
    fn two_open_games_hold_earliest() {
        let mut cursor = Cursor::default();
        let response = dto(
            r#"{"latest_event_id": 60,
                "events": [{"id": 55, "game": {"id": 1, "end_time": null, "scores": []}},
                           {"id": 60, "game": {"id": 2, "end_time": null, "scores": []}}]}"#,
        );
        let (_, flags) = collect(&response);
        cursor.absorb(&response, &flags);
        assert_eq!(cursor.request(), Some(54));
    }
}
