import { useCallback, useEffect, useState } from 'react';
import { hasUnsavedEdits, useStore } from '../store';
import { desktop, fileName, setDocFilePath, type FolderEntry, type FolderListing } from '../util/desktop';
import { loadFile } from '../util/files';
import { emptyDoc } from '../model/sample';
import { Git } from './Git';

const FOLDER_KEY = 'proof-writer:workspace';

function remembered(): string | null {
  try { return localStorage.getItem(FOLDER_KEY); } catch { return null; }
}
function remember(dir: string | null) {
  try { if (dir) localStorage.setItem(FOLDER_KEY, dir); else localStorage.removeItem(FOLDER_KEY); } catch { /* ignore */ }
}

/** Listeners that want the listing read again (a file was saved, created, renamed or removed). */
export const refreshers = new Set<() => void>();
export const refreshFiles = () => refreshers.forEach((f) => f());

/** Desktop: the folder being worked in. Its documents open with a click and can be created, renamed and trashed here. */
export function Files() {
  const ws = desktop!.workspace;
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const index = useStore((s) => s.index);
  const docId = useStore((s) => s.docId);
  const openFile = index.find((m) => m.id === docId)?.file ?? null;

  const attempt = async (f: () => Promise<void>) => {
    try { setError(null); await f(); } catch (e) { setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : String(e)); }
  };
  const show = (l: FolderListing | null) => { setListing(l); if (l) remember(l.root); };
  const refresh = useCallback(() => {
    if (listing) void ws.list(listing.dir).then(setListing, () => setListing(null));
  }, [listing, ws]);

  // reopen the folder from last time
  useEffect(() => {
    const dir = remembered();
    if (dir) void ws.open(dir).then((l) => { if (l) setListing(l); else remember(null); }, () => {});
  }, [ws]);
  // keep the listing current: after our own changes, and when coming back to the window
  useEffect(() => {
    refreshers.add(refresh);
    window.addEventListener('focus', refresh);
    return () => { refreshers.delete(refresh); window.removeEventListener('focus', refresh); };
  }, [refresh]);

  const open = (e: FolderEntry) => attempt(async () => {
    if (e.kind === 'dir') { setListing(await ws.list(e.path)); return; }
    const text = await ws.read(e.path);
    // a Typst file is imported as a new document, which has no file of its own yet
    loadFile(text, /\.json$/i.test(e.name) ? e.path : undefined, e.name);
  });
  const create = () => attempt(async () => {
    if (!listing) return;
    const doc = emptyDoc();
    const text = JSON.stringify(doc, null, 2);
    const path = await ws.create(listing.dir, 'Untitled', text);
    setListing(await ws.list(listing.dir));
    loadFile(text, path, fileName(path));
    setRenaming(path);
  });
  const rename = (e: FolderEntry, name: string) => attempt(async () => {
    setRenaming(null);
    if (!listing || !name.trim() || name.trim() === e.name) return;
    const path = await ws.rename(e.path, name);
    // a document open from that file follows it
    for (const m of useStore.getState().index) {
      if (m.file === e.path) {
        const saved = m.fileSaved;
        setDocFilePath(m.id, path);
        // moving the file saved nothing: keep what was known about unsaved edits
        useStore.setState((s) => ({ index: s.index.map((x) => (x.id === m.id ? { ...x, fileSaved: saved } : x)) }));
        if (m.id === useStore.getState().docId) void desktop!.watchDocument(path);
      }
    }
    setListing(await ws.list(listing.dir));
  });
  const trash = (e: FolderEntry) => attempt(async () => {
    if (!listing || !confirm(`Move "${e.name}" to the trash?`)) return;
    await ws.trash(e.path);
    // the document goes from the list of open documents too; its file can be restored from the trash
    for (const m of useStore.getState().index) if (m.file === e.path) useStore.getState().deleteDoc(m.id);
    setListing(await ws.list(listing.dir));
  });

  if (!listing) {
    return (
      <div className="files">
        <p className="help">Open a folder to see its documents here, create new ones and save without being asked where.</p>
        <button className="primary" onClick={() => attempt(async () => show(await ws.pick()))}>Open folder…</button>
        {error && <p className="files-error" role="alert">{error}</p>}
      </div>
    );
  }
  const inRoot = listing.dir === listing.root;
  return (
    <div className="files">
      <div className="files-head">
        <strong className="files-folder" title={listing.dir}>{fileName(listing.dir)}</strong>
        <button className="mini" onClick={create} title="New document in this folder">＋ New</button>
        <button className="mini" onClick={refresh} title="Read the folder again" aria-label="Refresh">↻</button>
        <button className="mini" onClick={() => attempt(async () => { const l = await ws.pick(); if (l) show(l); })} title="Work in a different folder">Change…</button>
      </div>
      {error && <p className="files-error" role="alert">{error}</p>}
      <ul>
        {!inRoot && listing.parent && (
          <li className="dir"><a onClick={() => attempt(async () => setListing(await ws.list(listing.parent!)))} title="Up one folder">‹ ..</a></li>
        )}
        {listing.entries.map((e) => {
          const meta = index.find((m) => m.file === e.path);
          return (
            <li key={e.path} className={e.kind + (e.path === openFile ? ' active' : '')}>
              {renaming === e.path ? (
                <input
                  className="docs-rename" autoFocus defaultValue={e.name.replace(/(\.proof)?\.[^.]+$/, '')}
                  onFocus={(ev) => ev.target.select()}
                  onBlur={(ev) => rename(e, ev.target.value)}
                  onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); if (ev.key === 'Escape') setRenaming(null); }}
                />
              ) : (
                <a onClick={() => open(e)} onDoubleClick={() => e.kind === 'file' && setRenaming(e.path)} title={e.kind === 'dir' ? 'Open this folder' : e.path}>
                  {e.kind === 'dir' ? '▸ ' : ''}{e.name}{hasUnsavedEdits(meta) && <span className="unsaved" title="Has edits not yet saved to the file"> ●</span>}
                </a>
              )}
              {e.kind === 'file' && renaming !== e.path && (
                <span className="docs-actions">
                  <button className="mini" onClick={() => setRenaming(e.path)} title="Rename" aria-label="Rename">✎</button>
                  <button className="mini" onClick={() => attempt(() => ws.reveal(e.path))} title="Show in the file manager" aria-label="Show in the file manager">⤴</button>
                  <button className="mini danger" onClick={() => trash(e)} title="Move to the trash" aria-label="Move to the trash">×</button>
                </span>
              )}
            </li>
          );
        })}
        {listing.entries.length === 0 && <li className="dim">No documents in this folder yet.</li>}
      </ul>
      <Git root={listing.root} />
    </div>
  );
}
