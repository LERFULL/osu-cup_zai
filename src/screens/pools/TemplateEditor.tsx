import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Chip,
  Empty,
  Menu,
  MenuItem,
  RangeSlider,
  SlotLine,
  Switch,
} from '@/components';
import {
  MOD_TAGS,
  SKILLSETS,
  type GenReport,
  type GenRules,
  type ModTag,
  type PoolTemplate,
  type SlotSupply,
  type TemplateSlot,
} from '@/lib/types';
import { maps, slotConditions, slots as slotsWord } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import { useApp } from '@/store/app';
import s from './TemplateEditor.module.css';

interface Props {
  id: number;
  onClose: () => void;
  onGenerated: (report: GenReport) => void;
}

/** Слот в редакторе: id нужен только чтобы React не путал строки местами. */
type Draft = TemplateSlot;

export function TemplateEditor({ id, onClose, onGenerated }: Props) {
  const { collections } = useApp();
  const [name, setName] = useState('');
  const [rules, setRules] = useState<GenRules | null>(null);
  const [draft, setDraft] = useState<Draft[]>([]);
  const [supply, setSupply] = useState<SlotSupply[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const drag = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const t = await ipc.getTemplate(id);
      apply(t);
      setSupply(await ipc.templateSupply(id));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [id]);

  function apply(t: PoolTemplate) {
    setName(t.name);
    setRules(t.rules);
    setDraft(t.slots);
    setDirty(false);
  }

  useEffect(() => {
    void load();
  }, [load]);

  if (rules === null) {
    return (
      <div className={s.screen}>
        {error !== null ? (
          <Empty
            title="Не получилось открыть шаблон"
            note={error}
            actions={<Button onClick={onClose}>Назад</Button>}
          />
        ) : null}
      </div>
    );
  }

  function edit(index: number, patch: Partial<Draft>) {
    setDraft((prev) => prev.map((x, i) => (i === index ? { ...x, ...patch } : x)));
    setDirty(true);
  }

  function addSlot(mod: ModTag) {
    setAdding(false);
    setDraft((prev) => [
      ...prev,
      {
        id: -Date.now(),
        mod,
        // TB в пуле ровно один — предлагать другое количество незачем.
        count: mod === 'TB' ? 1 : 1,
        starMin: null,
        starMax: null,
        sourceCollectionId: null,
        requiredSkillsets: [],
        position: prev.length,
      },
    ]);
    setDirty(true);
  }

  function removeSlot(index: number) {
    setDraft((prev) => prev.filter((_, i) => i !== index));
    setOpen(null);
    setDirty(true);
  }

  function move(to: number) {
    const from = drag.current;
    if (from === null || from === to) return;
    setDraft((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      if (moved) next.splice(to, 0, moved);
      return next;
    });
    drag.current = to;
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    try {
      const saved = await ipc.saveTemplate(
        id,
        name,
        rules as GenRules,
        draft.map((x) => ({
          mod: x.mod,
          count: x.count,
          starMin: x.starMin,
          starMax: x.starMax,
          sourceCollectionId: x.sourceCollectionId,
          requiredSkillsets: x.requiredSkillsets,
        })),
      );
      apply(saved);
      // Счётчик подходящих карт считается по сохранённому — иначе он показывал бы
      // не то, что увидит генерация.
      setSupply(await ipc.templateSupply(id));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function roll() {
    if (dirty) await save();
    const poolName = window.prompt('Название маппула', name);
    if (poolName === null || poolName.trim() === '') return;
    try {
      onGenerated(await ipc.generatePool(id, poolName.trim()));
    } catch (e) {
      setError(String(e));
    }
  }

  const total = draft.reduce((n, x) => n + x.count, 0);
  const sourceName = (cid: number | null) =>
    cid === null ? null : (collections.find((c) => c.id === cid)?.name ?? null);

  // Предупреждения показываем только по сохранённому составу: пока правки
  // не записаны, счётчик относится к прошлой версии слота.
  const short = dirty
    ? []
    : supply
        .filter((x) => x.available < x.need)
        .map((x) => {
          const slot = draft[x.position];
          const where = sourceName(slot?.sourceCollectionId ?? null);
          const place = where !== null ? `«${where}»` : 'библиотеке';
          return {
            key: `${x.position}-${x.mod}`,
            mod: x.mod,
            // При нуле карт слот просто останется пустым — обещать «сработает»
            // в этом случае было бы враньём.
            title: x.available === 0 ? `Под слот ${x.mod} карт нет` : `Под слот ${x.mod} карт впритык`,
            text:
              x.available === 0
                ? `В ${place} нет ни одной подходящей карты, а нужно ${x.need}. Эти слоты останутся пустыми.`
                : `В ${place} подходит ${maps(x.available)}, а нужно ${x.need}. Генерация сработает, но разнообразия не будет.`,
          };
        });

  const available = supply.reduce((n, x) => n + x.available, 0);

  return (
    <div className={s.screen}>
      <header className={s.bar}>
        <button className={s.back} onClick={onClose} type="button" aria-label="Назад">
          ‹
        </button>
        <input
          className={s.title}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          aria-label="Название шаблона"
        />
        <span className={s.sub}>{slotsWord(total)}</span>

        <div className={s.right}>
          <Button size="sm" onClick={() => void roll()}>
            ↻ Скатать маппул
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void save()}
            disabled={saving || !dirty}
          >
            {saving ? 'Сохраняю…' : dirty ? 'Сохранить' : 'Сохранено'}
          </Button>
        </div>
      </header>

      <div className={s.body}>
        <div className={s.col}>
          {error !== null ? <div className={s.error}>{error}</div> : null}

          <section className={s.panel}>
            <h3 className={s.h3}>Слоты</h3>

            {draft.length === 0 ? (
              <p className={s.hint}>
                Пока ни одного слота. Слот — это мод-тег и сколько карт под него взять.
              </p>
            ) : null}

            {draft.map((slot, i) => (
              <div key={slot.id} className={s.slot}>
                <SlotLine
                  mod={slot.mod}
                  badge={`${slot.mod}×${slot.count}`}
                  onDragStart={() => (drag.current = i)}
                  onDragOver={() => move(i)}
                  onDrop={() => (drag.current = null)}
                  end={
                    <>
                      <span className={s.count}>
                        <button
                          className={s.step}
                          onClick={() => edit(i, { count: Math.max(1, slot.count - 1) })}
                          type="button"
                          aria-label="Меньше"
                          disabled={slot.mod === 'TB'}
                        >
                          −
                        </button>
                        <b>{slot.count}</b>
                        <button
                          className={s.step}
                          onClick={() => edit(i, { count: Math.min(32, slot.count + 1) })}
                          type="button"
                          aria-label="Больше"
                          disabled={slot.mod === 'TB'}
                        >
                          +
                        </button>
                      </span>
                      <button
                        className={s.more}
                        onClick={() => setOpen(open === i ? null : i)}
                        type="button"
                        aria-label="Настроить слот"
                      >
                        {open === i ? '▾' : '▸'}
                      </button>
                      <button
                        className={s.x}
                        onClick={() => removeSlot(i)}
                        type="button"
                        aria-label="Убрать слот"
                      >
                        ✕
                      </button>
                    </>
                  }
                >
                  <span className={s.cond}>
                    {slotConditions(
                      slot.starMin,
                      slot.starMax,
                      slot.requiredSkillsets,
                      sourceName(slot.sourceCollectionId),
                    )}
                  </span>
                </SlotLine>

                {open === i ? (
                  <div className={s.details}>
                    <div className={s.stars}>
                      <RangeSlider
                        label="Звёзды"
                        min={0}
                        max={12}
                        step={0.1}
                        value={[slot.starMin, slot.starMax]}
                        onChange={([lo, hi]) => edit(i, { starMin: lo, starMax: hi })}
                        format={(n) => n.toFixed(1)}
                      />
                    </div>

                    <label className={s.pick}>
                      <span className={s.pickLabel}>Откуда брать карты</span>
                      <select
                        className={s.select}
                        value={slot.sourceCollectionId ?? ''}
                        onChange={(e) =>
                          edit(i, {
                            sourceCollectionId: e.target.value === '' ? null : Number(e.target.value),
                          })
                        }
                      >
                        <option value="">Вся библиотека</option>
                        {collections.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                            {c.isSmart ? ' (умная)' : ''}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className={s.skills}>
                      <span className={s.pickLabel}>Обязательные скилсеты</span>
                      <div className={s.chips}>
                        {SKILLSETS.map((k) => (
                          <Chip
                            key={k}
                            active={slot.requiredSkillsets.includes(k)}
                            onClick={() =>
                              edit(i, {
                                requiredSkillsets: slot.requiredSkillsets.includes(k)
                                  ? slot.requiredSkillsets.filter((x) => x !== k)
                                  : [...slot.requiredSkillsets, k],
                              })
                            }
                          >
                            {k}
                          </Chip>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}

            <div className={s.add}>
              <button className={s.addBtn} onClick={() => setAdding(true)} type="button">
                + Добавить слот
              </button>
              <Menu open={adding} onClose={() => setAdding(false)}>
                {MOD_TAGS.map((m) => (
                  <MenuItem
                    key={m}
                    onClick={() => addSlot(m)}
                    disabled={m === 'TB' && draft.some((x) => x.mod === 'TB')}
                    {...(m === 'TB' ? { note: 'Тайбрейк, всегда последний и один' } : {})}
                  >
                    {m}
                  </MenuItem>
                ))}
              </Menu>
            </div>
          </section>

          <section className={s.panel}>
            <h3 className={s.h3}>Правила генерации</h3>

            <Switch
              checked={rules.noRepeatMapper}
              onChange={(v) => {
                setRules({ ...rules, noRepeatMapper: v });
                setDirty(true);
              }}
              note="Одна карта на маппера во всём пуле"
            >
              Не повторять маппера
            </Switch>

            <Switch
              checked={rules.rankedOnly}
              onChange={(v) => {
                setRules({ ...rules, rankedOnly: v });
                setDirty(true);
              }}
            >
              Только ranked
            </Switch>

            <Switch
              checked={rules.balanceSkillsets}
              onChange={(v) => {
                setRules({ ...rules, balanceSkillsets: v });
                setDirty(true);
              }}
              note="Поровну aim и speed, насколько хватит карт"
            >
              Держать баланс aim / speed
            </Switch>

            <Switch
              checked={rules.minBpmSpread !== null}
              onChange={(v) => {
                setRules({ ...rules, minBpmSpread: v ? 40 : null });
                setDirty(true);
              }}
              note="Чтобы весь пул не оказался в одном темпе"
            >
              Разброс BPM не меньше
            </Switch>
            {rules.minBpmSpread !== null ? (
              <div className={s.inline}>
                <input
                  className={s.number}
                  type="number"
                  min={5}
                  max={200}
                  step={5}
                  value={rules.minBpmSpread}
                  onChange={(e) => {
                    setRules({ ...rules, minBpmSpread: Number(e.target.value) });
                    setDirty(true);
                  }}
                  aria-label="Минимальный разброс BPM"
                />
                <span className={s.unit}>BPM</span>
              </div>
            ) : null}

            <Switch
              checked={rules.lengthMax !== null}
              onChange={(v) => {
                setRules({ ...rules, lengthMax: v ? 300 : null });
                setDirty(true);
              }}
            >
              Не брать карты длиннее
            </Switch>
            {rules.lengthMax !== null ? (
              <div className={s.inline}>
                <input
                  className={s.number}
                  type="number"
                  min={30}
                  max={900}
                  step={15}
                  value={rules.lengthMax}
                  onChange={(e) => {
                    setRules({ ...rules, lengthMax: Number(e.target.value) });
                    setDirty(true);
                  }}
                  aria-label="Максимальная длина карты в секундах"
                />
                <span className={s.unit}>секунд</span>
              </div>
            ) : null}
          </section>

          <div className={s.footer}>
            {dirty ? (
              <span className={s.pending}>
                Правки не сохранены — счётчик подходящих карт покажется после сохранения.
              </span>
            ) : (
              <span>
                {slotsWord(total)}, подходящих карт в источниках: {available}
              </span>
            )}
          </div>

          {short.map((w) => (
            <div key={w.key} className={s.warn}>
              <span className={s.warnIcon} aria-hidden>
                ⚠
              </span>
              <div>
                <div className={s.warnTitle}>{w.title}</div>
                <div className={s.hint}>
                  {w.text} Расширь диапазон звёзд или добавь карт в источник.
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
