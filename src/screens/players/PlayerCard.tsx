import { useCallback, useEffect, useState } from 'react';
import { Button, Chip, Empty, Field } from '@/components';
import type { Player, PlayerStats } from '@/lib/types';
import { coverUrl } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import s from './PlayerCard.module.css';

interface Props {
  id: number;
  onClose: () => void;
}

/** Те же цвета, что раздаёт база: палитра, а дальше считаные по номеру.
 *  Менять только парой с `db/players.rs`. */
const PALETTE = ['#ff6fb1', '#5bc8f5', '#7ed957', '#ffd03b', '#c77dff', '#ff6b6b', '#4dd6c1', '#f7913d'];

/** Насыщенность и светлота по кругу: близкие оттенки расходятся ещё и по яркости. */
const TONES: [number, number][] = [
  [0.62, 0.66],
  [0.78, 0.58],
  [0.52, 0.74],
];

function colorAt(n: number): string {
  if (n < PALETTE.length) return PALETTE[n]!;

  // Золотое сечение по кругу оттенков: точки не сходятся в кучу даже на сотне.
  const step = n - PALETTE.length;
  const hue = (196 + step * 137.508) % 360;
  const [sat, light] = TONES[step % TONES.length]!;

  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];

  const hex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Сколько цветов показывать в карточке: палитра плюс запас на большой турнир. */
