//! Эфир: приложение пушит состояние, страница его рисует.
//!
//! Этот модуль — только транспорт. Ни одна сцена, ни один переход и ни одно
//! правило подбора сюда не попадают: их считает пульт, потому что все доменные
//! данные уже лежат на его стороне, а `payload` приходит собранным. Отсюда
//! следствие, ради которого так и сделано: новая сцена не требует правок в Rust.
//!
//! Разведено две вещи, каждая за своей границей:
//!
//! - [`hub`] — состояние и рассылка. Знает про задержку и про то, что видят зрители.
//! - [`server`] — локальный сервер: страница и WebSocket. Слушает только петлю.
//!
//! Наружу интернета эфир не выходит вовсе: страницу открывает OBS на этой же
//! машине, а к зрителям она попадает уже видеопотоком. Быстрый туннель отсюда
//! убран — на машине с перехватывающим прокси канал данных Cloudflare не
//! проходит ни по QUIC, ни по TCP, а ссылка при этом выдаётся.
//!
//! [`lobby`] стоит отдельно: это источник данных, а не транспорт.

pub mod hub;
pub mod lobby;
pub mod server;
pub mod state;

use std::sync::Arc;

use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::error::{AppError, Result};
use crate::state::AppState;
use hub::AirHub;
use state::{AirState, AirStatus, LobbyStatus};

/// Один эфир на приложение. Второй запуск занимает существующий: две трансляции
/// одного турнира с одной машины — это два расходящихся состояния.
#[derive(Default)]
pub struct AirSlot(Mutex<Option<Session>>);

pub struct Session {
    pub tournament_id: i64,
    pub hub: Arc<AirHub>,
    pub started_at: String,
    server: server::Running,
    lobby: Option<lobby::Running>,
}

impl Session {
    /// Адрес для OBS. Он же единственный: сервер слушает только петлю.
    pub fn local_url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.server.port)
    }
}

impl AirSlot {
    pub async fn status(&self) -> Result<AirStatus> {
        let guard = self.0.lock().await;
        let Some(session) = guard.as_ref() else {
            return Ok(offline());
        };
        Ok(AirStatus {
            live: true,
            tournament_id: Some(session.tournament_id),
            port: session.server.port,
            local_url: session.local_url(),
            started_at: Some(session.started_at.clone()),
            aired: Some(session.hub.aired().await),
            lobby: session.lobby.as_ref().map(|l| LobbyStatus {
                match_id: l.match_id,
                room_id: l.room_id,
                polling: l.is_alive(),
            }),
        })
    }

    /// Поднимает эфир.
    pub async fn start(
        &self,
        app: &AppHandle,
        tournament_id: i64,
        tournament: String,
    ) -> Result<AirStatus> {
        let mut guard = self.0.lock().await;
        if guard.is_some() {
            return Err(AppError::Other(
                "Эфир уже идёт. Останови его, чтобы начать другой.".into(),
            ));
        }

        let started_at = crate::db::now_iso();
        let air = AirState::initial(tournament, started_at.clone());
        let hub = AirHub::new(air);
        let server = server::start(app, hub.clone()).await?;

        *guard = Some(Session {
            tournament_id,
            hub,
            started_at,
            server,
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
        started_at: None,
        aired: None,
        lobby: None,
    }
}
