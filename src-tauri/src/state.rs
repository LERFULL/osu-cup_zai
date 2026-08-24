//! Общее состояние приложения, доступное всем командам через tauri::State.

use std::path::PathBuf;

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

        Ok(Self {
            db,
            cfg: ConfigStore::load(&data_dir.join("config.json")),
            osu: OsuClient::new(),
            covers: CoverCache::new(&data_dir),
            limiter: RateLimiter::per_minute(60),
            batches: BatchRegistry::default(),
            runner: RunnerGuard::default(),
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
