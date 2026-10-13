import { useCallback, useEffect, useState } from 'react';
import { hasUnsavedEdits, useStore } from '../store';
import { desktop, fileName, type GitStatus } from '../util/desktop';
import { refreshFiles, refreshers } from './Files';

const STATE = { new: 'new', modified: 'changed', deleted: 'deleted', renamed: 'renamed', conflict: 'conflict' } as const;
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

/** Desktop: the open folder as a git repository. Commit what changed, pull and push, with the system's own git. */
export function Git({ root }: { root: string }) {
  const git = desktop!.git;
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [busy, setBusy] = useState<'commit' | 'pull' | 'push' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  /** Changed files left out of the next commit. */
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const unsaved = useStore((s) => s.index.some((m) => m.file?.startsWith(root) && hasUnsavedEdits(m)));
  /** Changes whenever a document is written to its file. */
  const saves = useStore((s) => s.index.reduce((n, m) => n + (m.fileSaved ?? 0), 0));

  const refresh = useCallback(() => { void git.status().then(setStatus, () => setStatus(null)); }, [git]);
  // keep it current: after a save, after changes to the folder, and when coming back to the window
  useEffect(() => {
    const t = setTimeout(refresh, 300);
    return () => clearTimeout(t);
  }, [refresh, root, saves]);
  useEffect(() => {
    refreshers.add(refresh);
    window.addEventListener('focus', refresh);
    return () => { refreshers.delete(refresh); window.removeEventListener('focus', refresh); };
  }, [refresh]);

  const run = async (what: 'commit' | 'pull' | 'push', f: () => Promise<GitStatus>) => {
    setBusy(what); setError('');
    try { setStatus(await f()); return true; } catch (e) { setError(reason(e)); refresh(); return false; } finally { setBusy(null); }
  };
  const files = status?.repo ? status.files : [];
  const chosen = files.filter((f) => !skipped.has(f.path)).map((f) => f.path);
  const commit = async () => { if (await run('commit', () => git.commit(message, chosen))) { setMessage(''); setSkipped(new Set()); } };
  // a pull rewrites files: the listing is read again, and an open document follows its file by itself
  const pull = async () => { await run('pull', () => git.pull()); refreshFiles(); };

  if (!status) return null;
  if (!status.repo) return <p className="git-none dim">{status.missing ? 'Git is not installed, so this folder cannot be committed from here.' : 'This folder is not a git repository.'}</p>;
  const toggle = (path: string) => setSkipped((s) => { const n = new Set(s); if (!n.delete(path)) n.add(path); return n; });
  return (
    <div className="git">
      <div className="files-head">
        <strong className="files-folder" title={status.upstream ? `Follows ${status.upstream}` : 'Not yet on a remote'}>⎇ {status.branch}</strong>
        {status.ahead > 0 && <span className="dim" title={`${status.ahead} commit${status.ahead === 1 ? '' : 's'} to push`}>↑{status.ahead}</span>}
        {status.behind > 0 && <span className="dim" title={`${status.behind} commit${status.behind === 1 ? '' : 's'} to pull`}>↓{status.behind}</span>}
        <button className="mini" disabled={!!busy || !status.upstream} onClick={pull} title={status.upstream ? `Bring in new commits from ${status.upstream}` : 'This branch is not on a remote yet'}>{busy === 'pull' ? 'Pulling…' : 'Pull'}</button>
        <button className="mini" disabled={!!busy} onClick={() => run('push', () => git.push())} title={status.upstream ? `Send your commits to ${status.upstream}` : 'Send this branch to the remote'}>{busy === 'push' ? 'Pushing…' : 'Push'}</button>
      </div>
      {files.length === 0 ? <p className="dim git-clean">No changes to commit.</p> : (
        <>
          <ul className="git-files">
            {files.map((f) => (
              <li key={f.path}>
                <label title={f.from ? `${f.from} → ${f.path}` : f.path}>
                  <input type="checkbox" checked={!skipped.has(f.path)} onChange={() => toggle(f.path)} />
                  <span className="git-name">{fileName(f.path)}</span>
                  <span className={'git-state ' + f.state}>{STATE[f.state]}</span>
                </label>
              </li>
            ))}
          </ul>
          {unsaved && <p className="git-note">A document here has edits not yet saved to its file. Save it first to have them in the commit.</p>}
          <form className="git-commit" onSubmit={(e) => { e.preventDefault(); void commit(); }}>
            <input className="docs-rename" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What changed" aria-label="Commit message" />
            <button className="mini primary" disabled={!!busy || !message.trim() || !chosen.length}>{busy === 'commit' ? 'Committing…' : 'Commit'}</button>
          </form>
        </>
      )}
      {error && <p className="files-error git-error" role="alert">{error}</p>}
    </div>
  );
}
