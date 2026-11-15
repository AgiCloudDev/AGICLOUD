import { useEffect, useId, useState } from 'react';
import { api, type DirListing } from './api';
import { useT } from './i18n';

/** Cartella del progetto: campo libero + recenti + navigazione tra le cartelle consentite */
export function ProjectPicker({ active, cwd, onChange }: { active: boolean; cwd: string; onChange: (cwd: string) => void }) {
  const id = useId();
  const t = useT();
  const [recent, setRecent] = useState<string[]>([]);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [browseError, setBrowseError] = useState('');
  const [mode, setMode] = useState<'clone' | 'mkdir' | null>(null);
  const [gitUrl, setGitUrl] = useState('');
  const [dirName, setDirName] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  const browse = async (path: string | undefined) => {
    setBrowseError('');
    try {
      setListing(await api.dirs(path));
      if (path) onChange(path);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (!active) return;
    setMode(null);
    setBrowseError('');
    api
      .projects()
      .then((p) => {
        setRecent(p.recent);
        if (!cwd && p.recent[0]) onChange(p.recent[0]);
      })
      .catch(() => {});
    void browse(undefined);
  }, [active]);

  const runClone = async () => {
    const url = gitUrl.trim();
    if (!url || actionBusy) return;
    setActionBusy(true);
    setBrowseError('');
    try {
      const res = await api.cloneProject(url, listing?.path ?? undefined);
      setGitUrl('');
      setMode(null);
      await browse(res.parent);
      onChange(res.path);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  const runMkdir = async () => {
    const name = dirName.trim();
    if (!name || actionBusy) return;
    setActionBusy(true);
    setBrowseError('');
    try {
      const res = await api.createProjectDir(name, listing?.path ?? undefined);
      setDirName('');
      setMode(null);
      await browse(res.parent);
      onChange(res.path);
    } catch (err) {
      setBrowseError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <>
      <label htmlFor={`${id}-cwd`}>{t('projectpicker.cartella')}</label>
      <input
        id={`${id}-cwd`}
        value={cwd}
        onChange={(e) => onChange(e.target.value)}
        placeholder="/opt/project"
        autoComplete="off"
        spellCheck={false}
        className="mono-input"
        required
      />

      {recent.length > 0 && (
        <div className="recent">
          <h3 className="mini-title" id={`${id}-recent`}>
            {t('projectpicker.recenti')}
          </h3>
          <ul className="chips" aria-labelledby={`${id}-recent`}>
            {recent.map((r) => (
              <li key={r}>
                <button type="button" className="chip" aria-pressed={cwd === r} onClick={() => onChange(r)} title={r}>
                  {r.split('/').filter(Boolean).pop() ?? r}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="browser">
        <div className="browser-head">
          <h3 className="mini-title" id={`${id}-browse`}>
            {t('projectpicker.sfoglia')}
          </h3>
          <span className="browser-path" title={listing?.path ?? undefined}>
            {listing?.path ? shortPath(listing.path) : t('projectpicker.radici')}
          </span>
          <div className="browser-actions">
            <button
              type="button"
              className="btn small-btn"
              aria-expanded={mode === 'clone'}
              onClick={() => {
                setBrowseError('');
                setMode((m) => (m === 'clone' ? null : 'clone'));
              }}
            >
              {t('projectpicker.clonaGit')}
            </button>
            <button
              type="button"
              className="btn small-btn"
              aria-expanded={mode === 'mkdir'}
              onClick={() => {
                setBrowseError('');
                setMode((m) => (m === 'mkdir' ? null : 'mkdir'));
              }}
            >
              {t('projectpicker.nuovaCartella')}
            </button>
          </div>
        </div>
        {mode === 'clone' && (
          <div className="browser-action-bar">
            <label htmlFor={`${id}-git`} className="visually-hidden">
              {t('projectpicker.urlGit')}
            </label>
            <input
              id={`${id}-git`}
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void runClone();
                }
              }}
              placeholder={t('projectpicker.urlGitPh')}
              autoComplete="off"
              spellCheck={false}
              className="mono-input"
              disabled={actionBusy}
            />
            <button type="button" className="btn primary small-btn" disabled={actionBusy || !gitUrl.trim()} onClick={() => void runClone()}>
              {actionBusy ? t('projectpicker.clonazione') : t('projectpicker.clona')}
            </button>
          </div>
        )}
        {mode === 'mkdir' && (
          <div className="browser-action-bar">
            <label htmlFor={`${id}-mkdir`} className="visually-hidden">
              {t('projectpicker.nomeCartella')}
            </label>
            <input
              id={`${id}-mkdir`}
              value={dirName}
              onChange={(e) => setDirName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void runMkdir();
                }
              }}
              placeholder={t('projectpicker.nomeCartellaPh')}
              autoComplete="off"
              spellCheck={false}
              className="mono-input"
              disabled={actionBusy}
            />
            <button type="button" className="btn primary small-btn" disabled={actionBusy || !dirName.trim()} onClick={() => void runMkdir()}>
              {t('projectpicker.crea')}
            </button>
          </div>
        )}
        <ul className="dir-list" aria-labelledby={`${id}-browse`}>
          {listing?.path && (
            <li>
              <button type="button" className="dir-btn" onClick={() => void browse(listing.parent ?? undefined)}>
                <span aria-hidden="true">↑</span> {listing.parent ? t('projectpicker.superiore') : t('projectpicker.radici')}
              </button>
            </li>
          )}
          {listing?.dirs.map((d) => (
            <li key={d.path}>
              <button type="button" className="dir-btn" onClick={() => void browse(d.path)}>
                <span aria-hidden="true">📁</span> {d.name}
                {d.git && <span className="git-badge">git</span>}
              </button>
            </li>
          ))}
          {listing && listing.dirs.length === 0 && <li className="hint">{t('projectpicker.nessunaSotto')}</li>}
        </ul>
        {browseError && (
          <p className="form-error" role="alert">
            {browseError}
          </p>
        )}
      </div>
    </>
  );
}

/** Percorsi lunghi: si tiene la parte finale, la piu' utile */
function shortPath(p: string, max = 48): string {
  return p.length > max ? `…${p.slice(-(max - 1))}` : p;
}
