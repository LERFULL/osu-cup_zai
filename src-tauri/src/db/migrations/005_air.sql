-- Эфир: настройки, счётчик показов сцен и ссылка на лобби матча.
--
-- Здесь есть ALTER TABLE, поэтому выражение не идемпотентно: применяется
-- ровно один раз по версии, как миграции серий и редактора.

-- Сколько раз сцена уже выходила в эфир. Живёт вместе с турниром, а не с
-- сессией эфира: перезапустили эфир — заготовки не обнулились, и маппул-шоукейс
-- не показывается второй раз только потому, что приложение перезапускали.
--
-- object_key — для сцен «по объекту»: карточка одного игрока не мешает показать
-- карточку другого, поэтому учёт идёт по игроку, а не по id сцены. Пустая
-- строка вместо NULL, потому что NULL в первичном ключе не сравнивается.
CREATE TABLE IF NOT EXISTS air_shows (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  scene_id      TEXT NOT NULL,
  object_key    TEXT NOT NULL DEFAULT '',
  shows         INTEGER NOT NULL DEFAULT 0,
  last_at       TEXT,
  PRIMARY KEY (tournament_id, scene_id, object_key)
);

-- Настройки эфира этого турнира: режим, включённые заготовки, ожидаемая пауза,
-- задержка. Лежат одной строкой JSON, как фильтр умной коллекции: форму знает
-- пульт, и держать её вторым описанием на стороне Rust незачем — Rust в эти
-- настройки не смотрит.
CREATE TABLE IF NOT EXISTS air_config (
  tournament_id INTEGER PRIMARY KEY REFERENCES tournaments(id) ON DELETE CASCADE,
  json          TEXT NOT NULL DEFAULT '{}',
  updated_at    TEXT NOT NULL
);

-- Номер мультиплеерного лобби. Вводится один раз при старте матча и не
-- обязателен: без него матч идёт по данным судьи, а эфир показывает счёт
-- по картам без цифр.
ALTER TABLE matches ADD COLUMN lobby_id INTEGER;

-- Профили osu! для сцен с цифрами: pp, ранги, точность. Тянутся по одному разу
-- на игрока и живут сутки — за эфир они не меняются, а бюджет запросов один на
-- всё приложение. Ответ храним как есть: форму знают сцены, а не база.
CREATE TABLE IF NOT EXISTS osu_profiles (
  osu_user_id INTEGER PRIMARY KEY,
  json        TEXT NOT NULL,
  fetched_at  TEXT NOT NULL
);
