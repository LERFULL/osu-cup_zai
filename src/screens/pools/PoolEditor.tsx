import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Chip, Empty, MapRow, Menu, MenuItem, MenuSeparator } from '@/components';
import {
  MOD_TAGS,
  POOL_FIELDS,
  type Beatmap,
  type GenNote,
  type ModTag,
  type Pool,
  type PoolField,
  type PoolSlot,
  type PoolTemplate,
  type PoolWhence,
} from '@/lib/types';
import {
  coverUrl,
  formatLength,
  plural,
  poolAverageStars,
  slots as slotsWord,
} from '@/lib/format';
import { FM_CHOICES, derive } from '@/lib/derive';
import { useReorder } from '@/lib/useReorder';
import { copyImage, downloadBlob, renderPoolImage } from '@/lib/exportImage';
import * as ipc from '@/lib/ipc';
import { useApp } from '@/store/app';
import { ImportJson } from './ImportJson';
import { Picker } from './Picker';
import { Report } from './Report';
import { Whence } from './Whence';
import s from './PoolEditor.module.css';

interface Props {
  id: number;
  /** Заметки генерации: что не удалось выдержать. */
  notes: GenNote[];
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
  const { go } = useApp();
  const [pool, setPool] = useState<Pool | null>(null);
  const [whence, setWhence] = useState<PoolWhence | null>(null);
  // Шаблоны для выбора прямо в редакторе: пул может получить структуру
  // и после создания, а не только при генерации.
  const [templates, setTemplates] = useState<PoolTemplate[]>([]);
  // Правки сыгранного пула уезжают в копию: дальше работаем с её id.
  const [current, setCurrent] = useState(id);
  const [picking, setPicking] = useState<number | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hints, setHints] = useState<GenNote[]>(notes);
  const [showReport, setShowReport] = useState(notes.length > 0);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState(true);

  /** Выделенные слоты — по позициям: id меняются при уходе в новую версию. */
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const anchor = useRef<number | null>(null);

  const load = useCallback(async (poolId: number) => {
    try {
      const [p, w, ts] = await Promise.all([
        ipc.getPool(poolId),
        ipc.poolWhence(poolId),
        ipc.listTemplates().catch(() => [] as PoolTemplate[]),
      ]);
      setPool(p);
      setWhence(w);
      setTemplates(ts);
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
    // Запас и исключения зависят от состава: перечитываем их вместе с пулом.
    void ipc.poolWhence(next.id).then(setWhence).catch(() => undefined);
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

  // Слоты и id пула для перетаскивания — через ref: ручка строки создаётся
  // один раз, а порядок и сам пул меняются на каждом переносе.
  const latest = useRef<{ id: number; slots: PoolSlot[] }>({ id, slots: [] });
  latest.current = { id: pool?.id ?? id, slots: pool?.slots ?? [] };

  /**
   * Порядок слотов уходит в базу один раз — на отпускании.
   *
   * Новый список считается снаружи `setPool`: обновляющую функцию React в
   * строгом режиме зовёт дважды, и запрос из неё уходил бы тоже дважды —
   * вторая перестановка отменяла бы первую.
   */
  const applyOrder = useCallback((from: number, to: number) => {
    const { id: poolId, slots } = latest.current;
    const list = [...slots];
    const [moved] = list.splice(from, 1);
    if (moved === undefined) return;
    list.splice(to, 0, moved);

    // Показываем новый порядок сразу: иначе строка на миг отскакивала бы назад.
    setPool((prev) => (prev === null ? prev : { ...prev, slots: list }));
    // Метки слотов после переноса другие — выделение по позициям уже не про те строки.
    setPicked(new Set());

    void ipc
      .reorderPoolSlots(
        poolId,
        list.map((x) => x.position),
      )
      .then((saved) => {
        setPool(saved);
        if (saved.id !== poolId) setCurrent(saved.id);
        void ipc.poolWhence(saved.id).then(setWhence).catch(() => undefined);
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

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
  const positions = [...picked];
  const pickedMaps = p.slots
    .filter((x) => picked.has(x.position) && x.beatmapId !== null)
    .map((x) => x.beatmapId as number);

  async function rename() {
    const name = window.prompt('Название маппула', p.name);
    if (name === null || name.trim() === '') return;
    await guard(async () => {
      const target = await ipc.renamePool(p.id, name.trim());
      setCurrent(target);
      await load(target);
    });
  }

  /** Маппул файлом .json: имя файла — название пула. */
  async function exportJson() {
    setMenu(null);
    try {
      const json = await ipc.exportPoolJson(p.id);
      downloadBlob(new Blob([json], { type: 'application/json' }), `${p.name}.json`);
    } catch (e) {
      setError(String(e));
    }
  }

  /** Маппул картинкой в буфер; без буфера — файлом. */
  async function picture() {
    try {
      setBusy(true);
      const blob = await renderPoolImage(p, null);
      await copyImage(blob, `${p.name}.png`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function setLabel() {
    setMenu(null);
    const next = window.prompt('Метка раунда', p.seriesLabel ?? '');
    if (next === null) return;
    await guard(async () => {
      await ipc.setSeriesPoolLabel(p.id, next.trim() === '' ? null : next.trim());
      await load(p.id);
    });
  }

  async function roll(keepPinned: boolean) {
    setMenu(null);
    await guard(async () => {
      const report = await ipc.rerollPool(p.id, keepPinned);
      accept(report.pool);
      setHints(report.notes);
      setShowReport(report.notes.length > 0);
    });
  }

  /** Применить шаблон прямо в редакторе: структура пересобирается, состав
   *  генерируется заново. Набранное руками стирается — потому и спрашиваем. */
  async function applyTemplate(templateId: number) {
    setMenu(null);
    const t = templates.find((x) => x.id === templateId);
    if (
      filled > 0 &&
      !window.confirm(
        `Применить шаблон «${t?.name ?? templateId}»? Текущие слоты и карты пула будут заменены.`,
      )
    )
      return;
    await guard(async () => {
      const report = await ipc.applyTemplateToPool(p.id, templateId);
      accept(report.pool);
      setHints(report.notes);
      setShowReport(report.notes.length > 0);
    });
  }

  /** Перекатить выделенные слоты, а если выделения нет — один слот. */
  async function rollSlots(list: number[]) {
    await guard(async () => {
      const report = await ipc.rerollSlots(p.id, list);
      accept(report.pool);
      setHints(report.notes);
      setShowReport(report.notes.length > 0);
    });
  }

  /**
   * «+ Добавить карту». Есть пустой слот — подбираем в него: держать дырку и
   * дописывать пул в конец никто не хочет. Нет — спрашиваем мод нового слота:
   * карта в пуле живёт в слоте, и мод у него должен быть выбран, а не угадан.
   */
  function addCard() {
    const hole = p.slots.find((x) => x.beatmapId === null);
    if (hole !== undefined) {
      setPicking(hole.position);
      return;
    }
    setMenu(menu === 'addCard' ? null : 'addCard');
  }

  async function addSlotAndPick(mod: ModTag) {
    setMenu(null);
    await guard(async () => {
      const next = await ipc.addPoolSlot(p.id, mod);
      accept(next);
      // Свежий слот — последний пустой с этим модом: метки после добавления
      // пересчитываются, и позиция до запроса ничего не значила.
      const made = [...next.slots].reverse().find((x) => x.mod === mod && x.beatmapId === null);
      if (made !== undefined) setPicking(made.position);
    });
  }

  function toggleField(f: PoolField) {
    const next = p.displayFields.includes(f)
      ? p.displayFields.filter((x) => x !== f)
      : [...p.displayFields, f];
    setPool({ ...p, displayFields: next });
    void ipc.setPoolDisplayFields(p.id, next);
  }

  // ── выделение слотов

  function togglePick(position: number, shift: boolean, ctrl: boolean) {
    setPicked((prev) => {
      const next = new Set(prev);
      const from = anchor.current;

      if (shift && from !== null) {
        const [a, b] = from < position ? [from, position] : [position, from];
        for (const x of p.slots) if (x.position >= a && x.position <= b) next.add(x.position);
        return next;
      }

      if (!ctrl && !next.has(position)) {
        // Обычный клик выбирает одну строку: набирать выделение по одной —
        // это Ctrl, и путать их значит терять выбор случайным кликом.
        return new Set([position]);
      }
      if (next.has(position)) next.delete(position);
      else next.add(position);
      return next;
    });
    if (!shift) anchor.current = position;
  }

  /**
   * Выделение протягиванием — как в библиотеке. Направление задаёт первая
   * строка: начали с невыделенной — ведём выделение, с выделенной — снимаем.
   */
  function startSweep(position: number, shift: boolean) {
    if (shift) {
      togglePick(position, true, false);
      return;
    }

    const adding = !picked.has(position);
    let last = position;

    const apply = (to: number) => {
      setPicked((prev) => {
        const next = new Set(prev);
        const [a, b] = last < to ? [last, to] : [to, last];
        for (const x of p.slots) {
          if (x.position < a || x.position > b) continue;
          if (adding) next.add(x.position);
          else next.delete(x.position);
        }
        return next;
      });
      last = to;
    };

    apply(position);
    anchor.current = position;

    const move = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const row = el instanceof Element ? el.closest('[data-slot]') : null;
      if (!(row instanceof HTMLElement)) return;
      const to = Number(row.dataset['slot']);
      if (Number.isFinite(to) && to !== last) apply(to);
    };

    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      anchor.current = last;
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
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
            void guard(async () =>
              accept(await ipc.setSlotsPinned(p.id, [x.position], !x.pinned)),
            )
          }
          type="button"
          title={x.pinned ? 'Открепить' : 'Закрепить — не меняется при перекате'}
        >
          📌
        </button>

        {p.templateId !== null ? (
          <button
            className={s.tool}
            onClick={() => void rollSlots([x.position])}
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
            void guard(async () => accept(await ipc.removePoolSlots(p.id, [x.position])))
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
            {p.seriesName !== null ? (
              <button className={s.series} onClick={() => void setLabel()} type="button">
                {p.seriesName}
                {p.seriesLabel !== null ? ` · ${p.seriesLabel}` : ''}
              </button>
            ) : null}
            {filled} из {p.slots.length}
            {avg !== null ? ` · ${avg.toFixed(2)}★` : ''}
            {pinned > 0 ? ` · закреплено ${pinned}` : ''}
          </span>

          {/* Шаблон — часть пула, а не деталь генерации: выбирается здесь,
              перекаты и отчёты работают одинаково для любого пула. */}
          <div className={s.wrap}>
            <Button
              size="sm"
              onClick={() => setMenu(menu === 'template' ? null : 'template')}
              title="Структура слотов и правила генерации"
            >
              Шаблон:{' '}
              {p.templateName !== null
                ? p.templateName
                : templates.length > 0
                  ? 'не задан'
                  : 'нет шаблонов'}
            </Button>
            <Menu open={menu === 'template'} onClose={() => setMenu(null)} align="left">
              {templates.length === 0 ? (
                <MenuItem onClick={() => setMenu(null)} disabled note="создай его во вкладке «Шаблоны»">
                  Шаблонов пока нет
                </MenuItem>
              ) : (
                templates.map((t) => (
                  <MenuItem
                    key={t.id}
                    onClick={() => void applyTemplate(t.id)}
                    disabled={t.id === p.templateId}
                    {...(t.id === p.templateId
                      ? { note: 'уже применён' }
                      : filled > 0
                        ? { note: 'слоты и карты заменятся' }
                        : {})}
                  >
                    {t.name}
                  </MenuItem>
                ))
              )}
            </Menu>
          </div>

          <div className={s.right}>
            {hints.length > 0 && !showReport ? (
              <Button size="sm" onClick={() => setShowReport(true)}>
                Отчёт {hints.length}
              </Button>
            ) : null}

            <div className={s.wrap}>
              <Button size="sm" onClick={() => setMenu(menu === 'fields' ? null : 'fields')}>
                Поля ▾
              </Button>
              <Menu open={menu === 'fields'} onClose={() => setMenu(null)} align="right">
                {POOL_FIELDS.map((f) => (
                  <MenuItem key={f} onClick={() => toggleField(f)}>
                    {p.displayFields.includes(f) ? '✓ ' : '   '}
                    {FIELD_NAMES[f]}
                  </MenuItem>
                ))}
              </Menu>
            </div>

            <Button
              size="sm"
              onClick={() => void picture()}
              disabled={busy}
              title="Маппул картинкой в буфер обмена"
            >
              Картинкой
            </Button>

            <Chip active={panel} onClick={() => setPanel(!panel)} title="Источники и исключения">
              Откуда берём
            </Chip>

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

                <MenuItem onClick={() => void exportJson()} note="Файл .json — переносится между компьютерами">
                  Экспорт JSON
                </MenuItem>

                <ImportJson
                  onImported={(res) => {
                    // Импорт создаёт новый пул — редактор переходит в него.
                    setCurrent(res.pool.id);
                    void load(res.pool.id);
                    if (res.skippedMaps > 0) {
                      setError(
                        `${res.skippedMaps} ${plural(res.skippedMaps, 'карта', 'карты', 'карт')} не скачались — слоты под них пустые`,
                      );
                    }
                  }}
                >
                  {(open) => (
                    <MenuItem
                      onClick={() => {
                        setMenu(null);
                        open();
                      }}
                      note="Собрать пул из файла .json"
                    >
                      Импорт JSON…
                    </MenuItem>
                  )}
                </ImportJson>

                {p.seriesName !== null ? (
                  <>
                    <MenuItem onClick={() => void setLabel()}>Метка раунда…</MenuItem>
                    <MenuItem
                      onClick={() => {
                        setMenu(null);
                        void guard(async () => {
                          await ipc.removePoolFromSeries(p.id);
                          await load(p.id);
                        });
                      }}
                      note={`Уйдёт из «${p.seriesName}» в общий список`}
                    >
                      Вынести из серии
                    </MenuItem>
                  </>
                ) : null}

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
                <Button size="sm" onClick={() => void roll(false)} disabled={busy}>
                  ↻ Скатать
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void roll(true)}
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

            {showReport ? (
              <Report notes={hints} onClose={() => setShowReport(false)} />
            ) : null}

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
              <div
                key={x.id}
                className={s.slot}
                data-row
                data-slot={x.position}
                style={reorder.rowStyle(i)}
              >
                {x.beatmap !== null ? (
                  <MapRow
                    kind="plain"
                    stars={x.starRatingWithMods ?? x.beatmap.difficultyRating}
                    cover={coverUrl(x.beatmap.coverPath)}
                    title={`${x.beatmap.artist} — ${x.beatmap.title}`}
                    version={details(x)}
                    mod={x.mod}
                    slot={x.slotLabel}
                    checkbox
                    selected={picked.has(x.position)}
                    gripProps={reorder.handleProps(i)}
                    tools={slotTools(x)}
                    onToggleSelect={(shift) => togglePick(x.position, shift, false)}
                    onSweepSelect={(shift) => startSweep(x.position, shift)}
                    onClick={() => setPicking(x.position)}
                  />
                ) : (
                  <div
                    className={[s.empty, picked.has(x.position) ? s.emptyPicked : null]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <span
                      className={s.emptyGrip}
                      title="Потянуть, чтобы переставить"
                      {...reorder.handleProps(i)}
                    >
                      ⠿
                    </span>
                    <button
                      className={s.emptyCb}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        startSweep(x.position, e.shiftKey);
                      }}
                      type="button"
                      aria-pressed={picked.has(x.position)}
                      aria-label="Выделить слот"
                    >
                      ✓
                    </button>
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
                          accept(await ipc.setSlotsMod(p.id, [x.position], m)),
                        );
                      }}
                      disabled={m === 'TB' && p.slots.some((y) => y.mod === 'TB')}
                      {...(x.beatmap !== null && !x.beatmap.mods.includes(m)
                        ? { note: 'У карты нет этого тега' }
                        : {})}
                    >
                      {m === x.mod ? '✓ ' : '   '}
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
                      <span
                        key={w.text}
                        className={[s.warn, w.strict ? s.strict : null]
                          .filter(Boolean)
                          .join(' ')}
                        title={w.strict ? 'Строгое нарушение' : 'Мягкое нарушение'}
                      >
                        {w.strict ? '✕' : '⚠'} {w.text}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}

            <div className={s.addWrap}>
              <button
                className={s.addCard}
                onClick={() => addCard()}
                type="button"
                title={
                  p.slots.some((x) => x.beatmapId === null)
                    ? 'Подобрать карту в первый пустой слот'
                    : 'Свободных слотов нет — добавим новый'
                }
              >
                + Добавить карту
              </button>

              <Menu open={menu === 'addCard'} onClose={() => setMenu(null)} up>
                {MOD_TAGS.map((m) => (
                  <MenuItem
                    key={m}
                    onClick={() => void addSlotAndPick(m)}
                    disabled={m === 'TB' && p.slots.some((x) => x.mod === 'TB')}
                    {...(m === 'TB' ? { note: 'Тайбрейк, всегда последний и один' } : {})}
                  >
                    Слот {m}
                  </MenuItem>
                ))}
              </Menu>
            </div>
          </div>
        </div>

        {picked.size > 1 ? (
          <div className={s.bulk}>
            <span className={s.bulkCount}>выделено {slotsWord(picked.size)}</span>

            {p.templateId !== null ? (
              <Button size="sm" onClick={() => void rollSlots(positions)} disabled={busy}>
                ↻ Перекатить
              </Button>
            ) : null}

            <div className={s.wrap}>
              <Button size="sm" onClick={() => setMenu(menu === 'bulkMod' ? null : 'bulkMod')}>
                Мод ▾
              </Button>
              <Menu open={menu === 'bulkMod'} onClose={() => setMenu(null)} up>
                {MOD_TAGS.filter((m) => m !== 'TB').map((m) => (
                  <MenuItem
                    key={m}
                    onClick={() => {
                      setMenu(null);
                      void guard(async () => {
                        accept(await ipc.setSlotsMod(p.id, positions, m));
                        setPicked(new Set());
                      });
                    }}
                  >
                    {m}
                  </MenuItem>
                ))}
              </Menu>
            </div>

            <div className={s.wrap}>
              <Button size="sm" onClick={() => setMenu(menu === 'bulkSrc' ? null : 'bulkSrc')}>
                Источник ▾
              </Button>
              <Menu open={menu === 'bulkSrc'} onClose={() => setMenu(null)} up>
                <MenuItem
                  onClick={() => {
                    setMenu(null);
                    void guard(async () =>
                      accept(await ipc.setSlotsSources(p.id, positions, null)),
                    );
                  }}
                  note="Слоты снова возьмут источники пула"
                >
                  Наследовать
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  onClick={() => {
                    setMenu(null);
                    void guard(async () =>
                      accept(
                        await ipc.setSlotsSources(p.id, positions, {
                          items: [{ kind: 'library' }],
                          mode: 'union',
                        }),
                      ),
                    );
                  }}
                >
                  Вся библиотека
                </MenuItem>
              </Menu>
            </div>

            <Button
              size="sm"
              onClick={() =>
                void guard(async () => accept(await ipc.setSlotsPinned(p.id, positions, true)))
              }
            >
              Закрепить
            </Button>
            <Button
              size="sm"
              onClick={() =>
                void guard(async () => accept(await ipc.setSlotsPinned(p.id, positions, false)))
              }
            >
              Открепить
            </Button>

            <button
              className={s.bulkX}
              onClick={() =>
                void guard(async () => {
                  accept(await ipc.removePoolSlots(p.id, positions));
                  setPicked(new Set());
                })
              }
              type="button"
            >
              Убрать
            </button>

            <button className={s.bulkClear} onClick={() => setPicked(new Set())} type="button">
              Снять выделение
            </button>
          </div>
        ) : null}
      </div>

      {panel && whence !== null ? (
        <Whence
          poolId={p.id}
          whence={whence}
          picked={pickedMaps}
          onChanged={() => load(p.id)}
        />
      ) : null}

      {slot !== null ? (
        <Picker
          poolId={p.id}
          slot={slot}
          taken={taken}
          onClose={() => setPicking(null)}
          onImport={() => go('downloads')}
          onPick={(m: Beatmap) => {
            setPicking(null);
            void guard(async () =>
              accept(await ipc.setSlotBeatmap(p.id, slot.position, m.beatmapId)),
            );
          }}
        />
      ) : null}
    </div>
  );
}
