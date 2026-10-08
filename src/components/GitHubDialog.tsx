import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { loadFile } from '../util/files';
import { slug } from '../util/download';
import { exportTypst } from '../export/typst';
import { exportLatex } from '../export/latex';
import {
  commitFile, defaultBranch, getFile, githubToken, lastRepo, listBranches, listDocFiles, parseRepo,
  type GitHubSource, type RepoFile,
} from '../util/github';

type Mode = 'open' | 'commit';
type Format = 'json' | 'typst' | 'latex';
const EXT: Record<Format, string> = { json: '.proof.json', typst: '.typ', latex: '.tex' };

const TOKEN_HELP = 'https://github.com/settings/personal-access-tokens/new';

export function GitHubDialog({ mode: initialMode, onClose }: { mode: Mode; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [token, setToken] = useState(githubToken.get());
  const [showToken, setShowToken] = useState(!!githubToken.get() || initialMode === 'commit');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal gh" role="dialog" aria-label="GitHub">
        <div className="modal-head">
          <div className="tabs">
            <button className={mode === 'open' ? 'active' : ''} onClick={() => setMode('open')}>Open from GitHub</button>
            <button className={mode === 'commit' ? 'active' : ''} onClick={() => setMode('commit')}>Commit to GitHub</button>
          </div>
          <button className="mini" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {mode === 'open' ? <OpenPane onDone={onClose} /> : <CommitPane />}
        <details className="gh-token" open={showToken} onToggle={(e) => setShowToken((e.target as HTMLDetailsElement).open)}>
          <summary>{token ? 'Access token (saved in this browser)' : 'Access token (for private repositories and commits)'}</summary>
          <div className="gh-row">
            <input
              type="password" value={token} placeholder="github_pat_…" autoComplete="off" spellCheck={false}
              onChange={(e) => { setToken(e.target.value.trim()); githubToken.set(e.target.value.trim()); }}
            />
            {token && <button onClick={() => { setToken(''); githubToken.set(''); }}>Forget</button>}
          </div>
          <p className="help">
            Public repositories open without one. For private repositories or committing, create a{' '}
            <a href={TOKEN_HELP} target="_blank" rel="noreferrer">fine-grained token</a> limited to the repositories you need,
            with <em>Contents: Read and write</em>. It is stored only in this browser and sent only to api.github.com.
          </p>
        </details>
      </div>
    </div>
  );
}

function useRepo(initial: string) {
  const [input, setInput] = useState(initial);
  const ref = useMemo(() => parseRepo(input), [input]);
  return { input, setInput, ref };
}

