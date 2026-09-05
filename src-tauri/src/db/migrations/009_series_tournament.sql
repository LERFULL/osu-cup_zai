-- Серия жёстко привязывается к турниру. Один турнир — одна серия; отвязка
-- турнира (или его удаление) освобождает серию, но не трогает её маппулы.

ALTER TABLE series ADD COLUMN tournament_id INTEGER REFERENCES tournaments(id) ON DELETE SET NULL;

-- На один турнир — одна привязанная серия: без этого ограничення «привязка
-- к турниру» быстро превратилась бы в decoration.
CREATE UNIQUE INDEX ix_series_tournament ON series(tournament_id) WHERE tournament_id IS NOT NULL;
