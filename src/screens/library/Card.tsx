import { useEffect, useState, type ReactNode } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button, Chip, Hex, Panel } from '@/components';
import { MOD_TAGS, SKILLSETS, type Beatmap, type ModTag, type Skillset } from '@/lib/types';
import { CARD_MODS, derive, modsFor } from '@/lib/derive';
import { coverUrl, formatLength, formatStars } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import s from './Card.module.css';

interface Props {
  beatmapId: number;
  onClose: () => void;
  onChanged: (map: Beatmap) => void;
}

/** Карточка карты: всё, что о ней известно, и всё, что в ней можно править. */
export function Card({ beatmapId, onClose, onChanged }: Props) {
  const [map, setMap] = useState<Beatmap | null>(null);
  const [siblings, setSiblings] = useState<Beatmap[]>([]);
  const [mod, setMod] = useState<ModTag>('NM');
  const [note, setNote] = useState('');

  useEffect(() => {
    let alive = true;
    setMap(null);
    setSiblings([]);

    void ipc.getBeatmap(beatmapId).then((m) => {
      if (!alive || !m) return;
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

  if (!map) {
    return (
      <Panel title="Карта" onClose={onClose}>
        <div className={s.wait}>Читаю карту…</div>
      </Panel>
    );
  }

  const d = derive(map, modsFor(mod));
  const cover = coverUrl(map.coverPath);

  async function toggleMod(m: ModTag) {
    if (!map) return;
    const next = map.mods.includes(m) ? map.mods.filter((x) => x !== m) : [...map.mods, m];
    await ipc.setBeatmapMods(map.beatmapId, next as ModTag[]);
    const fresh = { ...map, mods: next };
    setMap(fresh);
    onChanged(fresh);
  }

  async function toggleSkill(k: Skillset) {
    if (!map) return;
    const own = map.skillsets.map((x) => x.skillset);
    const next = own.includes(k) ? own.filter((x) => x !== k) : [...own, k];
    await ipc.setBeatmapSkillsets(map.beatmapId, next as Skillset[]);
    const fresh = {
      ...map,
      skillsets: next.map((x) => ({ skillset: x, suggested: false })),
    };
    setMap(fresh);
    onChanged(fresh);
  }

  async function saveNote() {
    if (!map || note === (map.note ?? '')) return;
    await ipc.setBeatmapNote(map.beatmapId, note);
    const fresh = { ...map, note };
    setMap(fresh);
    onChanged(fresh);
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
            <Chip key={m} active={map.mods.includes(m)} onClick={() => void toggleMod(m)}>
              {m}
            </Chip>
          ))}
        </div>
      </Section>

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
                onClick={() => void toggleSkill(k)}
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
                <span className={s.diffName}>{x.version}</span>
                <span className={s.diffStars}>{formatStars(x.difficultyRating)}★</span>
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
          onBlur={() => void saveNote()}
        />
      </Section>

      <div className={s.actions}>
        <Button onClick={() => void openUrl(`https://osu.ppy.sh/b/${map.beatmapId}`)}>
          Открыть на osu! ↗
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