function OpenPane({ onDone }: { onDone: () => void }) {
  const { input, setInput, ref } = useRepo(lastRepo.get());
  const [branch, setBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [files, setFiles] = useState<RepoFile[] | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async <T,>(f: () => Promise<T>) => {
    setBusy(true); setError('');
    try { return await f(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); return undefined; } finally { setBusy(false); }
  };

  const open = (path: string, b: string) => run(async () => {
    if (!ref) return;
    const src = { owner: ref.owner, repo: ref.repo, branch: b, path };
    const { text, sha } = await getFile(src);
    if (loadFile(text, undefined, path, { github: { ...src, sha } })) onDone();
  });

  const browse = (b?: string) => run(async () => {
    if (!ref) return;
    lastRepo.set(input.trim());
    const br = b || ref.branch || (await defaultBranch(ref.owner, ref.repo));
    setBranch(br);
    // A link straight to a file opens it.
    if (!b && ref.path && /\.(json|typ)$/i.test(ref.path)) { await open(ref.path, br); return; }
    const [list, bs] = await Promise.all([listDocFiles(ref.owner, ref.repo, br), branches.length ? Promise.resolve(branches) : listBranches(ref.owner, ref.repo).catch(() => [br])]);
    setBranches(bs.includes(br) ? bs : [br, ...bs]);
    setFiles(ref.path && !b ? list.filter((f) => f.path.startsWith(ref.path + '/')) : list);
  });

  const shown = (files ?? []).filter((f) => f.path.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="gh-pane">
      <form className="gh-row" onSubmit={(e) => { e.preventDefault(); browse(); }}>
        <input
          autoFocus value={input} onChange={(e) => { setInput(e.target.value); setFiles(null); setBranches([]); }}
          placeholder="owner/repo, or a link to a repository, folder or file" spellCheck={false}
        />
        <button className="primary" disabled={!ref || busy}>{busy ? 'Loading…' : 'Browse'}</button>
      </form>
      {input && !ref && <p className="gh-error">That doesn't look like a GitHub repository. Try owner/repo.</p>}
      {error && <p className="gh-error">{error}</p>}
      {files && (
        <>
          <div className="gh-row">
            <select value={branch} onChange={(e) => browse(e.target.value)} disabled={busy} aria-label="Branch">
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files" />
          </div>
          {shown.length === 0
            ? <p className="help">No .json or .typ files{filter ? ' match' : ' on this branch'}.</p>
            : (
              <ul className="gh-files">
                {shown.slice(0, 300).map((f) => (
                  <li key={f.path}>
                    <button onClick={() => open(f.path, branch)} disabled={busy}>
                      <span className="mono">{f.path}</span>
                      <span className="dim">{f.path.endsWith('.typ') ? 'Typst, imported' : 'document'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </>
      )}
    </div>
  );
}

function CommitPane() {
  const doc = useStore((s) => s.doc);
  const docId = useStore((s) => s.docId);
  const source = useStore((s) => s.index.find((m) => m.id === docId)?.github);
  const fromSource = source ? `${source.owner}/${source.repo}` : lastRepo.get();
  const { input, setInput, ref } = useRepo(fromSource);
  const [format, setFormat] = useState<Format>('json');
  const defaultPath = (f: Format) => {
    if (source && f === 'json') return source.path.replace(/\.typ$/i, '.proof.json');
    if (source) return source.path.replace(/(\.proof)?\.(json|typ)$/i, '') + EXT[f];
    return slug(doc.title) + EXT[f];
  };
  const [path, setPath] = useState(defaultPath('json'));
  const [branch, setBranch] = useState(source?.branch ?? '');
  const [message, setMessage] = useState(`Update ${doc.title || 'document'}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ url: string } | null>(null);

  const sameAsSource = !!source && ref?.owner === source.owner && ref?.repo === source.repo && (branch || source.branch) === source.branch && path === source.path;
  const overwritesTypst = sameAsSource && format !== 'json';

  const commit = async () => {
    if (!ref) return;
    setBusy(true); setError(''); setDone(null);
    try {
      if (!githubToken.get()) throw new Error('Committing needs an access token (below).');
      const br = branch || ref.branch || (await defaultBranch(ref.owner, ref.repo));
      const text = format === 'json' ? JSON.stringify(doc, null, 2) : format === 'typst' ? exportTypst(doc).source : exportLatex(doc).source;
      const target = { owner: ref.owner, repo: ref.repo, branch: br, path: path.replace(/^\/+/, '') };
      const r = await commitFile(target, text, message || `Update ${path}`, sameAsSource ? source!.sha : undefined);
      lastRepo.set(input.trim());
      // Remember where the document lives so the next commit goes to the same file.
      if (format === 'json') useStore.getState().setGithubSource(docId, { ...target, sha: r.sha });
      setDone({ url: r.url });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gh-pane">
      <label className="gh-field"><span>Repository</span>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="owner/repo" spellCheck={false} />
      </label>
      <div className="gh-row">
        <label className="gh-field"><span>Branch</span>
          <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="default branch" spellCheck={false} />
        </label>
        <label className="gh-field"><span>Save as</span>
          <select value={format} onChange={(e) => { const f = e.target.value as Format; setFormat(f); setPath(defaultPath(f)); }}>
            <option value="json">Proof Writer document (.json)</option>
            <option value="typst">Typst export (.typ)</option>
            <option value="latex">LaTeX export (.tex)</option>
          </select>
        </label>
      </div>
      <label className="gh-field"><span>Path</span>
        <input value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} />
      </label>
      <label className="gh-field"><span>Commit message</span>
        <input value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>
      {overwritesTypst && <p className="gh-warn">This replaces the Typst file you imported with the app's generated Typst.</p>}
      {error && <p className="gh-error">{error}</p>}
      {done && <p className="gh-ok">Committed. <a href={done.url} target="_blank" rel="noreferrer">View on GitHub</a></p>}
      <div className="gh-row end">
        <button className="primary" onClick={commit} disabled={!ref || !path || busy}>{busy ? 'Committing…' : 'Commit'}</button>
      </div>
    </div>
  );
}

export type { GitHubSource };
