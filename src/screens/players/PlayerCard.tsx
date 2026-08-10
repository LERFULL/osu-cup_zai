import { useCallback, useEffect, useState } from 'react';
import { Button, Chip, Empty, Field } from '@/components';
import type { Player, PlayerStats } from '@/lib/types';
import * as ipc from '@/lib/ipc';
import s from './PlayerCard.module.css';

interface Props {
  id: number;
  onClose: () => void;
}

/** Та же палитра, что раздаёт база новым игрокам, — цвета из токенов. */
const PALETTE = [
  '#ff6fb1',
  '#5bc8f5',
  '#7ed957',
  '#ffd03b',
  '#c77dff',
  '#ff6b6b',
  '#4dd6c1',
  '#f7913d',
];

/** Доля побед в процентах. Без сыгранного показываем прочерк. */
function rate(won: number, total: number): string {
  if (total === 0) return '—';
  return `${Math.round((won / total) * 100)}%`;
}

export function PlayerCard({ id, onClose }: Props) {
  const [player, setPlayer] = useState<Player | null>(null);
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Черновик правок: пишем в базу по кнопке, а не на каждое нажатие клавиши.
  const [nickname, setNickname] = useState('');
  const [osuId, setOsuId] = useState('');
  const [note, setNote] = useState('');
  const [color, setColor] = useState('');

  const reload = useCallback(async () => {
    try {
      const [p, st] = await Promise.all([ipc.getPlayer(id), ipc.playerStats(id)]);
      if (p === null) {
        setError('Игрок не найден');
        return;
      }
      setPlayer(p);
      setStats(st);
      setNickname(p.nickname);
      setOsuId(p.osuUserId === null ? '' : String(p.osuUserId));
      setNote(p.note ?? '');
      setColor(p.color);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function save() {
    const trimmed = osuId.trim();
    try {
      await ipc.updatePlayer(
        id,
        nickname,
        trimmed === '' ? null : Number(trimmed),
        color,
        note.trim() === '' ? null : note,
      );
      await reload();
    } catch (e) {
      setError(String(e));
    }
  }

  if (player === null) {
    return (
      <div className={s.screen}>
        <div className={s.bar}>
          <button className={s.back} onClick={onClose} type="button">
            ← Игроки
          </button>
        </div>
        <div className={s.body}>
          <Empty title={error ?? 'Читаю игрока…'} />
        </div>
      </div>
    );
  }

  const dirty =
    nickname !== player.nickname ||
    color !== player.color ||
    (note.trim() === '' ? null : note) !== player.note ||
    (osuId.trim() === '' ? null : Number(osuId.trim())) !== player.osuUserId;

  return (
    <div className={s.screen}>
      <div className={s.bar}>
        <button className={s.back} onClick={onClose} type="button">
          ← Игроки
        </button>
        <span className={s.dot} style={{ background: player.color }} aria-hidden />
        <h1 className={s.h1}>{player.nickname}</h1>
        {player.isArchived && <span className={s.tag}>в архиве</span>}
        <div className={s.right}>
          <Button variant="primary" disabled={!dirty} onClick={() => void save()}>
            Сохранить
          </Button>
        </div>
      </div>

      {error !== null && <div className={s.error}>{error}</div>}

      <div className={s.body}>
        <div className={s.cols}>
          <section className={s.block}>
            <div className={s.blockTitle}>Профиль</div>

            <Field
              label="Ник"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
            />
            <Field
              label="ID профиля osu!"
              hint="Необязательно — нужен, чтобы подтянуть аватар"
              value={osuId}
              inputMode="numeric"
              onChange={(e) => setOsuId(e.target.value.replace(/\D/g, ''))}
            />
            <Field label="Заметка" value={note} onChange={(e) => setNote(e.target.value)} />

            <div className={s.colorRow}>
              <span className={s.label}>Цвет</span>
              <div className={s.swatches}>
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    className={color.toLowerCase() === c.toLowerCase() ? s.swatchOn : s.swatch}
                    style={{ background: c }}
                    onClick={() => setColor(c)}
                    type="button"
                    aria-label={`Цвет ${c}`}
                  />
                ))}
              </div>
            </div>
          </section>

          <section className={s.block}>
            <div className={s.blockTitle}>Всего</div>

            {stats === null ? null : (
              <>
                <div className={s.stats}>
                  <div className={s.stat}>
                    <span className={s.statValue}>{stats.tournaments}</span>
                    <span className={s.statLabel}>турниров</span>
                  </div>
                  <div className={s.stat}>
                    <span className={s.statValue}>{stats.tournamentWins}</span>
                    <span className={s.statLabel}>побед в них</span>
                  </div>
                  <div className={s.stat}>
                    <span className={s.statValue}>
                      {stats.matchWins}
                      <span className={s.of}>/{stats.matches}</span>
                    </span>
                    <span className={s.statLabel}>матчи · {rate(stats.matchWins, stats.matches)}</span>
                  </div>
                  <div className={s.stat}>
                    <span className={s.statValue}>
                      {stats.mapWins}
                      <span className={s.of}>/{stats.maps}</span>
                    </span>
                    <span className={s.statLabel}>карты · {rate(stats.mapWins, stats.maps)}</span>
                  </div>
                </div>

                {(stats.bestMod !== null || stats.worstMod !== null) && (
                  <div className={s.mods}>
                    {stats.bestMod !== null && (
                      <Chip title="Чаще всего забирает эти карты">
                        сильный мод: {stats.bestMod}
                      </Chip>
                    )}
                    {stats.worstMod !== null && (
                      <Chip title="Здесь проигрывает чаще прочего">
                        слабый мод: {stats.worstMod}
                      </Chip>
                    )}
                  </div>
                )}

                {stats.placements.length > 0 && (
                  <div className={s.places}>
                    <span className={s.label}>Места</span>
                    <span className={s.placeList}>{stats.placements.join(' · ')}</span>
                  </div>
                )}
              </>
            )}
          </section>
        </div>

        <section className={s.block}>
          <div className={s.blockTitle}>Личные счёты</div>
          {stats === null || stats.versus.length === 0 ? (
            <div className={s.muted}>Ещё ни с кем не играл.</div>
          ) : (
            <div className={s.versus}>
              {stats.versus.map((v) => (
                <div key={v.playerId} className={s.vrow}>
                  <span className={s.vname}>{v.nickname}</span>
                  <span className={s.vscore}>
                    {v.wins} : {v.losses}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
