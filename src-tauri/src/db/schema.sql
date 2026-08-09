-- osu!cup — схема локальной базы.
-- Версия схемы хранится в user_version, миграции применяются по возрастанию.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────────────── карты

CREATE TABLE IF NOT EXISTS beatmaps (
  beatmap_id        INTEGER PRIMARY KEY,
  beatmapset_id     INTEGER,
  checksum          TEXT,

  artist            TEXT NOT NULL DEFAULT '',
  artist_unicode    TEXT,
  title             TEXT NOT NULL DEFAULT '',
  title_unicode     TEXT,
  version           TEXT NOT NULL DEFAULT '',
  creator           TEXT,
  creator_id        INTEGER,

  difficulty_rating REAL NOT NULL DEFAULT 0,
  bpm               REAL,
  total_length      INTEGER,
  hit_length        INTEGER,
  cs                REAL,
  ar                REAL,
  accuracy          REAL,
  drain             REAL,
  count_circles     INTEGER,
  count_sliders     INTEGER,
  count_spinners    INTEGER,
  max_combo         INTEGER,

  status            TEXT,
  ranked_date       TEXT,
  last_updated      TEXT,
  tags              TEXT,
  pack_tags         TEXT,
  genre_id          INTEGER,
  language_id       INTEGER,
  failtimes         TEXT,

  cover_path        TEXT,
  preview_path      TEXT,

  note              TEXT,
  is_manual         INTEGER NOT NULL DEFAULT 0,
  is_gone           INTEGER NOT NULL DEFAULT 0,
  added_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_beatmaps_set    ON beatmaps(beatmapset_id);
CREATE INDEX IF NOT EXISTS ix_beatmaps_stars  ON beatmaps(difficulty_rating);
CREATE INDEX IF NOT EXISTS ix_beatmaps_bpm    ON beatmaps(bpm);
CREATE INDEX IF NOT EXISTS ix_beatmaps_len    ON beatmaps(total_length);
CREATE INDEX IF NOT EXISTS ix_beatmaps_added  ON beatmaps(added_at);
CREATE INDEX IF NOT EXISTS ix_beatmaps_status ON beatmaps(status);

-- Поиск по названию, артисту, мапперу и сложности.
CREATE VIRTUAL TABLE IF NOT EXISTS beatmaps_fts USING fts5(
  artist, title, version, creator,
  content = 'beatmaps',
  content_rowid = 'beatmap_id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS beatmaps_ai AFTER INSERT ON beatmaps BEGIN
  INSERT INTO beatmaps_fts(rowid, artist, title, version, creator)
  VALUES (new.beatmap_id, new.artist, new.title, new.version, new.creator);
END;
CREATE TRIGGER IF NOT EXISTS beatmaps_ad AFTER DELETE ON beatmaps BEGIN
  INSERT INTO beatmaps_fts(beatmaps_fts, rowid, artist, title, version, creator)
  VALUES ('delete', old.beatmap_id, old.artist, old.title, old.version, old.creator);
END;
CREATE TRIGGER IF NOT EXISTS beatmaps_au AFTER UPDATE ON beatmaps BEGIN
  INSERT INTO beatmaps_fts(beatmaps_fts, rowid, artist, title, version, creator)
  VALUES ('delete', old.beatmap_id, old.artist, old.title, old.version, old.creator);
  INSERT INTO beatmaps_fts(rowid, artist, title, version, creator)
  VALUES (new.beatmap_id, new.artist, new.title, new.version, new.creator);
END;

-- Мод-теги: в каких слот-ролях карте разрешено играть.
CREATE TABLE IF NOT EXISTS beatmap_mods (
  beatmap_id INTEGER NOT NULL REFERENCES beatmaps(beatmap_id) ON DELETE CASCADE,
  mod        TEXT NOT NULL,           -- NM HD HR DT FM EZ TB
  PRIMARY KEY (beatmap_id, mod)
);
CREATE INDEX IF NOT EXISTS ix_bmods_mod ON beatmap_mods(mod);

-- Для FM: какие конкретно моды разрешены на этой карте.
CREATE TABLE IF NOT EXISTS beatmap_fm_mods (
  beatmap_id INTEGER NOT NULL REFERENCES beatmaps(beatmap_id) ON DELETE CASCADE,
  mod        TEXT NOT NULL,
  PRIMARY KEY (beatmap_id, mod)
);

CREATE TABLE IF NOT EXISTS beatmap_skillsets (
  beatmap_id INTEGER NOT NULL REFERENCES beatmaps(beatmap_id) ON DELETE CASCADE,
  skillset   TEXT NOT NULL,
  suggested  INTEGER NOT NULL DEFAULT 0,   -- 1 = проставлено автоматически
  PRIMARY KEY (beatmap_id, skillset)
);
CREATE INDEX IF NOT EXISTS ix_bskill_skill ON beatmap_skillsets(skillset);

CREATE TABLE IF NOT EXISTS labels (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE IF NOT EXISTS beatmap_labels (
  beatmap_id INTEGER NOT NULL REFERENCES beatmaps(beatmap_id) ON DELETE CASCADE,
  label_id   INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (beatmap_id, label_id)
);

-- Кеш звёзд и атрибутов под конкретной комбинацией модов. mods='' = NoMod.
CREATE TABLE IF NOT EXISTS beatmap_attributes (
  beatmap_id       INTEGER NOT NULL REFERENCES beatmaps(beatmap_id) ON DELETE CASCADE,
  mods             TEXT NOT NULL,
  star_rating      REAL,
  aim_difficulty   REAL,
  speed_difficulty REAL,
  slider_factor    REAL,
  speed_note_count REAL,
  max_combo        INTEGER,
  fetched_at       TEXT NOT NULL,
  PRIMARY KEY (beatmap_id, mods)
);

-- ──────────────────────────────────────────────────────── коллекции

CREATE TABLE IF NOT EXISTS folders (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collections (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  color     TEXT,
  icon      TEXT,
  folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  position  INTEGER NOT NULL DEFAULT 0,
  is_smart  INTEGER NOT NULL DEFAULT 0,
  filter    TEXT,                       -- JSON состояния фильтра, только для умных
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_collections_folder ON collections(folder_id);

CREATE TABLE IF NOT EXISTS collection_beatmaps (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  beatmap_id    INTEGER NOT NULL REFERENCES beatmaps(beatmap_id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, beatmap_id)
);
CREATE INDEX IF NOT EXISTS ix_colbm_beatmap ON collection_beatmaps(beatmap_id);

-- ───────────────────────────────────────── шаблоны маппулов и маппулы

CREATE TABLE IF NOT EXISTS pool_templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  rules      TEXT NOT NULL DEFAULT '{}',   -- JSON правил генерации
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS template_slots (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id          INTEGER NOT NULL REFERENCES pool_templates(id) ON DELETE CASCADE,
  mod                  TEXT NOT NULL,
  count                INTEGER NOT NULL DEFAULT 1,
  star_min             REAL,
  star_max             REAL,
  source_collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  required_skillsets   TEXT,                -- JSON-массив
  position             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_tslots_template ON template_slots(template_id);

CREATE TABLE IF NOT EXISTS pools (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  template_id    INTEGER REFERENCES pool_templates(id) ON DELETE SET NULL,
  folder_id      INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'draft',   -- draft ready archived
  version        INTEGER NOT NULL DEFAULT 1,
  parent_pool_id INTEGER REFERENCES pools(id) ON DELETE SET NULL,
  display_fields TEXT,                             -- JSON: что показывать в строке
  is_locked      INTEGER NOT NULL DEFAULT 0,       -- сыгран, менять нельзя
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pool_slots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id               INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  slot_label            TEXT NOT NULL,             -- NM1 DT2 TB
  mod                   TEXT NOT NULL,
  beatmap_id            INTEGER REFERENCES beatmaps(beatmap_id) ON DELETE SET NULL,
  pinned                INTEGER NOT NULL DEFAULT 0,
  star_rating_with_mods REAL,
  fm_mods               TEXT,                      -- JSON-массив
  position              INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_pslots_pool ON pool_slots(pool_id);
CREATE INDEX IF NOT EXISTS ix_pslots_beatmap ON pool_slots(beatmap_id);

-- ──────────────────────────────────────────────────────────── игроки

CREATE TABLE IF NOT EXISTS players (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname    TEXT NOT NULL,
  osu_user_id INTEGER,
  color       TEXT NOT NULL,
  avatar_path TEXT,
  note        TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_players_nick ON players(nickname);

-- ─────────────────────────────────────────────────────────── турниры

CREATE TABLE IF NOT EXISTS tournaments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft',   -- draft running finished
  bracket_size   INTEGER NOT NULL,
  target_score   TEXT NOT NULL DEFAULT '{}',      -- JSON: общий или по раундам
  bans_per_round TEXT NOT NULL DEFAULT '{}',      -- JSON
  first_ban      TEXT NOT NULL DEFAULT 'random',
  no_repeat_pool INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  finished_at    TEXT
);

CREATE TABLE IF NOT EXISTS tournament_pools (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  pool_id       INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tournament_id, pool_id)
);

CREATE TABLE IF NOT EXISTS tournament_players (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  seed          INTEGER,
  color         TEXT NOT NULL,          -- цвет в рамках этого турнира
  placement     INTEGER,
  PRIMARY KEY (tournament_id, player_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id   INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  bracket         TEXT NOT NULL,        -- upper lower grand
  round           INTEGER NOT NULL,
  slot_in_bracket INTEGER NOT NULL,
  player_a        INTEGER REFERENCES players(id) ON DELETE SET NULL,
  player_b        INTEGER REFERENCES players(id) ON DELETE SET NULL,
  pool_id         INTEGER REFERENCES pools(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending running finished
  winner_id       INTEGER REFERENCES players(id) ON DELETE SET NULL,
  is_walkover     INTEGER NOT NULL DEFAULT 0,
  is_manual_edit  INTEGER NOT NULL DEFAULT 0,
  first_ban_by    INTEGER REFERENCES players(id) ON DELETE SET NULL,
  next_win_slot   INTEGER REFERENCES matches(id) ON DELETE SET NULL,
  next_lose_slot  INTEGER REFERENCES matches(id) ON DELETE SET NULL,
  started_at      TEXT,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS ix_matches_tournament ON matches(tournament_id);

-- Действия — единственный источник правды о состоянии матча.
-- Счёт и чей ход вычисляются из них, а не хранятся.
CREATE TABLE IF NOT EXISTS match_actions (
  match_id   INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  n          INTEGER NOT NULL,          -- от 1 без пропусков
  type       TEXT NOT NULL,             -- ban pick result
  actor_id   INTEGER REFERENCES players(id) ON DELETE SET NULL,
  slot_label TEXT NOT NULL,
  winner_id  INTEGER REFERENCES players(id) ON DELETE SET NULL,
  source     TEXT NOT NULL DEFAULT 'manual',
  at         TEXT NOT NULL,
  PRIMARY KEY (match_id, n)
);

-- ─────────────────────────────────────────────────── служебное

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Очередь запросов к osu!, переживающая перезапуск приложения.
CREATE TABLE IF NOT EXISTS fetch_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,             -- beatmap beatmapset attributes
  payload    TEXT NOT NULL,             -- JSON
  status     TEXT NOT NULL DEFAULT 'pending',  -- pending done failed
  error      TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_queue_status ON fetch_queue(status);
CREATE INDEX IF NOT EXISTS ix_queue_batch  ON fetch_queue(batch_id);

