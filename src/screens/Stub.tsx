import s from './Stub.module.css';

/** Раздел, до которого ещё не дошли руки. */
export default function Stub({ title }: { title: string }) {
  return (
    <div className={s.wrap}>
      <h1 className={s.h}>{title}</h1>
      <p className={s.p}>Этот раздел ещё в работе.</p>
    </div>
  );
}
