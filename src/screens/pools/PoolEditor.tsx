import { useCallback, useEffect, useState } from 'react';
import { Button, Chip, Empty, MapRow, Menu, MenuItem, MenuSeparator } from '@/components';
import {
  MOD_TAGS,
  POOL_FIELDS,
  type Beatmap,
  type Pool,
  type PoolField,
  type PoolSlot,
} from '@/lib/types';
import { coverUrl, formatLength, poolAverageStars } from '@/lib/format';
import { FM_CHOICES, derive } from '@/lib/derive';
import { useReorder } from '@/lib/useReorder';
import * as ipc from '@/lib/ipc';
import { Import } from '../library/Import';
import { Picker } from './Picker';
import s from './PoolEditor.module.css';

interface Props {
  id: number;
  /** Заметки генерации: что не удалось выдержать. Показываются один раз. */
  notes: string[];
  onClose: () => void;
}

const FIELD_NAMES: Record<PoolField, string> = {
  stars: 'Звёзды',
  length: 'Длина',
  bpm: 'BPM',
  ar: 'AR',
  od: 'OD',
  cs: 'CS',
  hp: 'HP',
  mapper: 'Маппер',
  skillsets: 'Скилсеты',
};

export function PoolEditor({ id, notes, onClose }: Props) {
  const [pool, setPool] = useState<Pool | null>(null);
  // Правки сыгранного пула уезжают в копию: дальше работаем с её id.
  const [current, setCurrent] = useState(id);
  const [picking, setPicking] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hints, setHints] = useState<string[]>(notes);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (poolId: number) => {
    try {
      setPool(await ipc.getPool(poolId));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load(current);
  }, [load, current]);

  /** Ответ команды — пул целиком, вместе с его настоящим id. */
  function accept(next: Pool) {
    setPool(next);
    if (next.id !== current) setCurrent(next.id);
  }

  async function guard(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Порядок слотов уходит в базу один раз — на отпускании. */
  const applyOrder = useCallback(
    (from: number, to: number) => {
      setPool((prev) => {
        if (prev === null) return prev;

        const next = [...prev.slots];
        const [moved] = next.splice(from, 1);
        if (moved === undefined) return prev;
        next.splice(to, 0, moved);

        // Показываем новый порядок сразу, не дожидаясь ответа: иначе строка
        // на миг отскакивала бы назад.
        void ipc
          .reorderPoolSlots(
            prev.id,
            next.map((x) => x.position),
          )
          .then((saved) => {
            setPool(saved);
            if (saved.id !== prev.id) setCurrent(saved.id);
          })
          .catch((e: unknown) => setError(String(e)));

        return { ...prev, slots: next };
      });
    },
    [],
  );

  const reorder = useReorder({ count: pool?.slots.length ?? 0, onDrop: applyOrder });

  if (pool === null) {
    return (
      <div className={s.screen}>
        {error !== null ? (
          <Empty
            title="Не получилось открыть маппул"
            note={error}
            actions={<Button onClick={onClose}>Назад</Button>}
          />
        ) : null}
      </div>
    );
  }

  const p = pool;
  const taken = new Set(p.slots.map((x) => x.beatmapId).filter((x): x is number => x !== null));
  const avg = poolAverageStars(p);
  const pinned = p.slots.filter((x) => x.pinned).length;
  const filled = p.slots.filter((x) => x.beatmapId !== null).length;
  const slot = picking !== null ? (p.slots.find((x) => x.position === picking) ?? null) : null;

  async function rename() {
    const name = window.prompt('Название маппула', p.name);
    if (name === null || name.trim() === '') return;
    await guard(async () => {
      const target = await ipc.renamePool(p.id, name.trim());
      setCurrent(target);
      await load(target);
    });
  }

  async function reroll(keepPinned: boolean) {
    setMenu(null);
    await guard(async () => {
      const report = await ipc.rerollPool(p.id, keepPinned);
      accept(report.pool);
      setHints(report.notes);
    });
  }

  async function rerollOne(position: number) {
    await guard(async () => {
      const report = await ipc.rerollSlot(p.id, position);
      accept(report.pool);
      setHints(report.notes);
    });
  }

  function toggleField(f: PoolField) {
    const next = p.displayFields.includes(f)
      ? p.displayFields.filter((x) => x !== f)
      : [...p.displayFields, f];
    setPool({ ...p, displayFields: next });
    void ipc.setPoolDisplayFields(p.id, next);
  }

  /** Правая часть строки: то, что выбрано в «Поля». */
  function details(x: PoolSlot): string {
    const map = x.beatmap;
    if (map === null) return 'карта не подобрана';

    const d = derive(map, x.mod === 'FM' || x.mod === 'TB' || x.mod === 'NM' ? '' : x.mod);
    const out: string[] = [];
    for (const f of p.displayFields) {
      if (f === 'stars') continue; // звёзды всегда в хвосте строки
      if (f === 'length') out.push(formatLength(d.totalLength));
      if (f === 'bpm' && d.bpm !== null) out.push(`${Math.round(d.bpm)} BPM`);
      if (f === 'ar' && d.ar !== null) out.push(`AR ${d.ar}`);
      if (f === 'od' && d.od !== null) out.push(`OD ${d.od}`);
      if (f === 'cs' && d.cs !== null) out.push(`CS ${d.cs}`);
      if (f === 'hp' && d.hp !== null) out.push(`HP ${d.hp}`);
      if (f === 'mapper' && map.creator !== null) out.push(map.creator);
      if (f === 'skillsets' && map.skillsets.length > 0) {
        out.push(map.skillsets.map((k) => k.skillset).join(', '));
      }
    }
    return [map.version, ...out].join(' · ');
  }

  /** Кнопки слота. Одинаковые и для подобранной карты, и для пустого слота. */
  function slotTools(x: PoolSlot) {
    return (
      <>
        <button
          className={[s.tool, x.pinned ? s.on : null].filter(Boolean).join(' ')}
          onClick={() =>
            void guard(async () => accept(await ipc.setSlotPinned(p.id, x.position, !x.pinned)))
          }
          type="button"
          title={x.pinned ? 'Открепить' : 'Закрепить — не меняется при перекате'}
        >
          📌
        </button>

        {p.templateId !== null ? (
          <button
            className={s.tool}
            onClick={() => void rerollOne(x.position)}
            type="button"
            title="Перекатить слот"
            disabled={busy}
          >
            ↻
          </button>
        ) : null}

        <button
          className={s.tool}
          onClick={() => setMenu(menu === `m${x.position}` ? null : `m${x.position}`)}
          type="button"
          title={x.mod === 'FM' ? 'Мод слота и что разрешено на FM' : 'Сменить мод'}
        >
          ◇
        </button>

        <button
          className={s.tool}
          onClick={() => setPicking(x.position)}
          type="button"
          title="Заменить вручную"
        >
          ⋯
        </button>

        <button
          className={[s.tool, s.danger].join(' ')}
          onClick={() =>
            void guard(async () => accept(await ipc.removePoolSlot(p.id, x.position)))
          }
          type="button"
          title="Убрать слот из пула"
        >
          ✕
        </button>
      </>
    );
  }

  return (
    <div className={s.screen}>
      <div className={s.main}>
        <header className={s.bar}>
          <button className={s.back} onClick={onClose} type="button" aria-label="Назад">
            ‹
          </button>
          <button className={s.title} onClick={() => void rename()} type="button">
            {p.name}
            {p.version > 1 ? <span className={s.version}>v{p.version}</span> : null}
          </button>
          <span className={s.sub}>
            {filled} из {p.slots.length}
            {avg !== null ? ` · ${avg.toFixed(2)}★` : ''}
            {pinned > 0 ? ` · закреплено ${pinned}` : ''}
          </span>

          <div className={s.right}>
            <div className={s.wrap}>
              <Button size="sm" onClick={() => setMenu(menu === 'fields' ? null : 'fields')}>
                Поля ▾
              </Button>
              <Menu open={menu === 'fields'} onClose={() => setMenu(null)} align="right">
                {POOL_FIELDS.map((f) => (
                  <MenuItem key={f} onClick={() => toggleField(f)}>
                    {p.displayFields.includes(f) ? '✓ ' : '   '}
                    {FIELD_NAMES[f]}
                  </MenuItem>
                ))}
              </Menu>
            </div>

            <div className={s.wrap}>
              <Button size="sm" onClick={() => setMenu(menu === 'more' ? null : 'more')}>
                ⋯
              </Button>
              <Menu open={menu === 'more'} onClose={() => setMenu(null)} align="right">
                <MenuItem
                  onClick={() => {
                    setMenu(null);
                    void ipc.setPoolStatus(p.id, p.status === 'ready' ? 'draft' : 'ready');
                    setPool({ ...p, status: p.status === 'ready' ? 'draft' : 'ready' });
                  }}
                  note={p.status === 'ready' ? 'Сейчас помечен готовым' : 'Сейчас черновик'}
                >
                  {p.status === 'ready' ? 'Вернуть в черновики' : 'Пометить готовым'}
                </MenuItem>
                <MenuSeparator />
                {MOD_TAGS.map((m) => (
                  <MenuItem
                    key={m}
                    onClick={() => {
                      setMenu(null);
                      void guard(async () => accept(await ipc.addPoolSlot(p.id, m)));
                    }}
                    disabled={m === 'TB' && p.slots.some((x) => x.mod === 'TB')}
                  >
                    + Слот {m}
                  </MenuItem>
                ))}
              </Menu>
            </div>

            {p.templateId !== null ? (
              <>
                <Button size="sm" onClick={() => void reroll(false)} disabled={busy}>
                  ↻ Скатать
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void reroll(true)}
                  disabled={busy}
                >
                  ↻ Скатать незакреплённые
                </Button>
              </>
            ) : null}
          </div>
        </header>

        <div className={s.body}>
          <div className={s.col}>
            {error !== null ? <div className={s.error}>{error}</div> : null}

            {hints.map((n) => (
              <div key={n} className={s.note}>
                <span className={s.noteIcon} aria-hidden>
                  ⚠
                </span>
                <span>{n}</span>
              </div>
            ))}

            {p.isLocked ? (
              <div className={s.note}>
                <span className={s.noteIcon} aria-hidden>
                  🔒
                </span>
                <span>
                  Этот маппул уже сыгран. Любая правка создаст его новую версию, а эта останется
                  как есть.
                </span>
              </div>
            ) : null}

            {p.slots.length === 0 ? (
              <Empty
                title="В маппуле нет слотов"
                note="Добавь слоты через «⋯» или скатай пул по шаблону."
              />
            ) : null}

            {p.slots.map((x, i) => (
              <div key={x.id} className={s.slot} data-row style={reorder.rowStyle(i)}>
                {x.beatmap !== null ? (
                  <MapRow
                    kind="plain"
                    stars={x.starRatingWithMods ?? x.beatmap.difficultyRating}
                    cover={coverUrl(x.beatmap.coverPath)}
                    title={`${x.beatmap.artist} — ${x.beatmap.title}`}
                    version={details(x)}
                    mod={x.mod}
                    slot={x.slotLabel}
                    gripProps={reorder.handleProps(i)}
                    tools={slotTools(x)}
                    onClick={() => setPicking(x.position)}
                  />
                ) : (
                  <div className={s.empty}>
                    <span
                      className={s.emptyGrip}
                      title="Потянуть, чтобы переставить"
                      {...reorder.handleProps(i)}
                    >
                      ⠿
                    </span>
                    <button
                      className={s.emptySlot}
                      onClick={() => setPicking(x.position)}
                      type="button"
                    >
                      <span className={s.emptyLabel} data-mod={x.mod}>
                        {x.slotLabel}
                      </span>
                      <span className={s.emptyText}>карта не подобрана — выбрать</span>
                    </button>
                    <div className={s.emptyTools}>{slotTools(x)}</div>
                  </div>
                )}

                <Menu
                  open={menu === `m${x.position}`}
                  onClose={() => setMenu(null)}
                  align="right"
                >
                  {MOD_TAGS.map((m) => (
                    <MenuItem
                      key={m}
                      onClick={() => {
                        setMenu(null);
                        void guard(async () =>
                          accept(await ipc.setSlotMod(p.id, x.position, m)),
                        );
                      }}
                      disabled={m === 'TB' && p.slots.some((y) => y.mod === 'TB')}
                      {...(x.beatmap !== null && !x.beatmap.mods.includes(m)
                        ? { note: 'У карты нет этого тега' }
                        : {})}
                    >
                      {m === x.mod ? '✓ ' : '   '}
                      {m}
                    </MenuItem>
                  ))}

                  {x.mod === 'FM' ? (
                    <div className={s.fm}>
                      <span className={s.fmLabel}>Разрешено на FM</span>
                      <div className={s.fmChips}>
                        {FM_CHOICES.map((m) => (
                          <Chip
                            key={m}
                            active={x.fmMods.includes(m)}
                            onClick={() =>
                              void guard(async () =>
                                accept(
                                  await ipc.setSlotFmMods(
                                    p.id,
                                    x.position,
                                    x.fmMods.includes(m)
                                      ? x.fmMods.filter((y) => y !== m)
                                      : [...x.fmMods, m],
                                  ),
                                ),
                              )
                            }
                          >
                            {m}
                          </Chip>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </Menu>

                {x.warnings.length > 0 ? (
                  <div className={s.warnings}>
                    {x.warnings.map((w) => (
                      <span key={w} className={s.warn}>
                        ⚠ {w}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>

      {slot !== null ? (
        <Picker
          poolId={p.id}
          slot={slot}
          taken={taken}
          onClose={() => setPicking(null)}
          onImport={() => setImporting(true)}
          onPick={(m: Beatmap) => {
            setPicking(null);
            void guard(async () =>
              accept(await ipc.setSlotBeatmap(p.id, slot.position, m.beatmapId)),
            );
          }}
        />
      ) : null}

      {importing ? (
        <Import onClose={() => setImporting(false)} onDone={() => setImporting(false)} />
      ) : null}
    </div>
  );
}
