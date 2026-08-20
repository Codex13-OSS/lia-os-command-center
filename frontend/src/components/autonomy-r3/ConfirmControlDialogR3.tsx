import { useEffect, useRef } from 'react';

type Props = { title: string; detail: string; confirmLabel: string; busy?: boolean; onConfirm: () => void; onCancel: () => void };

export function ConfirmControlDialogR3({ title, detail, confirmLabel, busy = false, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return <div className="lia-control-dialog-backdrop" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section className="lia-control-dialog" role="alertdialog" aria-modal="true" aria-labelledby="lia-control-dialog-title" aria-describedby="lia-control-dialog-detail">
      <span>CONFIRMACIÓN HUMANA</span>
      <h3 id="lia-control-dialog-title">{title}</h3>
      <p id="lia-control-dialog-detail">{detail}</p>
      <div><button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>Cancelar</button><button type="button" className="is-destructive" disabled={busy} onClick={onConfirm}>{busy ? 'Registrando…' : confirmLabel}</button></div>
    </section>
  </div>;
}
