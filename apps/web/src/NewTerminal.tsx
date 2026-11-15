import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ProjectPicker } from './ProjectPicker';
import { useT } from './i18n';

interface Props {
  open: boolean;
  /** Cartella proposta (es. quella della conversazione aperta) */
  initialCwd?: string;
  /** Comando rapido scelto dalla dashboard */
  command?: string;
  error?: string;
  busy: boolean;
  onClose: () => void;
  onCreate: (cwd: string, command?: string) => void;
}

export function NewTerminalDialog({ open, initialCwd, command, error, busy, onClose, onCreate }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT();
  const id = useId();
  const [cwd, setCwd] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (initialCwd) setCwd(initialCwd);
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (cwd.trim()) onCreate(cwd.trim(), command || undefined);
  };

  return (
    <dialog ref={ref} className="dialog" aria-labelledby={`${id}-title`} onClose={onClose}>
      <form onSubmit={submit}>
        <h2 id={`${id}-title`}>{t('nuovoterminale.titolo')}</h2>

        <ProjectPicker active={open} cwd={cwd} onChange={setCwd} />

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            {t('nuovoterminale.annulla')}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !cwd.trim()}>
            {busy ? t('nuovoterminale.apertura') : t('nuovoterminale.apri')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
