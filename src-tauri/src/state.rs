//! Общее состояние приложения, доступное всем командам через tauri::State.

use std::path::PathBuf;

use tokio::sync::Notify;

use crate::air::AirSlot;
use crate::cache::CoverCache;
use crate::config::ConfigStore;
use crate::db::Db;
use crate::error::{AppError, Result};
use crate::model::ApiCredentials;
use crate::osu::client::OsuClient;
use crate::queue::{BatchRegistry, RateLimiter, RunnerGuard};

pub struct AppState {
    pub db: Db,
    pub cfg: ConfigStore,
    pub osu: OsuClient,
    pub covers: CoverCache,
    pub limiter: RateLimiter,
    pub batches: BatchRegistry,
    pub runner: RunnerGuard,
    /// Пробуждение обработчика очереди загрузок: enqueue дёргает его вместо
    /// того, чтобы гадать, спит обработчик или уже закончился.
    pub queue_notify: Notify,
    /// Идущий эфир. Один на приложение: две трансляции одного турнира с одной
    /// машины — это два расходящихся состояния.
    pub air: AirSlot,
    pub db_path: PathBuf,
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&data_dir)?;

        let db_path = data_dir.join("osucup.sqlite");
        let db = Db::open(&db_path)?;
        db.migrate()?;

        // Счётчик запусков и автобэкап — до первого обращения экранов:
        // копия должна успеть случиться, даже если дальше что-то сломается.
        autobackup(&db, &data_dir, &db_path);

        Ok(Self {
            db,
            cfg: ConfigStore::load(&data_dir.join("config.json")),
            osu: OsuClient::new(),
            covers: CoverCache::new(&data_dir),
            limiter: RateLimiter::per_minute(60),
            batches: BatchRegistry::default(),
            runner: RunnerGuard::default(),
            queue_notify: Notify::new(),
            air: AirSlot::default(),
            db_path,
            data_dir,
        })
    }

    /// Ключ или понятная ошибка «введи ключ в настройках».
    pub fn credentials(&self) -> Result<ApiCredentials> {
        self.cfg.credentials().ok_or(AppError::NoCredentials)
    }
}

/// Автобэкап раз в N запусков: счётчик живёт в самой базе (app_kv), копия —
/// в папке backups рядом с ней. Ошибка копии не должна мешать запуску
/// приложения, поэтому результат здесь глотается.
fn autobackup(db: &Db, data_dir: &std::path::Path, db_path: &std::path::Path) {
    let _ = db.with(|conn| {
        let every = crate::db::prize::kv_get_i64(conn, "backupEvery", 0);
        let runs = crate::db::prize::kv_get_i64(conn, "runCount", 0) + 1;
        crate::db::prize::kv_set_i64(conn, "runCount", runs)?;
        if every > 0 && runs % every == 0 {
            crate::db::history::backup_database(conn, data_dir, db_path)?;
        }
        Ok(())
    });
}
