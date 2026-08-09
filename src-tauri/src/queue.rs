//! Одна очередь на все обращения к osu! с ограничением 60 запросов в минуту.
//!
//! Потолок у API 1200/мин, но рекомендация peppy — держаться 60/мин, её и держим.
//! Очередь живёт в таблице fetch_queue, поэтому переживает перезапуск приложения.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::time::Instant;

/// Раздатчик разрешений: не больше `limit` штук за скользящее окно `window`.
pub struct RateLimiter {
    limit: usize,
    window: Duration,
    hits: Mutex<VecDeque<Instant>>,
}

impl RateLimiter {
    pub fn per_minute(limit: usize) -> Self {
        Self {
            limit,
            window: Duration::from_secs(60),
            hits: Mutex::new(VecDeque::with_capacity(limit)),
        }
    }

    /// Ждёт, пока в окне освободится место, и отмечает израсходованное разрешение.
    pub async fn acquire(&self) {
        loop {
            let wait = {
                let mut hits = self.hits.lock().await;
                let now = Instant::now();

                while let Some(&front) = hits.front() {
                    if now.duration_since(front) >= self.window {
                        hits.pop_front();
                    } else {
                        break;
                    }
                }

                if hits.len() < self.limit {
                    hits.push_back(now);
                    return;
                }

                // Место освободится, когда самый старый запрос выйдет из окна.
                match hits.front() {
                    Some(&front) => self.window - now.duration_since(front),
                    None => Duration::ZERO,
                }
            };

            tokio::time::sleep(wait + Duration::from_millis(20)).await;
        }
    }

    /// Сколько запросов можно сделать прямо сейчас, не упираясь в лимит.
    pub async fn budget(&self) -> i64 {
        let mut hits = self.hits.lock().await;
        let now = Instant::now();
        while let Some(&front) = hits.front() {
            if now.duration_since(front) >= self.window {
                hits.pop_front();
            } else {
                break;
            }
        }
        (self.limit - hits.len()) as i64
    }
}

/// Состояние текущей пачки: что качаем и не попросили ли отменить.
#[derive(Default)]
pub struct BatchRegistry {
    active: Mutex<Option<String>>,
    cancelled: Mutex<Vec<String>>,
}

impl BatchRegistry {
    pub async fn start(&self, batch_id: &str) {
        *self.active.lock().await = Some(batch_id.to_string());
    }

    pub async fn finish(&self, batch_id: &str) {
        let mut active = self.active.lock().await;
        if active.as_deref() == Some(batch_id) {
            *active = None;
        }
    }

    pub async fn active(&self) -> Option<String> {
        self.active.lock().await.clone()
    }

    pub async fn cancel(&self, batch_id: &str) {
        self.cancelled.lock().await.push(batch_id.to_string());
    }

    pub async fn is_cancelled(&self, batch_id: &str) -> bool {
        self.cancelled.lock().await.iter().any(|b| b == batch_id)
    }
}

/// Флаг «обработчик уже бежит», чтобы не поднять второй на ту же очередь.
#[derive(Clone, Default)]
pub struct RunnerGuard(Arc<AtomicBool>);

impl RunnerGuard {
    /// Возвращает true, если удалось занять место. Освобождать через `release`.
    pub fn take(&self) -> bool {
        self.0
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub fn release(&self) {
        self.0.store(false, Ordering::SeqCst);
    }

    pub fn is_running(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Событие прогресса летит на фронт неблокирующей плашкой.
pub fn emit_progress(app: &AppHandle, progress: &crate::model::ImportProgress) {
    let _ = app.emit("import:progress", progress);
}

pub fn emit_queue(app: &AppHandle, status: &crate::model::QueueStatus) {
    let _ = app.emit("queue:status", status);
}

pub fn emit_cover(app: &AppHandle, beatmap_id: i64) {
    let _ = app.emit("cover:ready", beatmap_id);
}
