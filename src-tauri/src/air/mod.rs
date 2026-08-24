//! Эфир: приложение пушит состояние, страница его рисует.
//!
//! Этот модуль — только транспорт. Ни одна сцена, ни один переход и ни одно
//! правило подбора сюда не попадают: их считает пульт, потому что все доменные
//! данные уже лежат на его стороне, а `payload` приходит собранным. Отсюда
//! следствие, ради которого так и сделано: новая сцена не требует правок в Rust.
//!
//! Разведено три вещи, каждая за своей границей:
//!
//! - [`hub`] — состояние и рассылка. Знает про задержку и про то, что видят зрители.
//! - [`server`] — локальный сервер: страница и WebSocket. От выбора туннеля не зависит.
//! - [`tunnel`] — как адрес становится доступным из интернета. Реализаций две,
//!   третья (свой релей) добавляется здесь же, не задевая ни сцен, ни состояния.
//!
//! [`lobby`] стоит отдельно: это источник данных, а не транспорт.

pub mod hub;
pub mod lobby;
pub mod server;
pub mod state;
pub mod tunnel;

use std::sync::Arc;

use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::error::{AppError, Result};
use crate::state::AppState;
use hub::AirHub;
use state::{AirState, AirStatus, LobbyStatus};
use tunnel::Transport;

/// Код доступа: без него WebSocket не открывается. Четыре знака — это не защита
/// от подбора, а защита от переброшенной дальше ссылки, и для своей тусовки этого
/// достаточно. Похожие друг на друга знаки выкинуты: код читают вслух.
const CODE_ALPHABET: &[u8] = b"ACDEFGHJKLMNPQRSTUVWXYZ23456789";

pub fn new_code() -> String {
    uuid::Uuid::new_v4()
        .as_bytes()
        .iter()
        .take(4)
        .map(|b| CODE_ALPHABET[*b as usize % CODE_ALPHABET.len()] as char)
        .collect()
}

/// Один эфир на приложение. Второй запуск занимает существующий: две трансляции
/// одного турнира с одной машины — это два расходящихся состояния.
#[derive(Default)]
pub struct AirSlot(Mutex<Option<Session>>);

pub struct Session {
    pub tournament_id: i64,
    pub hub: Arc<AirHub>,
    pub started_at: String,
    pub public_url: Option<String>,
    pub public_error: Option<String>,
    server: server::Running,
    tunnel: Option<tunnel::Running>,
    lobby: Option<lobby::Running>,
}

impl Session {
    /// Адрес для OBS и для себя. Код в ссылке, чтобы её можно было просто
    /// вставить в источник, ничего больше не вводя.
    pub fn local_url(&self, code: &str) -> String {
        format!("http://127.0.0.1:{}/?code={code}", self.server.port)
    }

    /// Тот же эфир с другой машины в доме. Публичная ссылка для этого не нужна.
    pub fn lan_url(&self, code: &str) -> Option<String> {
        server::lan_ip().map(|ip| format!("http://{ip}:{}/?code={code}", self.server.port))
    }
}

impl AirSlot {
    pub async fn status(&self) -> Result<AirStatus> {
        let guard = self.0.lock().await;
        let Some(session) = guard.as_ref() else {
            return Ok(offline());
        };
        let code = session.hub.code().await;
        Ok(AirStatus {
            live: true,
            tournament_id: Some(session.tournament_id),
            port: session.server.port,
            local_url: session.local_url(&code),
            lan_url: session.lan_url(&code),
            public_url: session.public_url.clone(),
            public_error: session.public_error.clone(),
            code,
            viewers: session.hub.viewers(),
            started_at: Some(session.started_at.clone()),
            delay: session.hub.delay_secs(),
            pending: session.hub.pending().await,
            aired: Some(session.hub.aired().await),
            lobby: session.lobby.as_ref().map(|l| LobbyStatus {
                match_id: l.match_id,
                room_id: l.room_id,
                polling: l.is_alive(),
            }),
        })
    }

