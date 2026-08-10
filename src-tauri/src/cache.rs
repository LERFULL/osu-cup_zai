//! Кеш обложек на диске.
//!
//! Обложки берутся с assets.ppy.sh без авторизации и лежат по одному файлу на набор:
//! у всех сложностей набора обложка общая, качать её по разу на каждую сложность незачем.

use std::path::{Path, PathBuf};

use crate::error::Result;

pub struct CoverCache {
    dir: PathBuf,
}

impl CoverCache {
    pub fn new(dir: &Path) -> Self {
        let dir = dir.join("covers");
        let _ = std::fs::create_dir_all(&dir);
        Self { dir }
    }

    pub fn path_for(&self, set_id: i64) -> PathBuf {
        // Раскладываем по подпапкам сотнями: тысячи файлов в одной папке
        // заметно тормозят на Windows.
        let bucket = format!("{:03}", set_id.unsigned_abs() % 1000);
        self.dir.join(bucket).join(format!("{set_id}.jpg"))
    }

    /// Аватары игроков. Их немного, поэтому лежат одной папкой рядом
    /// с обложками, а не раскладываются по корзинам.
    pub fn avatar_path(&self, user_id: i64) -> PathBuf {
        self.dir.join("avatars").join(format!("{user_id}.jpg"))
    }

    pub fn put_avatar(&self, user_id: i64, bytes: &[u8]) -> Result<PathBuf> {
        let path = self.avatar_path(user_id);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("part");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, &path)?;
        Ok(path)
    }

    /// Сколько дней аватару. `None` — файла нет.
    ///
    /// Аватар в профиле меняют когда угодно, поэтому раз в несколько дней
    /// его стоит перекачать; чаще — незачем гонять сеть на каждый показ.
    pub fn avatar_age_days(&self, user_id: i64) -> Option<u64> {
        let meta = std::fs::metadata(self.avatar_path(user_id)).ok()?;
        let modified = meta.modified().ok()?;
        let age = std::time::SystemTime::now()
            .duration_since(modified)
            .ok()?;
        Some(age.as_secs() / 86_400)
    }

    pub fn has(&self, set_id: i64) -> bool {
        self.path_for(set_id).is_file()
    }

    pub fn put(&self, set_id: i64, bytes: &[u8]) -> Result<PathBuf> {
        let path = self.path_for(set_id);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("part");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, &path)?;
        Ok(path)
    }

    /// Размер кеша в байтах. Считается обходом — вызывать по кнопке, не на каждом кадре.
    pub fn size(&self) -> u64 {
        fn walk(dir: &Path) -> u64 {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return 0;
            };
            entries
                .flatten()
                .map(|e| match e.file_type() {
                    Ok(t) if t.is_dir() => walk(&e.path()),
                    Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
                    Err(_) => 0,
                })
                .sum()
        }
        walk(&self.dir)
    }

    pub fn clear(&self) -> Result<()> {
        if self.dir.exists() {
            std::fs::remove_dir_all(&self.dir)?;
        }
        std::fs::create_dir_all(&self.dir)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_cover_is_found_again_by_the_same_id() {
        // Карту удалили и залили заново: файл в кеше остался, и импорт
        // должен взять путь отсюда, а не считать, что обложки нет.
        let dir = std::env::temp_dir().join(format!("osu-cup-cache-{}", std::process::id()));
        let cache = CoverCache::new(&dir);

        assert!(!cache.has(4242));
        let path = cache.put(4242, b"jpeg").unwrap();

        assert!(cache.has(4242));
        assert_eq!(cache.path_for(4242), path);
        assert!(path.is_file(), "обложка должна лежать на диске");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