const SWATCHES = Array.from({ length: 24 }, (_, i) => colorAt(i));

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
  const [pulling, setPulling] = useState(false);

  // Выбор дубля для объединения: null — закрыто, список — открыт.
  const [mergeList, setMergeList] = useState<Player[] | null>(null);
  const [merging, setMerging] = useState<number | null>(null);

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

  /** Тянет аватар с osu!. ID должен быть уже сохранён — иначе тянуть нечего. */
  async function pullAvatar() {
    setPulling(true);
    try {
      const trimmed = osuId.trim();
      // Сохраняем ID заранее: иначе кнопка потянула бы аватар прошлого профиля.
      if (trimmed !== '' && Number(trimmed) !== player?.osuUserId) {
        await ipc.updatePlayer(
          id,
          nickname,
          Number(trimmed),
          color,
          note.trim() === '' ? null : note,
        );
      }
      await ipc.fetchPlayerAvatar(id);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setPulling(false);
    }
  }

  /** Открывает выбор дубля: все живые игроки, кроме самого себя. */
  async function pickMerge() {
    try {
      const list = await ipc.listPlayers(false);
      setMergeList(list.filter((p) => p.id !== id));
    } catch (e) {
      setError(String(e));
    }
  }

  /** Объединяет дубля с текущим игроком: матчи и статистика переезжают сюда. */
  async function doMerge(other: Player) {
    const ok = window.confirm(
      `Все матчи и статистика ${other.nickname} перейдут к ${player?.nickname ?? 'этому игроку'}, ${other.nickname} уйдёт в архив.`,
    );
    if (!ok) return;

    setMerging(other.id);
    try {
      await ipc.mergePlayers(id, other.id);
      setMergeList(null);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setMerging(null);
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
        {player.avatarPath !== null ? (
          <img
            className={s.barAvatar}
            src={coverUrl(player.avatarPath) ?? ''}
            alt=""
            style={{ borderColor: player.color }}
          />
        ) : (
          <span className={s.dot} style={{ background: player.color }} aria-hidden />
        )}
        <h1 className={s.h1}>{player.nickname}</h1>
        {player.isArchived && <span className={s.tag}>в архиве</span>}
        <div className={s.right}>
          <Button size="sm" onClick={() => void pickMerge()} title="Если этого же игрока завели дважды">
            Объединить с…
          </Button>
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

            <div className={s.osuRow}>
              <div className={s.osuField}>
                <Field
                  label="ID профиля osu!"
                  hint="Нужен, чтобы подтянуть аватар из профиля"
                  value={osuId}
                  inputMode="numeric"
                  onChange={(e) => setOsuId(e.target.value.replace(/\D/g, ''))}
                />
              </div>

              <div className={s.avatarBox}>
                {player.avatarPath !== null ? (
                  <img
                    className={s.avatar}
                    src={coverUrl(player.avatarPath) ?? ''}
                    alt=""
                    style={{ borderColor: player.color }}
                  />
                ) : (
                  <div className={s.avatarEmpty} style={{ borderColor: player.color }} aria-hidden>
                    {player.nickname.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <Button
                  size="sm"
                  disabled={osuId.trim() === '' || pulling}
                  onClick={() => void pullAvatar()}
                  title={
                    osuId.trim() === ''
                      ? 'Сначала укажи ID профиля'
                      : 'Скачать аватар из профиля osu!'
                  }
                >
                  {pulling ? 'Тяну…' : player.avatarPath !== null ? 'Обновить' : 'Подтянуть'}
                </Button>
              </div>
            </div>

            <Field label="Заметка" value={note} onChange={(e) => setNote(e.target.value)} />

            <div className={s.colorRow}>
              <span className={s.label}>Цвет</span>
              <div className={s.swatches}>
                {SWATCHES.map((c) => (
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
          <div className={s.blockTitle}>Как идут моды</div>
          {stats === null || stats.byMod.length === 0 ? (
            <div className={s.muted}>Ещё не сыграно ни одной карты.</div>
          ) : (
            <div className={s.bars}>
              {stats.byMod.map((m) => {
                const percent = m.played === 0 ? 0 : Math.round((m.won / m.played) * 100);
                return (
                  <div key={m.mod} className={s.bar}>
                    <span className={s.barMod} data-mod={m.mod}>
                      {m.mod}
                    </span>
                    <div className={s.barTrack}>
                      {/* Полоса — доля выигранных карт: сравнивать моды между
                          собой на глаз проще, чем читать проценты. */}
                      <div
                        className={s.barFill}
                        style={{ width: `${percent}%`, background: `var(--${m.mod.toLowerCase()})` }}
                      />
                    </div>
                    <span className={s.barValue}>
                      {m.won}/{m.played}
                      <span className={s.barPercent}>{percent}%</span>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className={s.block}>
          <div className={s.blockTitle}>Выступления</div>
          {stats === null || stats.history.length === 0 ? (
            <div className={s.muted}>Ещё не играл ни в одном турнире.</div>
          ) : (
            <div className={s.history}>
              {stats.history.map((h) => (
                <div key={h.tournamentId} className={s.hrow}>
                  <span
                    className={h.placement === 1 ? s.placeGold : s.place}
                    title={h.placement === null ? 'Турнир ещё идёт' : `Место ${h.placement}`}
                  >
                    {h.placement === null ? '—' : h.placement === 1 ? '♛' : h.placement}
                  </span>
                  <span className={s.hname}>{h.tournamentName}</span>
                  <span className={s.hscore}>
                    {h.matchWins}/{h.matches} матчей
                  </span>
                  <span className={s.hwhen}>
                    {h.finishedAt === null ? 'идёт' : h.finishedAt.slice(0, 10)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

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

      {/* Объединение дубля: выбор игрока и подтверждение. */}
      {mergeList !== null ? (
        <div className={s.mergeVeil} onClick={() => setMergeList(null)}>
          <div className={s.mergeCard} onClick={(e) => e.stopPropagation()}>
            <div className={s.mergeTitle}>Объединить с…</div>
            <p className={s.mergeHint}>
              Дубль исчезнет из списков, а его матчи и статистика перейдут к{' '}
              {player.nickname}.
            </p>

            <div className={s.mergeList}>
              {mergeList.length === 0 ? (
                <div className={s.mergeEmpty}>Других игроков нет.</div>
              ) : (
                mergeList.map((p) => (
                  <button
                    key={p.id}
                    className={s.mergeRow}
                    onClick={() => void doMerge(p)}
                    disabled={merging !== null}
                    type="button"
                  >
                    <span className={s.mergeDot} style={{ background: p.color }} aria-hidden />
                    <span className={s.mergeNick}>{p.nickname}</span>
                    {p.osuUserId !== null ? (
                      <span className={s.mergeOsu}>osu! {p.osuUserId}</span>
                    ) : null}
                    <span className={s.mergeGo}>{merging === p.id ? 'объединяю…' : '→'}</span>
                  </button>
                ))
              )}
            </div>

            <div className={s.mergeActions}>
              <Button size="sm" onClick={() => setMergeList(null)}>
                Отмена
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
