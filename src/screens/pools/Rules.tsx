import { useEffect, useState } from 'react';
import { Button, Chip, Menu, MenuItem, MenuSeparator, Switch } from '@/components';
import {
  type EffectiveSources,
  type Exclusion,
  type ExclusionOwner,
  type ExclusionTarget,
  type GenRules,
  type Player,
  type Series,
  type Source,
  type SourceSet,
  type Tournament,
} from '@/lib/types';
import { filterSummary, sourceName } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import { useApp } from '@/store/app';
import s from './Rules.module.css';

// ─────────────────────────────────────────────────────────── источники

interface SourcesProps {
  /** Свои источники уровня. `null` — наследует верхний. */
  set: SourceSet | null;
  /** Что применяется на самом деле и откуда пришло. Есть только у пула. */
  effective?: EffectiveSources;
  onChange: (next: SourceSet | null) => void;
}

/**
 * Откуда брать карты. Пустой список — наследование: уровень ничего не задаёт,
 * и это видно подписью, а не догадкой.
 */
export function SourcesBlock({ set, effective, onChange }: SourcesProps) {
  const { collections, filter } = useApp();
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);

  const own = set?.items ?? [];
  const mode = set?.mode ?? 'union';
  const shown = own.length > 0 ? own : (effective?.items.map((i) => i.source) ?? []);
  const inherited = own.length === 0;
  // «Вся библиотека» и так стоит единственной строкой списка — вторая такая же
  // подпись сверху ничего не добавляет.
  const origin = effective?.origin ?? 'вся библиотека';
  const sayOrigin = inherited && origin !== 'вся библиотека';

  function put(items: Source[], nextMode = mode) {
    onChange(items.length === 0 ? null : { items, mode: nextMode });
  }

  function add(src: Source) {
    setAdding(false);
    setPicking(false);
    // Один и тот же источник дважды ничего не добавит, кроме путаницы.
    if (own.some((x) => same(x, src))) return;
    put([...own, src]);
  }

  /** Число карт источника: точное из панели, иначе счётчик коллекции. */
  function count(src: Source): number | null {
    const exact = effective?.items.find((i) => same(i.source, src));
    if (exact !== undefined) return exact.count;
    if (src.kind === 'collection') {
      return collections.find((c) => c.id === src.id)?.count ?? null;
    }
    return null;
  }

  return (
    <section className={s.block}>
      <header className={s.head}>
        <h4 className={s.h4}>Источники</h4>
        {own.length > 1 ? (
          <button
            className={s.mode}
            onClick={() => put(own, mode === 'union' ? 'ordered' : 'union')}
            type="button"
            title={
              mode === 'union'
                ? 'Сейчас все источники сливаются в один набор'
                : 'Сейчас берём из первого, чего не хватило — из следующего'
            }
          >
            {mode === 'union' ? 'объединять' : 'по приоритету'} ▾
          </button>
        ) : null}
      </header>

      {sayOrigin ? <div className={s.from}>{origin}</div> : null}

      <div className={s.list}>
        {shown.map((src, i) => {
          const n = count(src);
          const missing = effective?.items.find((x) => same(x.source, src))?.missing === true;
          return (
            <div
              key={`${src.kind}-${i}`}
              className={[s.item, inherited ? s.dim : null].filter(Boolean).join(' ')}
            >
              {mode === 'ordered' && !inherited ? (
                <span className={s.rank}>{i + 1}</span>
              ) : null}
              <span className={s.itemName}>{sourceName(src, collections)}</span>
              {missing ? <span className={s.gone}>нет</span> : null}
              {n !== null ? <span className={s.num}>{n}</span> : null}
              {inherited ? null : (
                <button
                  className={s.x}
                  onClick={() => put(own.filter((_, j) => j !== i))}
                  type="button"
                  aria-label="Убрать источник"
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className={s.addWrap}>
        <button className={s.add} onClick={() => setAdding(true)} type="button">
          + Источник
        </button>

        <Menu open={adding} onClose={() => setAdding(false)}>
          <MenuItem onClick={() => add({ kind: 'library' })}>Вся библиотека</MenuItem>
          <MenuItem
            onClick={() => {
              setAdding(false);
              setPicking(true);
            }}
            disabled={collections.length === 0}
            {...(collections.length === 0 ? { note: 'Коллекций пока нет' } : {})}
          >
            Коллекция…
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            onClick={() => add({ kind: 'filter', filter: { ...filter, collectionId: null } })}
            note={filterSummary(filter)}
          >
            Текущий фильтр библиотеки
          </MenuItem>
        </Menu>

        <Menu open={picking} onClose={() => setPicking(false)}>
          {collections.map((c) => (
            <MenuItem
              key={c.id}
              onClick={() => add({ kind: 'collection', id: c.id })}
              note={c.isSmart ? 'умная' : `${c.count}`}
            >
              {c.name}
            </MenuItem>
          ))}
        </Menu>
      </div>
    </section>
  );
}

function same(a: Source, b: Source): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'collection' && b.kind === 'collection') return a.id === b.id;
  if (a.kind === 'filter' && b.kind === 'filter') {
    return JSON.stringify(a.filter) === JSON.stringify(b.filter);
  }
  return true;
}

// ────────────────────────────────────────────────────────── исключения

interface ExclusionsProps {
  owner: ExclusionOwner;
  ownerId: number;
  /** Унаследованные и свои вместе — как их отдаёт база. */
  items: Exclusion[];
  /** Карты, отобранные руками: из них делается исключение «эти карты». */
  picked?: number[];
  onChanged: () => void | Promise<void>;
}

/** Что исключение может запрещать. Порядок — как в меню «+ Исключение». */
const KIND_NAMES: { kind: string; label: string; note?: string }[] = [
  { kind: 'pool', label: 'Маппул' },
  { kind: 'series', label: 'Серия' },
  { kind: 'tournament', label: 'Турнир', note: 'Всё, что там играли' },
  { kind: 'recentTournaments', label: 'Последние N турниров' },
  { kind: 'playedBy', label: 'Карты игрока', note: 'Что он уже играл' },
  { kind: 'mapper', label: 'Маппер' },
  { kind: 'beatmaps', label: 'Отобранные карты' },
  { kind: 'sameMapperInside', label: 'Два пула одного маппера' },
];

export function ExclusionsBlock({ owner, ownerId, items, picked, onChanged }: ExclusionsProps) {
  const [adding, setAdding] = useState(false);
  const [list, setList] = useState<string | null>(null);
  const [pools, setPools] = useState<{ id: number; name: string }[]>([]);
  const [series, setSeries] = useState<Series[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);

  // Списки целей тянем один раз при первом открытии меню: держать их
  // в памяти всегда незачем, а спрашивать при каждом клике — медленно.
  useEffect(() => {
    if (!adding || pools.length + series.length + tournaments.length > 0) return;
    void (async () => {
      const [p, se, tr, pl] = await Promise.all([
        ipc.listPools(),
        ipc.listSeries(),
        ipc.listTournaments(),
        ipc.listPlayers(),
      ]);
      setPools(p.map((x) => ({ id: x.id, name: x.name })));
      setSeries(se);
      setTournaments(tr);
      setPlayers(pl);
    })();
  }, [adding, pools.length, series.length, tournaments.length]);

  async function add(target: ExclusionTarget, strict = true) {
    setAdding(false);
    setList(null);
    await ipc.addExclusion(owner, ownerId, target, strict);
    await onChanged();
  }

  function begin(kind: string) {
    setAdding(false);

    if (kind === 'sameMapperInside') {
      void add({ kind: 'sameMapperInside' });
      return;
    }
    if (kind === 'recentTournaments') {
      const raw = window.prompt('Не брать карты из последних N турниров', '3');
      if (raw === null) return;
      const count = Number(raw.trim());
      if (!Number.isFinite(count) || count < 1) return;
      void add({ kind: 'recentTournaments', count });
      return;
    }
    if (kind === 'mapper') {
      const name = window.prompt('Ник маппера');
      if (name === null || name.trim() === '') return;
      void add({ kind: 'mapper', name: name.trim() });
      return;
    }
    if (kind === 'beatmaps') {
      if (picked === undefined || picked.length === 0) return;
      void add({ kind: 'beatmaps', ids: picked });
      return;
    }
    setList(kind);
  }

  const inherited = items.filter((x) => x.inheritedFrom !== null);
  const mine = items.filter((x) => x.inheritedFrom === null);

  const row = (x: Exclusion) => (
    <div
      key={x.id}
      className={[
        s.item,
        x.inheritedFrom !== null ? s.dim : null,
        !x.enabled ? s.offItem : null,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className={s.itemName} title={x.inheritedFrom ?? undefined}>
        {x.label}
      </span>

      {x.missing ? (
        <span className={s.gone} title="Цель удалена — правило не применяется">
          цели нет
        </span>
      ) : null}

      {x.inheritedFrom !== null ? (
        <span className={s.strictDim}>{x.strict ? 'строго' : 'мягко'}</span>
      ) : (
        <button
          className={[s.strict, x.strict ? s.hard : null].filter(Boolean).join(' ')}
          onClick={() =>
            void ipc.setExclusionStrict(x.id, !x.strict).then(() => onChanged())
          }
          type="button"
          title={
            x.strict
              ? 'Строго: слот останется пустым'
              : 'По возможности: слот заполнится, а нарушение попадёт в отчёт'
          }
        >
          {x.strict ? 'строго' : 'мягко'}
        </button>
      )}

      {x.cut > 0 ? <span className={s.cut}>−{x.cut}</span> : null}

      {x.inheritedFrom !== null ? null : (
        <>
          <button
            className={[s.eye, x.enabled ? null : s.eyeOff].filter(Boolean).join(' ')}
            onClick={() =>
              void ipc.setExclusionEnabled(x.id, !x.enabled).then(() => onChanged())
            }
            type="button"
            title={x.enabled ? 'Выключить, не удаляя' : 'Включить обратно'}
          >
            {x.enabled ? '◉' : '◌'}
          </button>
          <button
            className={s.x}
            onClick={() => void ipc.removeExclusion(x.id).then(() => onChanged())}
            type="button"
            aria-label="Убрать исключение"
          >
            ✕
          </button>
        </>
      )}
    </div>
  );

  return (
    <section className={s.block}>
      <header className={s.head}>
        <h4 className={s.h4}>Исключения</h4>
      </header>

      <div className={s.list}>
        {inherited.map(row)}
        {mine.map(row)}
        {items.length === 0 ? <div className={s.none}>ничего не исключаем</div> : null}
      </div>

      <div className={s.addWrap}>
        <button className={s.add} onClick={() => setAdding(true)} type="button">
          + Исключение
        </button>

        <Menu open={adding} onClose={() => setAdding(false)}>
          {KIND_NAMES.map((k) => (
            <MenuItem
              key={k.kind}
              onClick={() => begin(k.kind)}
              disabled={k.kind === 'beatmaps' && (picked === undefined || picked.length === 0)}
              {...(k.kind === 'beatmaps'
                ? {
                    note:
                      picked !== undefined && picked.length > 0
                        ? `выделено ${picked.length}`
                        : 'Сначала выдели слоты',
                  }
                : k.note !== undefined
                  ? { note: k.note }
                  : {})}
            >
              {k.label}
            </MenuItem>
          ))}
        </Menu>

        <Menu open={list === 'pool'} onClose={() => setList(null)}>
          {pools.map((p) => (
            <MenuItem key={p.id} onClick={() => void add({ kind: 'pool', id: p.id })}>
              {p.name}
            </MenuItem>
          ))}
        </Menu>

        <Menu open={list === 'series'} onClose={() => setList(null)}>
          {series.map((x) => (
            <MenuItem
              key={x.id}
              onClick={() => void add({ kind: 'series', id: x.id })}
              note={`${x.pools.length}`}
            >
              {x.name}
            </MenuItem>
          ))}
        </Menu>

        <Menu open={list === 'tournament'} onClose={() => setList(null)}>
          {tournaments.map((x) => (
            <MenuItem key={x.id} onClick={() => void add({ kind: 'tournament', id: x.id })}>
              {x.name}
            </MenuItem>
          ))}
        </Menu>

        <Menu open={list === 'playedBy'} onClose={() => setList(null)}>
          {players.map((x) => (
            <MenuItem
              key={x.id}
              onClick={() => void add({ kind: 'playedBy', playerId: x.id })}
            >
              {x.nickname}
            </MenuItem>
          ))}
        </Menu>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────── правила

interface RulesProps {
  rules: GenRules;
  onChange: (next: GenRules) => void;
  /** Правила приходят от шаблона — править их здесь нельзя. */
  readOnly?: boolean;
  origin?: string;
}

/** Переключатель строгости рядом с правилом. */
function Strict({
  on,
  onChange,
  disabled,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      className={[s.strict, on ? s.hard : null].filter(Boolean).join(' ')}
      onClick={() => onChange(!on)}
      type="button"
      disabled={disabled === true}
      title={
        on
          ? 'Строго: слот останется пустым'
          : 'По возможности: слот заполнится, а нарушение попадёт в отчёт'
      }
    >
      {on ? 'строго' : 'мягко'}
    </button>
  );
}

export function RulesBlock({ rules, onChange, readOnly, origin }: RulesProps) {
  const lock = readOnly === true;
  const set = (patch: Partial<GenRules>) => onChange({ ...rules, ...patch });

  const line = (
    active: boolean,
    strict: boolean,
    onStrict: (next: boolean) => void,
    body: React.ReactNode,
  ) => (
    <div className={s.rule}>
      <div className={s.ruleBody}>{body}</div>
      {active ? <Strict on={strict} onChange={onStrict} disabled={lock} /> : null}
    </div>
  );

  return (
    <section className={s.block}>
      <header className={s.head}>
        <h4 className={s.h4}>Правила</h4>
      </header>

      {origin !== undefined ? <div className={s.from}>{origin}</div> : null}

      {line(
        rules.rankedOnly,
        rules.rankedOnlyStrict,
        (v) => set({ rankedOnlyStrict: v }),
        <Switch
          checked={rules.rankedOnly}
          onChange={(v) => set({ rankedOnly: v })}
          disabled={lock}
        >
          Только ranked
        </Switch>,
      )}

      {line(
        rules.balanceSkillsets,
        rules.balanceSkillsetsStrict,
        (v) => set({ balanceSkillsetsStrict: v }),
        <Switch
          checked={rules.balanceSkillsets}
          onChange={(v) => set({ balanceSkillsets: v })}
          note="Поровну aim и speed, насколько хватит карт"
          disabled={lock}
        >
          Держать баланс aim / speed
        </Switch>,
      )}

      {line(
        rules.minBpmSpread !== null,
        rules.minBpmSpreadStrict,
        (v) => set({ minBpmSpreadStrict: v }),
        <>
          <Switch
            checked={rules.minBpmSpread !== null}
            onChange={(v) => set({ minBpmSpread: v ? 40 : null })}
            note="Чтобы весь пул не оказался в одном темпе"
            disabled={lock}
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
                onChange={(e) => set({ minBpmSpread: Number(e.target.value) })}
                disabled={lock}
                aria-label="Минимальный разброс BPM"
              />
              <span className={s.unit}>BPM</span>
            </div>
          ) : null}
        </>,
      )}

      {line(
        rules.lengthMax !== null,
        rules.lengthMaxStrict,
        (v) => set({ lengthMaxStrict: v }),
        <>
          <Switch
            checked={rules.lengthMax !== null}
            onChange={(v) => set({ lengthMax: v ? 300 : null })}
            disabled={lock}
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
                onChange={(e) => set({ lengthMax: Number(e.target.value) })}
                disabled={lock}
                aria-label="Максимальная длина карты в секундах"
              />
              <span className={s.unit}>секунд</span>
            </div>
          ) : null}
        </>,
      )}
    </section>
  );
}

// ───────────────────────────────────────────── правила серии одним окном

interface SeriesRulesProps {
  series: Series;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}

/** Источники и исключения серии: то, что действует на все её пулы. */
export function SeriesRules({ series, onClose, onChanged }: SeriesRulesProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function guard(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
      setError(null);
      await onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={s.sheet}>
      <header className={s.sheetHead}>
        <h3 className={s.sheetTitle}>Правила серии «{series.name}»</h3>
        <Button size="sm" onClick={onClose}>
          Готово
        </Button>
      </header>

      {error !== null ? <div className={s.error}>{error}</div> : null}

      <div className={s.sheetBody}>
        <SourcesBlock
          set={series.sources}
          onChange={(next) => void guard(async () => void (await ipc.setSeriesSources(series.id, next)))}
        />

        <ExclusionsBlock
          owner="series"
          ownerId={series.id}
          items={series.exclusions}
          onChanged={onChanged}
        />

        <section className={s.block}>
          <header className={s.head}>
            <h4 className={s.h4}>Тип</h4>
          </header>

          <div className={s.kinds}>
            <Chip
              active={series.kind === 'tournament'}
              onClick={() =>
                void guard(async () => {
                  const clashes = await ipc.setSeriesKind(series.id, 'tournament');
                  if (clashes.length > 0) {
                    setError(
                      `Тип не сменился: карты повторяются в ${clashes
                        .map((c) => c.pools.join(' и '))
                        .join(', ')}. Перекатай повторы и попробуй снова.`,
                    );
                  }
                })
              }
              title="Маппулы по одному на раунд, карты внутри не повторяются"
            >
              турнирная
            </Chip>
            <Chip
              active={series.kind === 'free'}
              onClick={() => void guard(async () => void (await ipc.setSeriesKind(series.id, 'free')))}
              title="Группировка без правил: архив сезона, любимые пулы"
            >
              свободная
            </Chip>
          </div>

          <Switch
            checked={series.noRepeatInside}
            onChange={(v) =>
              void guard(async () => {
                const clashes = await ipc.setSeriesNoRepeat(series.id, v);
                if (clashes.length > 0) {
                  setError(
                    `Правило не включилось: карты повторяются в ${clashes
                      .map((c) => c.pools.join(' и '))
                      .join(', ')}.`,
                  );
                }
              })
            }
            disabled={series.kind === 'tournament' || busy}
            note={
              series.kind === 'tournament'
                ? 'У турнирной серии это и есть смысл — выключить нельзя'
                : undefined
            }
          >
            Карты не повторяются между пулами
          </Switch>
        </section>
      </div>
    </div>
  );
}
