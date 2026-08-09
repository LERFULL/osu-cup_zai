import { useEffect, useRef, useState, type ReactNode } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button, Chip, Hex, Panel } from '@/components';
import { MOD_TAGS, SKILLSETS, type Beatmap, type ModTag, type Skillset } from '@/lib/types';
import { CARD_MODS, FM_CHOICES, derive, modsFor } from '@/lib/derive';
import { coverUrl, formatLength, formatStars } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import s from './Card.module.css';

interface Props {
  beatmapId: number;
  onClose: () => void;
  onChanged: (map: Beatmap) => void;
  /** Карты убраны из библиотеки — список наверху пересобирается. */
  onDeleted: (beatmapIds: number[]) => void;
  /** Открыть другую сложность того же набора. */
  onOpen: (beatmapId: number) => void;
}

/** Карточка карты: всё, что о ней известно, и всё, что в ней можно править. */
export function Card({ beatmapId, onClose, onChanged, onDeleted, onOpen }: Props) {
  const [map, setMap] = useState<Beatmap | null>(null);
  const [siblings, setSiblings] = useState<Beatmap[]>([]);
  const [mod, setMod] = useState<ModTag>('NM');
  const [note, setNote] = useState('');
  const [failed, setFailed] = useState<string | null>(null);

  // Правки идут одна за другой; каждая должна считаться от последнего
  // состояния, а не от того, что было на момент отрисовки кнопки.
  const latest = useRef<Beatmap | null>(null);
  // Запись — по одной за раз и в порядке кликов: иначе два быстрых
  // переключения могут дойти до базы задом наперёд.
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    let alive = true;
    setMap(null);
    setSiblings([]);
    setFailed(null);
    latest.current = null;

    void ipc.getBeatmap(beatmapId).then((m) => {
      if (!alive || !m) return;
      latest.current = m;
      setMap(m);
      setNote(m.note ?? '');
      setMod((m.mods[0] as ModTag) ?? 'NM');
      if (m.beatmapsetId !== null) {
        void ipc.getSetDifficulties(m.beatmapsetId).then((list) => {
          if (alive) setSiblings(list);
        });
      }
    });

    return () => {
      alive = false;
    };
  }, [beatmapId]);

  /**
   * Считает новое состояние карты от последнего известного, сразу показывает
   * его и ставит запись в очередь. Не сохранилось — возвращаем как было.
   */
  function apply(change: (m: Beatmap) => Beatmap, save: (m: Beatmap) => Promise<void>) {
    const before = latest.current;
    if (!before) return;

    const next = change(before);
    latest.current = next;
    setMap(next);
    onChanged(next);

    chain.current = chain.current
      .then(() => save(next))
      .then(() => setFailed(null))
      .catch((e: unknown) => {
        latest.current = before;
        setMap(before);
        onChanged(before);
        setFailed(String(e));
      });
  }

  if (!map) {
    return (
      <Panel title="Карта" onClose={onClose}>
        <div className={s.wait}>Читаю карту…</div>
      </Panel>
    );
  }

  const d = derive(map, modsFor(mod));
  const cover = coverUrl(map.coverPath);

  function toggleMod(m: ModTag) {
    apply(
      (cur) => ({
        ...cur,
        mods: cur.mods.includes(m) ? cur.mods.filter((x) => x !== m) : [...cur.mods, m],
      }),
      (cur) => ipc.setBeatmapMods(cur.beatmapId, cur.mods),
    );
  }

  function toggleFm(m: string) {
    apply(
      (cur) => ({
        ...cur,
        fmMods: cur.fmMods.includes(m) ? cur.fmMods.filter((x) => x !== m) : [...cur.fmMods, m],
      }),
      (cur) => ipc.setBeatmapFmMods(cur.beatmapId, cur.fmMods),
    );
  }

  function toggleSkill(k: Skillset) {
    apply(
      (cur) => {
        const own = cur.skillsets.map((x) => x.skillset);
        const next = own.includes(k) ? own.filter((x) => x !== k) : [...own, k];
        // Проставленное руками перестаёт быть предложенным — так же и в базе.
        return { ...cur, skillsets: next.map((x) => ({ skillset: x, suggested: false })) };
      },
      (cur) => ipc.setBeatmapSkillsets(cur.beatmapId, cur.skillsets.map((x) => x.skillset)),
    );
  }

  /** Убрать эту карту. Карточке после этого показывать нечего — она закрывается. */
  async function removeThis() {
    if (!window.confirm(`Убрать «${map?.version}» из библиотеки?`)) return;
    try {
      await ipc.deleteBeatmaps([beatmapId]);
      onDeleted([beatmapId]);
      onClose();
    } catch (e) {
      setFailed(String(e));
    }
  }

  /** Убрать одну сложность набора. Если это открытая карта — закрываем панель. */
  async function removeSibling(x: Beatmap) {
    if (!window.confirm(`Убрать сложность «${x.version}» из библиотеки?`)) return;
    try {
      await ipc.deleteBeatmaps([x.beatmapId]);
      setSiblings((prev) => prev.filter((y) => y.beatmapId !== x.beatmapId));
      onDeleted([x.beatmapId]);
      if (x.beatmapId === beatmapId) onClose();
    } catch (e) {
      setFailed(String(e));
    }
  }

  function saveNote() {
    const cur = latest.current;
    if (!cur || note === (cur.note ?? '')) return;
    apply(
      (m) => ({ ...m, note }),
      (m) => ipc.setBeatmapNote(m.beatmapId, m.note ?? ''),
    );
  }

  return (
    <Panel title={map.title} subtitle={map.artist} onClose={onClose}>
      <div className={s.hero}>
        {cover ? <img className={s.cover} src={cover} alt="" /> : <div className={s.noCover} />}
        <div className={s.heroText}>
          <div className={s.diff}>{map.version}</div>
          <div className={s.by}>{map.creator ?? 'маппер неизвестен'}</div>
        </div>
      </div>

      <div className={s.modsRow}>
        {CARD_MODS.map((m) => (
          <button
            key={m}
            className={[s.modBtn, mod === m ? s.modOn : null].filter(Boolean).join(' ')}
            onClick={() => setMod(m)}
            type="button"
          >
            <Hex mod={m} size="sm" dim={mod !== m} />
          </button>
        ))}
      </div>

      <div className={s.stats}>
        <Stat label="Звёзды" value={formatStars(map.difficultyRating)} accent />
        <Stat label="Длина" value={formatLength(d.totalLength)} />
        <Stat label="BPM" value={d.bpm === null ? '—' : String(d.bpm)} />
        <Stat label="AR" value={num(d.ar)} />
        <Stat label="OD" value={num(d.od)} />
        <Stat label="CS" value={num(d.cs)} />
        <Stat label="HP" value={num(d.hp)} />
        <Stat label="Комбо" value={map.maxCombo === null ? '—' : String(map.maxCombo)} />
      </div>

      {mod !== 'NM' && mod !== 'HD' ? (
        <div className={s.hint}>Значения показаны под модом {mod}. Звёзды — без мода.</div>
      ) : null}

      <Section title="Мод-теги">
        <div className={s.chips}>
          {MOD_TAGS.map((m) => (
            <Chip key={m} active={map.mods.includes(m)} onClick={() => toggleMod(m)}>
              {m}
            </Chip>
          ))}
        </div>
      </Section>

      {map.mods.includes('FM') ? (
        <Section title="Разрешено на FM">
          <div className={s.chips}>
            {FM_CHOICES.map((m) => (
              <Chip key={m} active={map.fmMods.includes(m)} onClick={() => toggleFm(m)}>
                {m}
              </Chip>
            ))}
          </div>
          <div className={s.hint}>
            {map.fmMods.length === 0
              ? 'Ничего не отмечено — на этой карте можно брать любой мод.'
              : `Игрок выбирает из отмеченных: ${map.fmMods.join(', ')}.`}
          </div>
        </Section>
      ) : null}

      <Section title="Скилсеты">
        <div className={s.chips}>
          {SKILLSETS.map((k) => {
            const own = map.skillsets.find((x) => x.skillset === k);
            const auto = own?.suggested === true;
            return (
              <Chip
                key={k}
                active={own !== undefined}
                color={auto ? 'var(--cyan)' : 'var(--pink)'}
                {...(auto ? { title: 'Проставлено автоматически' } : {})}
                onClick={() => toggleSkill(k)}
              >
                {k}
              </Chip>
            );
          })}
        </div>
      </Section>

      {siblings.length > 1 ? (
        <Section title="Сложности набора">
          <div className={s.diffs}>
            {siblings.map((x) => (
              <div
                key={x.beatmapId}
                className={[s.diffRow, x.beatmapId === map.beatmapId ? s.diffOn : null]
                  .filter(Boolean)
                  .join(' ')}
              >
                <button
                  className={s.diffOpen}
                  onClick={() => onOpen(x.beatmapId)}
                  type="button"
                  disabled={x.beatmapId === map.beatmapId}
                >
                  <span className={s.diffName}>{x.version}</span>
                  <span className={s.diffStars}>{formatStars(x.difficultyRating)}★</span>
                </button>
                <button
                  className={s.diffX}
                  onClick={() => void removeSibling(x)}
                  type="button"
                  aria-label={`Убрать сложность ${x.version}`}
                  title="Убрать из библиотеки"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Заметка">
        <textarea
          className={s.note}
          value={note}
          rows={3}
          placeholder="Например: играли в финале прошлого кубка"
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
        />
      </Section>

      {failed !== null ? <div className={s.failed}>Не сохранилось: {failed}</div> : null}

      <div className={s.actions}>
        <Button onClick={() => void openUrl(`https://osu.ppy.sh/b/${map.beatmapId}`)}>
          Открыть на osu! ↗
        </Button>
        <Button variant="danger" onClick={() => void removeThis()}>
          Убрать из библиотеки
        </Button>
      </div>
    </Panel>
  );
}

function num(v: number | null): string {
  return v === null ? '—' : v.toFixed(1);
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={s.stat}>
      <div className={s.statLabel}>{label}</div>
      <div className={[s.statValue, accent === true ? s.statAccent : null].filter(Boolean).join(' ')}>
        {value}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={s.section}>
      <div className={s.sectionTitle}>{title}</div>
      {children}
    </section>
  );
}
