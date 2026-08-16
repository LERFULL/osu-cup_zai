import s from './Avatar.module.css';

export interface AvatarProps {
  nickname: string;
  /** Цвет игрока: он же обводка кружка и фон подложки. */
  color: string;
  /** Путь к файлу аватара. `null` — покажем первую букву ника. */
  path?: string | null;
  /** Диаметр в пикселях. */
  size?: number;
  /** Готовый URL, если путь уже переведён вызывающим. */
  src?: string | null;
}

/**
 * Кружок игрока: аватар из профиля osu!, а без него — первая буква ника
 * на его цвете. Пустой серый круг ничего не сообщает, буква хотя бы
 * различает игроков.
 */
export function Avatar({ nickname, color, size = 40, src = null }: AvatarProps) {
  const box = { width: size, height: size, borderColor: color };

  if (src !== null && src !== '') {
    return <img className={s.avatar} style={box} src={src} alt="" />;
  }

  return (
    <span
      className={s.letter}
      style={{ ...box, background: color, fontSize: Math.round(size * 0.42) }}
      aria-hidden
    >
      {nickname.slice(0, 1).toUpperCase()}
    </span>
  );
}