    /// Поднимает эфир. Публичная ссылка необязательна: локальный режим —
    /// полноценный, для OBS туннель не нужен вовсе.
    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        &self,
        app: &AppHandle,
        state: Arc<AppState>,
        tournament_id: i64,
        tournament: String,
        transport: Transport,
        delay: i64,
        show_viewers: bool,
    ) -> Result<AirStatus> {
        let mut guard = self.0.lock().await;
        if guard.is_some() {
            return Err(AppError::Other(
                "Эфир уже идёт. Останови его, чтобы начать другой.".into(),
            ));
        }

        let started_at = crate::db::now_iso();
        let code = new_code();

        // Пока туннеля нет, эфир считается локальным: страница по этому полю
        // решает, можно ли играть свой видеофайл.
        let mut air = AirState::initial(tournament, started_at.clone(), delay, true);
        air.air.show_viewers = show_viewers;

        let hub = AirHub::new(air, code.clone(), delay);
        let server = server::start(app, hub.clone()).await?;

        // Туннель поднимаем после сервера: пробрасывать нечего, пока порт не занят.
        let (tunnel, public_url, public_error) = match transport {
            Transport::Local => (None, None, None),
            Transport::Cloudflared => match tunnel::find_binary(&state.data_dir) {
                None => (
                    None,
                    None,
                    Some(
                        "Нет cloudflared — эфир идёт локально. Проверь связь в настройках эфира."
                            .to_string(),
                    ),
                ),
                Some(binary) => match tunnel::start(&binary, server.port).await {
                    Ok(mut running) => {
                        // Ссылку показываем только после того, как по ней
                        // открылась страница эфира. Выданный адрес и работающий
                        // адрес — разные вещи: канал данных быстрого туннеля
                        // идёт по 7844 и на машине со своим VPN не проходит,
                        // а ссылка при этом выдаётся.
                        match tunnel::reachable(&state.osu.http, &running.url).await {
                            Ok(()) => {
                                let url = format!("{}/?code={code}", running.url);
                                (Some(running), Some(url), None)
                            }
                            Err(why) => {
                                running.stop();
                                (
                                    None,
                                    None,
                                    Some(format!(
                                        "Публичная ссылка поднялась, но снаружи не отвечает: \
                                         {why}. Эфир идёт локально — для OBS и для машин в доме \
                                         этого хватает."
                                    )),
                                )
                            }
                        }
                    }
                    // Туннель не поднялся — эфир от этого не встаёт: остаётся
                    // локальная ссылка, а повод виден в панели.
                    Err(e) => (None, None, Some(e.to_string())),
                },
            },
        };

        hub.set_shown_fields(show_viewers, public_url.is_none())
            .await;

        *guard = Some(Session {
            tournament_id,
            hub,
            started_at,
            public_url,
            public_error,
            server,
            tunnel,
            lobby: None,
        });
        drop(guard);

        self.status().await
    }

    pub async fn stop(&self) -> Result<AirStatus> {
        let mut guard = self.0.lock().await;
        if let Some(mut session) = guard.take() {
            // Сначала прощаемся со зрителями, потом гасим: иначе они получат
            // обрыв связи вместо «эфир окончен».
            session.hub.close("Эфир окончен").await;
            tokio::time::sleep(std::time::Duration::from_millis(120)).await;

            if let Some(lobby) = &session.lobby {
                lobby.stop();
            }
            if let Some(tunnel) = &mut session.tunnel {
                tunnel.stop();
            }
            session.server.stop();
        }
        drop(guard);
        self.status().await
    }

    /// Новый кадр. Стек слоёв целиком: обычно один слой, при врезке два.
    pub async fn scene(
        &self,
        layers: Vec<state::Layer>,
        theme: Option<serde_json::Value>,
    ) -> Result<()> {
        self.with(|s| {
            let hub = s.hub.clone();
            async move { hub.push_scene(layers, theme).await }
        })
        .await
    }

    pub async fn patch(&self, layer: String, payload: serde_json::Value) -> Result<()> {
        self.with(|s| {
            let hub = s.hub.clone();
            async move { hub.push_patch(layer, payload).await }
        })
        .await
    }

    pub async fn revert(&self) -> Result<bool> {
        let guard = self.0.lock().await;
        let Some(session) = guard.as_ref() else {
            return Ok(false);
        };
        Ok(session.hub.revert().await)
    }

    pub async fn set_delay(&self, secs: i64) -> Result<()> {
        self.with(|s| {
            let hub = s.hub.clone();
            async move { hub.set_delay(secs).await }
        })
        .await
    }

    pub async fn set_show_viewers(&self, value: bool) -> Result<()> {
        let guard = self.0.lock().await;
        let Some(session) = guard.as_ref() else {
            return Err(AppError::Other("Эфир не запущен".into()));
        };
        session
            .hub
            .set_shown_fields(value, session.public_url.is_none())
            .await;
        Ok(())
    }

    /// Меняет код. Все текущие зрители отключаются — их ссылка больше не работает.
    pub async fn set_code(&self) -> Result<AirStatus> {
        {
            let guard = self.0.lock().await;
            let Some(session) = guard.as_ref() else {
                return Err(AppError::Other("Эфир не запущен".into()));
            };
            session.hub.set_code(new_code()).await;
        }
        self.status().await
    }

    // ─────────────────────────────────────────────────────────────── лобби

    /// Поднимает опрос лобби. Опрос идёт, только пока матч идёт: между матчами
    /// он остановлен, иначе бюджет запросов уходит в пустоту.
    pub async fn lobby_start(
        &self,
        app: &AppHandle,
        state: Arc<AppState>,
        match_id: i64,
        room_id: i64,
    ) -> Result<()> {
        let mut guard = self.0.lock().await;
        let Some(session) = guard.as_mut() else {
            return Err(AppError::Other("Эфир не запущен".into()));
        };

        // Тот же матч и то же лобби — оставляем идущий опрос, а не поднимаем второй.
        if let Some(running) = &session.lobby {
            if running.match_id == match_id && running.room_id == room_id && running.is_alive() {
                return Ok(());
            }
            running.stop();
        }

        session.lobby = Some(lobby::start(app, state, match_id, room_id));
        Ok(())
    }

    pub async fn lobby_stop(&self) -> Result<()> {
        let mut guard = self.0.lock().await;
        let Some(session) = guard.as_mut() else {
            return Ok(());
        };
        if let Some(running) = &session.lobby {
            running.stop();
        }
        session.lobby = None;
        Ok(())
    }

    /// Общая обёртка: действие имеет смысл только при живом эфире.
    async fn with<F, Fut>(&self, work: F) -> Result<()>
    where
        F: FnOnce(&Session) -> Fut,
        Fut: std::future::Future<Output = ()>,
    {
        let guard = self.0.lock().await;
        let Some(session) = guard.as_ref() else {
            return Err(AppError::Other("Эфир не запущен".into()));
        };
        let fut = work(session);
        drop(guard);
        fut.await;
        Ok(())
    }
}

/// Эфир не запущен. Отдельная структура вместо `Option` в ответе: пульт рисует
/// один и тот же блок, а не два разных состояния.
fn offline() -> AirStatus {
    AirStatus {
        live: false,
        tournament_id: None,
        port: 0,
        local_url: String::new(),
        lan_url: None,
        public_url: None,
        public_error: None,
        code: String::new(),
        viewers: 0,
        started_at: None,
        delay: 0,
        pending: 0,
        aired: None,
        lobby: None,
    }
}
