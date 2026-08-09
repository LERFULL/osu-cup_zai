-- Два шаблона из коробки. Диапазоны звёзд и источники намеренно пустые:
-- уровень своей тусовки знает только сам пользователь, а выдуманные значения
-- он потом молча унаследует и удивится результату.

INSERT INTO pool_templates (name, rules, is_builtin, created_at)
SELECT 'Стандарт 1v1', '{"noRepeatMapper":true}', 1, '2026-01-01T00:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM pool_templates WHERE name = 'Стандарт 1v1');

INSERT INTO template_slots (template_id, mod, count, position)
SELECT t.id, s.mod, s.count, s.position
FROM pool_templates t
JOIN (
  SELECT 'NM' AS mod, 4 AS count, 0 AS position
  UNION ALL SELECT 'HD', 2, 1
  UNION ALL SELECT 'HR', 2, 2
  UNION ALL SELECT 'DT', 2, 3
  UNION ALL SELECT 'FM', 1, 4
  UNION ALL SELECT 'TB', 1, 5
) s
WHERE t.name = 'Стандарт 1v1'
  AND NOT EXISTS (SELECT 1 FROM template_slots ts WHERE ts.template_id = t.id);

INSERT INTO pool_templates (name, rules, is_builtin, created_at)
SELECT 'Короткий', '{"noRepeatMapper":true}', 1, '2026-01-01T00:00:00Z'
WHERE NOT EXISTS (SELECT 1 FROM pool_templates WHERE name = 'Короткий');

INSERT INTO template_slots (template_id, mod, count, position)
SELECT t.id, s.mod, s.count, s.position
FROM pool_templates t
JOIN (
  SELECT 'NM' AS mod, 3 AS count, 0 AS position
  UNION ALL SELECT 'HD', 1, 1
  UNION ALL SELECT 'HR', 1, 2
  UNION ALL SELECT 'DT', 1, 3
  UNION ALL SELECT 'TB', 1, 4
) s
WHERE t.name = 'Короткий'
  AND NOT EXISTS (SELECT 1 FROM template_slots ts WHERE ts.template_id = t.id);
