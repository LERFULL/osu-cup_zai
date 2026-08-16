-- Редактор турниров: правка живого турнира вместо трёх полей черновика.
--
-- Здесь есть ALTER TABLE, поэтому выражение не идемпотентно: применяется
-- ровно один раз по версии, как и миграция серий.

-- Какой маппул закреплён за раундом. Ключ — «upper:2», «lower:1», «grand:1»:
-- у верхней и нижней сетки свои раунды, и одним номером их не разделить.
-- Раунд без записи берёт маппул по общему правилу — по кругу.
ALTER TABLE tournaments ADD COLUMN pool_by_round TEXT;

-- Преимущество сетки: сколько побед победитель верхней получает в гранд-финале
-- заранее. 0 — выключено.
ALTER TABLE tournaments ADD COLUMN grand_advantage INTEGER NOT NULL DEFAULT 0;

-- Сеяния, прошедшие первый раунд без игры. Считается при построении,
-- хранится для проверки правок: после старта состав мог измениться.
ALTER TABLE tournaments ADD COLUMN bye_seeds TEXT;

-- Правило берётся на старте матча и внутри матча не меняется: иначе правка
-- целевого счёта посреди игры переписала бы уже сыгранное. NULL — матч ещё
-- не начинали, правило берётся из турнира.
ALTER TABLE matches ADD COLUMN target_score INTEGER;
ALTER TABLE matches ADD COLUMN bans_each    INTEGER;

-- Журнал правок турнира. Не то же самое, что журнал действий матча: действия
-- описывают ход игры, правки — вмешательство в турнир, и смешивать их нельзя.
--
-- payload держит снимок состояния до правки: по нему работает отмена. Хранить
-- обратную операцию на каждый вид правки — двенадцать способов ошибиться,
-- а снимок один и тот же для всех.
CREATE TABLE IF NOT EXISTS tournament_edits (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  n             INTEGER NOT NULL,          -- от 1 без пропусков, как действия матча
  kind          TEXT NOT NULL,
  at            TEXT NOT NULL,
  emergency     INTEGER NOT NULL DEFAULT 0,
  payload       TEXT NOT NULL DEFAULT '{}',
  undone_by     INTEGER,                   -- n правки-отмены, если её откатили
  PRIMARY KEY (tournament_id, n)
);
