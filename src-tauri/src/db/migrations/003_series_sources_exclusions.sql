-- Серии маппулов, источники и исключения.
--
-- Серия заменяет папку: две сущности «группа маппулов» не нужны, а у серии
-- есть тип, свои правила и статистика. Колонка folder_id у пулов остаётся
-- мёртвой — удалять её значит переписывать таблицу ради ничего.
--
-- Состав серии — колонки у пула, а не отдельная таблица связей: маппул входит
-- не больше чем в одну серию, и таблица всё равно требовала бы уникальности
-- по pool_id, то есть той же самой колонки.

CREATE TABLE IF NOT EXISTS series (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'tournament',  -- tournament | free
  color            TEXT,
  note             TEXT,
  sources          TEXT,                -- JSON SourceSet; NULL = вся библиотека
  no_repeat_inside INTEGER NOT NULL DEFAULT 1,
  display_fields   TEXT,                -- JSON: что показывать в строках пулов серии
  position         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);

-- Серия у пула, его место в ней и метка раунда. Метка свободная: «раунд 1»,
-- «полуфинал» — подставляется сама, но правится руками.
ALTER TABLE pools ADD COLUMN series_id       INTEGER REFERENCES series(id) ON DELETE SET NULL;
ALTER TABLE pools ADD COLUMN series_position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pools ADD COLUMN series_label    TEXT;

-- Источники на каждом уровне. NULL — наследовать выше: слот → пул → серия →
-- шаблон → вся библиотека.
ALTER TABLE pools          ADD COLUMN sources TEXT;
ALTER TABLE pool_slots     ADD COLUMN sources TEXT;
ALTER TABLE pool_templates ADD COLUMN sources TEXT;

CREATE INDEX IF NOT EXISTS ix_pools_series ON pools(series_id, series_position);

-- Исключения. Владельцем может быть серия, пул или шаблон: у всех трёх есть
-- своё «чего не берём», и складываются они по уровням, а не подменяют друг друга.
CREATE TABLE IF NOT EXISTS exclusions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_kind TEXT NOT NULL,             -- series | pool | template
  owner_id   INTEGER NOT NULL,
  target     TEXT NOT NULL,             -- JSON ExclusionTarget
  strict     INTEGER NOT NULL DEFAULT 1,
  enabled    INTEGER NOT NULL DEFAULT 1,
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_exclusions_owner ON exclusions(owner_kind, owner_id, position);

-- ────────────────────────────── перенос старых правил в исключения
--
-- no_repeat_mapper и no_repeat_from_pools жили в правилах шаблона. Теперь всё
-- «чего не берём» лежит в одном месте, поэтому переносим их сюда, а из правил
-- убираем: иначе одно и то же условие оказалось бы в двух местах и разошлось.

INSERT INTO exclusions (owner_kind, owner_id, target, strict, enabled, position)
SELECT 'template', t.id, '{"kind":"sameMapperInside"}', 1, 1, 0
FROM pool_templates t
WHERE json_valid(t.rules)
  AND json_extract(t.rules, '$.noRepeatMapper') = 1
  AND NOT EXISTS (
    SELECT 1 FROM exclusions e
    WHERE e.owner_kind = 'template' AND e.owner_id = t.id
      AND json_extract(e.target, '$.kind') = 'sameMapperInside'
  );

INSERT INTO exclusions (owner_kind, owner_id, target, strict, enabled, position)
SELECT 'template', t.id, json_object('kind', 'pool', 'id', j.value), 1, 1, j.key + 1
FROM pool_templates t
JOIN json_each(t.rules, '$.noRepeatFromPools') j
WHERE json_valid(t.rules)
  AND json_type(t.rules, '$.noRepeatFromPools') = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM exclusions e
    WHERE e.owner_kind = 'template' AND e.owner_id = t.id
      AND json_extract(e.target, '$.kind') = 'pool'
      AND json_extract(e.target, '$.id') = j.value
  );

UPDATE pool_templates
SET rules = json_remove(rules, '$.noRepeatMapper', '$.noRepeatFromPools')
WHERE json_valid(rules);
