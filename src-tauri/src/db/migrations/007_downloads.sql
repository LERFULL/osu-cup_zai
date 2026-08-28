-- Загрузки вместо «по ссылкам»: очередь пачек и память модов удалённых карт.
--
-- Здесь нет ALTER TABLE, поэтому выражение идемпотентно — но применяется
-- по версии, как и остальные миграции.

-- Пачка загрузки. Живёт в базе, поэтому очередь переживает перезапуск:
-- недокачанные пачки подхватываются при старте приложения.
CREATE TABLE IF NOT EXISTS import_batches (
  batch_id       TEXT PRIMARY KEY,
  name           TEXT NOT NULL DEFAULT '',
  mods           TEXT NOT NULL DEFAULT '[]',   -- JSON: авто-теги на все карты пачки
  status         TEXT NOT NULL DEFAULT 'queued', -- queued running done failed cancelled
  stage          TEXT NOT NULL DEFAULT 'queued',  -- queued fetching skillsets covers saving done
  beatmap_ids    TEXT NOT NULL DEFAULT '[]',   -- JSON: отдельные сложности
  beatmapset_ids TEXT NOT NULL DEFAULT '[]',   -- JSON: наборы (разворачиваются при загрузке)
  total          INTEGER NOT NULL DEFAULT 0,
  done           INTEGER NOT NULL DEFAULT 0,
  added          INTEGER NOT NULL DEFAULT 0,
  skipped        INTEGER NOT NULL DEFAULT 0,
  failed         TEXT NOT NULL DEFAULT '[]',   -- JSON [{ref, reason}]
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_import_batches_status ON import_batches(status);
CREATE INDEX IF NOT EXISTS ix_import_batches_created ON import_batches(created_at);

-- Моды удалённых карт. Таблица без внешнего ключа нарочно: строка карты
-- при удалении исчезает вместе с каскадом тегов, а эта память остаётся —
-- и при повторной загрузке той же карты теги возвращаются сами.
CREATE TABLE IF NOT EXISTS beatmap_remod (
  beatmap_id INTEGER PRIMARY KEY,
  mods       TEXT NOT NULL DEFAULT '[]',   -- JSON-массив мод-тегов
  fm_mods    TEXT NOT NULL DEFAULT '[]',   -- JSON-массив модов FM
  saved_at   TEXT NOT NULL
);

-- Расширенный профиль osu! для карточки игрока: уровень, оценки, счёты.
-- Отдельно от кеша эфира: форма шире, а живут они по-разному.
CREATE TABLE IF NOT EXISTS osu_user_cache (
  osu_user_id INTEGER PRIMARY KEY,
  json        TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);

-- Снимки профиля — не больше одного в день. По ним карточка показывает
-- прогресс: как менялись pp, ранг и точность со временем.
CREATE TABLE IF NOT EXISTS osu_snapshots (
  osu_user_id INTEGER NOT NULL,
  day         TEXT NOT NULL,              -- YYYY-MM-DD, один снимок в день
  pp          REAL,
  global_rank INTEGER,
  accuracy    REAL,
  play_count  INTEGER,
  PRIMARY KEY (osu_user_id, day)
);
