-- Турнирная статистика из лобби osu!.
--
-- Пока матч привязан к лобби, поллер читает события и складывает сюда каждую
-- завершённую игру со скорами игроков. Судья остаётся единственным источником
-- результатов матча — эти таблицы живут для турнирного профиля игрока, а не
-- для счёта на сетке.

CREATE TABLE lobby_games (
    id INTEGER PRIMARY KEY,
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    -- Номер игры в лобби osu!: он же защита от двойной записи.
    game_id INTEGER NOT NULL UNIQUE,
    beatmap_id INTEGER,
    beatmapset_id INTEGER,
    title TEXT,
    start_time TEXT,
    end_time TEXT,
    mods TEXT,
    total_length INTEGER,
    created_at TEXT NOT NULL
);

CREATE INDEX ix_lobby_games_match ON lobby_games(match_id);

CREATE TABLE lobby_scores (
    id INTEGER PRIMARY KEY,
    game_id INTEGER NOT NULL REFERENCES lobby_games(id) ON DELETE CASCADE,
    -- id профиля osu!: сопоставление с игроком турнира идёт по нему.
    osu_user_id INTEGER,
    total_score INTEGER NOT NULL,
    accuracy REAL,
    max_combo INTEGER,
    passed INTEGER NOT NULL,
    score_rank TEXT,
    mods TEXT,
    great INTEGER,
    ok INTEGER,
    meh INTEGER,
    miss INTEGER,
    UNIQUE(game_id, osu_user_id)
);

CREATE INDEX ix_lobby_scores_user ON lobby_scores(osu_user_id);
