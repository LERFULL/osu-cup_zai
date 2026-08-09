import type { ButtonHTMLAttributes, ReactNode } from 'react';
import s from './Button.module.css';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  icon?: ReactNode;
  children: ReactNode;
}

export function Button({
  variant = 'ghost',
  size = 'md',
  icon,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  const cls = [s.btn, s[variant], size === 'sm' ? s.sm : null, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={cls} type={type} {...rest}>
      {icon ? (
        <span className={s.icon} aria-hidden>
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  );
}
