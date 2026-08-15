import { useState } from 'react';
import type { PoolWhence, SlotSupply } from '@/lib/types';
import { maps } from '@/lib/format';
import * as ipc from '@/lib/ipc';
import { useApp } from '@/store/app';
import { ExclusionsBlock, RulesBlock, SourcesBlock } from './Rules';
import s from './Whence.module.css';

interface Props {
  poolId: number;
  whence: PoolWhence;
  /** Карты выделенных слотов — из них делается исключение «эти карты». */
  picked: number[];
  onChanged: () => void | Promise<void>;
}

/**
 * Панель «Откуда берём». Не всплывающее окно, а фиксированная колонка справа:
 * к ней возвращаются постоянно, а окно закрывало бы то, что настраивают.
 */
export function Whence({ poolId, whence, picked, onChanged }: Props) {
  const { setFilter, go } = useApp();
  const [open, setOpen] = useState<number | null>(null);

  /** Посмотреть глазами, из чего выбирает слот. */
  async function showInLibrary(row: SlotSupply) {
    const picker = await ipc.slotPicker(poolId, row.position);
    setFilter({ ...picker.filter, collectionId: picker.filter.collectionId });
    go('library');
  }

  return (
    <aside className={s.panel}>
      <div className={s.scroll}>
        <SourcesBlock
          set={whence.sources.own ? whence.sources.set : null}
          effective={whence.sources}
          onChange={(next) => void ipc.setPoolSources(poolId, next).then(() => onChanged())}
        />

        <ExclusionsBlock
          owner="pool"
          ownerId={poolId}
          items={whence.exclusions}
          picked={picked}
          onChanged={onChanged}
        />

        <RulesBlock rules={whence.rules} onChange={() => {}} readOnly origin={whence.rulesOrigin} />
      </div>

      <section className={s.supply}>
        <header className={s.head}>
          <h4 className={s.h4}>Запас</h4>
          {whence.starsPending > 0 ? (
            <span className={s.pending} title="Звёзды под модами ещё считаются">
              ★ {whence.starsPending}
            </span>
          ) : null}
        </header>

        <div className={s.rows}>
          {whence.supply.map((row) => {
            const short = row.available < row.need;
            const empty = row.available === 0;
            return (
              <div key={row.position} className={s.rowWrap}>
                <button
                  className={s.row}
                  onClick={() => setOpen(open === row.position ? null : row.position)}
                  type="button"
                  title="Что отсекло карты"
                >
                  <span className={s.label} data-mod={row.mod}>
                    {row.slotLabel}
                  </span>
                  <span className={s.need}>нужно {row.need}</span>
                  <span
                    className={[s.have, empty ? s.zero : short ? s.tight : null]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    подходит {row.available}
                  </span>
                  {empty ? (
                    <span className={s.bad} aria-hidden>
                      ✕
                    </span>
                  ) : short ? (
                    <span className={s.warn} aria-hidden>
                      ⚠
                    </span>
                  ) : null}
                </button>

                {open === row.position ? (
                  <div className={s.blockers}>
                    {row.blockers.length === 0 ? (
                      <div className={s.hint}>Ничего не отсекало — весь источник подходит.</div>
                    ) : (
                      row.blockers.map((b) => (
                        <div key={b.reason} className={s.blocker}>
                          <span className={s.reason}>{b.reason}</span>
                          <span className={s.num}>−{b.cut}</span>
                        </div>
                      ))
                    )}
                    <div className={s.blockerFoot}>
                      <span className={s.hint}>источник: {row.origin}</span>
                      <button
                        className={s.link}
                        onClick={() => void showInLibrary(row)}
                        type="button"
                      >
                        {maps(row.available)} в библиотеке
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}

          {whence.supply.length === 0 ? (
            <div className={s.hint}>В маппуле нет слотов — считать нечего.</div>
          ) : null}
        </div>
      </section>
    </aside>
  );
}
