import s from './Tabs.module.css';

export interface TabsProps<T extends string> {
  items: readonly { id: T; label: string; count?: number }[];
  active: T;
  onSelect: (id: T) => void;
}

export function Tabs<T extends string>({ items, active, onSelect }: TabsProps<T>) {
  return (
    <div className={s.tabs} role="tablist">
      {items.map((t) => (
        <button
          key={t.id}
          className={[s.tab, t.id === active ? s.on : null].filter(Boolean).join(' ')}
          onClick={() => onSelect(t.id)}
          type="button"
          role="tab"
          aria-selected={t.id === active}
        >
          {t.label}
          {t.count !== undefined ? <span className={s.count}>{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
