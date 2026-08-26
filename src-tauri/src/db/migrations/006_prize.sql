-- Призовой фонд: конфиг в турнире, флаг новичка у участника и общие
-- значения приложения, к которым относится переходящий джекпот.

ALTER TABLE tournaments ADD COLUMN prize TEXT;
ALTER TABLE tournament_players ADD COLUMN is_rookie INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS app_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
