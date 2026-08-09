//! Конфиг приложения: ключ osu! и флаг пройденного первого запуска.
//!
//! Лежит отдельным файлом рядом с базой, а не в самой базе — чтобы экспорт базы
//! между компьютерами не таскал за собой чужой секрет.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::model::ApiCredentials;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppConfig {
    pub client_id: String,
    pub client_secret: String,
    pub onboarded: bool,
}

impl AppConfig {
    pub fn credentials(&self) -> Option<ApiCredentials> {
        if self.client_id.trim().is_empty() || self.client_secret.trim().is_empty() {
            return None;
        }
        Some(ApiCredentials {
            client_id: self.client_id.trim().to_string(),
            client_secret: self.client_secret.trim().to_string(),
        })
    }
}

pub struct ConfigStore {
    path: PathBuf,
    inner: Mutex<AppConfig>,
}

impl ConfigStore {
    /// Читает конфиг с диска. Испорченный или отсутствующий файл — не ошибка,
    /// приложение просто стартует как при первом запуске.
    pub fn load(path: &Path) -> Self {
        let inner = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<AppConfig>(&s).ok())
            .unwrap_or_default();

        Self {
            path: path.to_path_buf(),
            inner: Mutex::new(inner),
        }
    }

    pub fn get(&self) -> AppConfig {
        self.inner.lock().map(|c| c.clone()).unwrap_or_default()
    }

    pub fn credentials(&self) -> Option<ApiCredentials> {
        self.get().credentials()
    }

    pub fn set_credentials(&self, creds: &ApiCredentials) -> Result<()> {
        self.update(|c| {
            c.client_id = creds.client_id.trim().to_string();
            c.client_secret = creds.client_secret.trim().to_string();
        })
    }

    pub fn clear_credentials(&self) -> Result<()> {
        self.update(|c| {
            c.client_id.clear();
            c.client_secret.clear();
        })
    }

    pub fn set_onboarded(&self, value: bool) -> Result<()> {
        self.update(|c| c.onboarded = value)
    }

    fn update(&self, f: impl FnOnce(&mut AppConfig)) -> Result<()> {
        let snapshot = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| crate::error::AppError::Other("Конфиг занят".into()))?;
            f(&mut guard);
            guard.clone()
        };
        self.write(&snapshot)
    }

    /// Пишем через временный файл и переименование, чтобы обрыв записи
    /// не оставил половину конфига.
    fn write(&self, cfg: &AppConfig) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(cfg)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}
