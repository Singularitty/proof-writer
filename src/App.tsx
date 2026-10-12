import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { hasUnsavedEdits, useStore } from './store';
import { BlockList } from './components/Blocks';
import { Sidebar } from './components/Sidebar';
import { SectionPager, SectionTabs, useCurrentSection } from './components/Sections';
import { Preview } from './preview/Preview';
import { Icon } from './components/Icon';
import { download, slug } from './util/download';
import { desktop, docFilePath, fileName, markDiskSeen, markSaved, savedState, setDocFilePath } from './util/desktop';
import { refreshFiles } from './components/Files';
import { externalChange } from './util/external';
import { loadFile } from './util/files';
import { canSaveToFile, pickFileToOpen, saveToFile, useJustSaved, useSaveFileName } from './util/browserFiles';
import { GitHubDialog } from './components/GitHubDialog';
import type { Doc } from './model/types';
import { VIEWS, dockedViews, gridColumns, hasSplitter, minWidth, openCount } from './model/layout';
import { dockPreview, focusPreviewWindow, previewSlot } from './util/detach';

type Theme = 'system' | 'light' | 'dark';
const THEME_ICON = { system: 'auto', light: 'sun', dark: 'moon' } as const;

export function applyTheme(t: Theme) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

export function savedTheme(): Theme {
  try { return (localStorage.getItem('proof-writer:theme') as Theme) || 'system'; } catch { return 'system'; }
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  const cycleTheme = () => {
    const next: Theme = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';
    setTheme(next);
    applyTheme(next);
    try { localStorage.setItem('proof-writer:theme', next); } catch { /* ignore */ }
  };
  const doc = useStore((s) => s.doc);
  const saveFile = useSaveFileName(useStore((s) => s.docId));
  const justSaved = useJustSaved(useStore((s) => s.docId));
  const update = useStore((s) => s.update);
  const { current } = useCurrentSection();
  const storageError = useStore((s) => s.storageError);
  const githubDialog = useStore((s) => s.githubDialog);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const [previewWidth, setPreviewWidth] = useState(() => {
    try { return +(localStorage.getItem('proof-writer:pw') ?? '') || 640; } catch { return 640; }
  });
  const views = useStore((s) => s.views);
  const previewDetached = useStore((s) => s.previewDetached);
  /** What the main window shows; a detached preview is elsewhere. */
  const docked = dockedViews(views, previewDetached);
  const [showSettings, setShowSettings] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!showSettings) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowSettings(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showSettings]);
  /** The open document's file changed on disk while it has unsaved edits. */
  const [diskChange, setDiskChange] = useState<{ docId: string; text: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) useStore.getState().redo();
        else useStore.getState().undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        useStore.getState().redo();
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveDoc(e.shiftKey);
      } else if (mod && e.key.toLowerCase() === 'o' && (desktop || canSaveToFile())) {
        e.preventDefault();
        openDoc();
      }
    };
    window.addEventListener('keydown', onKey);
    // In the desktop app, the File menu and "Open with" route here.
    const offMenu = desktop?.onMenu((c) => (c === 'open' ? openDoc() : saveDoc(c === 'save-as')));
    desktop?.pendingOpen().then((f) => f && loadFile(f.text, f.path));
    /** Brings the open document and its file into step, given what the file holds now. */
    const meetDisk = (docId: string, text: string) => {
      const { docId: open, doc, index } = useStore.getState();
      if (open !== docId) return;
      if (JSON.stringify(doc, null, 2) === text) { markSaved(docId, doc, text); return; }
      const s = savedState(docId);
      // after a restart nothing is remembered of the saved text, only whether there were edits since
      const action = externalChange({ disk: text, saved: s?.text ?? null, dirty: s ? s.doc !== doc : hasUnsavedEdits(index.find((m) => m.id === docId)) });
      if (action === 'reload') reloadFromDisk(docId, text);
      else if (action === 'ask') setDiskChange({ docId, text });
    };
    /** Starts watching the open document's file, and catches up with it if this copy is behind. */
    const follow = () => {
      const docId = useStore.getState().docId;
      void desktop?.watchDocument(docFilePath(docId)).then((text) => { if (text !== null) meetDisk(docId, text); }, () => {});
    };
    const offChanged = desktop?.onDocumentChanged(({ path, text }) => {
      const docId = useStore.getState().docId;
      if (docFilePath(docId) === path) meetDisk(docId, text);
    });
    // Each document has its own file; follow whichever one is open, starting with the one from last time.
    follow();
    const offDoc = useStore.subscribe((s, prev) => {
      if (s.docId === prev.docId) return;
      setDiskChange(null);
      follow();
    });
    return () => { window.removeEventListener('keydown', onKey); offMenu?.(); offChanged?.(); offDoc(); };
  }, []);

  // Desktop: which file the document is in, whether it has edits not yet saved there, and saving by itself.
  const meta = useStore((s) => s.index.find((m) => m.id === s.docId));
  const unsaved = hasUnsavedEdits(meta);
  const [autosave, setAutosave] = useState(() => { try { return localStorage.getItem('proof-writer:autosave') !== '0'; } catch { return true; } });
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop) return;
    document.title = `${meta?.file ? fileName(meta.file) : doc.title || 'Untitled'}${unsaved ? ' •' : ''} — Proof Writer`;
  }, [meta?.file, doc.title, unsaved]);
  useEffect(() => {
    // not while the file has changed underneath us and the user has yet to choose
    if (!desktop || !autosave || !meta?.file || !unsaved || diskChange) return;
    const t = setTimeout(() => { void saveDoc(false, true).then((err) => setSaveError(err)); }, 1200);
    return () => clearTimeout(t);
  }, [doc, autosave, meta?.file, unsaved, diskChange]); // eslint-disable-line

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = previewWidth;
    const move = (ev: MouseEvent) => setPreviewWidth(Math.max(320, Math.min(window.innerWidth - (docked.sidebar ? 600 : 380), start - (ev.clientX - startX))));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setPreviewWidth((w) => { try { localStorage.setItem('proof-writer:pw', String(w)); } catch { /* ignore */ } return w; });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const importFile = async (f: File) => loadFile(await f.text(), undefined, f.name);
  return (
    <div className={'app' + VIEWS.map((v) => (docked[v] ? '' : ` no-${v}`)).join('')} style={{ gridTemplateColumns: gridColumns(docked, previewWidth), minWidth: minWidth(docked) }}>
      <header className="topbar">
        <span className="logo">⊢ Proof Writer</span>
        <input className="doc-title" value={doc.title} onChange={(e) => update((d) => { d.title = e.target.value; }, 'title')} placeholder="Document title" />
        <input className="doc-author" value={doc.author} onChange={(e) => update((d) => { d.author = e.target.value; }, 'author')} placeholder="Author" />
        {desktop && (
          <span className={'file-chip' + (unsaved ? ' unsaved' : '') + (saveError ? ' failed' : '')} title={saveError ? `Could not save: ${saveError}` : meta?.file ? `${meta.file}${unsaved ? ' (edits not yet saved)' : ' (saved)'}` : 'This document is not in a file yet. Save puts it in one.'}>
            {meta?.file ? `${unsaved ? '● ' : ''}${fileName(meta.file)}` : 'not in a file'}
          </span>
        )}
        <span className="grow" />
        <span className="btn-group view-toggles" role="group" aria-label="Views">
          {VIEWS.map((v) => (v === 'preview' && previewDetached ? (
            <button key={v} className="detached" aria-label="Preview (in its own window)" title="The preview is in its own window. Click to bring it to the front." onClick={focusPreviewWindow}><Icon name={v} /></button>
          ) : (
            <button
              key={v} className={views[v] ? 'active' : ''} aria-pressed={views[v]} aria-label={v[0].toUpperCase() + v.slice(1)}
              disabled={docked[v] && openCount(docked) === 1}
              title={views[v] ? (openCount(docked) === 1 ? `The ${v} is the only view open` : `Collapse the ${v}`) : `Show the ${v}`}
              onClick={() => useStore.getState().toggleView(v)}
            ><Icon name={v} /></button>
          )))}
        </span>
        <button className="theme-toggle" onClick={cycleTheme} title={`Theme: ${theme} (click to change)`} aria-label={`Theme: ${theme}`}><Icon name={THEME_ICON[theme]} /></button>
        <button onClick={() => useStore.getState().undo()} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo (Ctrl+Z)"><Icon name="undo" /></button>
        <button onClick={() => useStore.getState().redo()} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo (Ctrl+Shift+Z)"><Icon name="redo" /></button>
        <button onClick={() => (desktop || canSaveToFile() ? openDoc() : fileInput.current?.click())} title="Open a .json document, or import a Typst .typ file (Ctrl+O)" aria-label="Open a document">Open…</button>
        <input ref={fileInput} type="file" accept=".json,.typ,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ''; }} />
        {desktop || !canSaveToFile()
          ? <button onClick={() => saveDoc(false)} title="Save the document as JSON (Ctrl+S)" aria-label="Save the document as JSON (Ctrl+S)">Save .json</button>
          : <>
            <button onClick={() => saveDoc(false)} title={saveFile ? `Save to ${saveFile} (Ctrl+S)` : 'Save to a file on this computer; later saves write to the same file (Ctrl+S)'}>{justSaved ? 'Saved ✓' : saveFile ? 'Save' : 'Save to…'}</button>
            {saveFile && <button onClick={() => saveDoc(true)} title="Save to a different file (Ctrl+Shift+S)">Save as…</button>}
          </>}
        <button onClick={() => useStore.getState().setGithubDialog('commit')} title="Open documents from, or commit this one to, a GitHub repository">GitHub…</button>
        <span className="picker-wrap">
          <button onClick={() => setShowSettings(!showSettings)}>Settings</button>
          {showSettings && (
            <div className="menu settings" onMouseLeave={() => setShowSettings(false)}>
              <label>Paper
                <select value={doc.settings.paper} onChange={(e) => update((d) => { d.settings.paper = e.target.value as 'a4' | 'us-letter'; })}>
                  <option value="a4">A4</option><option value="us-letter">US Letter</option>
                </select>
              </label>
              <label>Font size
                <select value={doc.settings.fontSize} onChange={(e) => update((d) => { d.settings.fontSize = +e.target.value; })}>
                  {[10, 11, 12].map((s) => <option key={s} value={s}>{s}pt</option>)}
                </select>
              </label>
              {desktop && (
                <label className="check" title="Write the document to its file a moment after each edit. Ctrl+S still saves at once.">
                  <input type="checkbox" checked={autosave} onChange={(e) => { setAutosave(e.target.checked); try { localStorage.setItem('proof-writer:autosave', e.target.checked ? '1' : '0'); } catch { /* ignore */ } }} />
                  Save automatically
                </label>
              )}
              <label>Theorem numbering
                <select value={doc.settings.numberTheorems} onChange={(e) => update((d) => { d.settings.numberTheorems = e.target.value as 'shared' | 'per-kind'; })}>
                  <option value="shared">Shared (Lemma 1, Theorem 2)</option>
                  <option value="per-kind">Per kind (Lemma 1, Theorem 1)</option>
                </select>
              </label>
            </div>
          )}
        </span>
      </header>
      <Sidebar />
      <main className="editor" onMouseDown={(e) => { if (e.target === e.currentTarget) useStore.getState().selectBlock(null); }}>
        {storageError && <div className="storage-error" role="alert">{storageError}</div>}
        {diskChange && diskChange.docId === useStore.getState().docId && (
          <div className="disk-change" role="alert">
            This document's file was changed outside Proof Writer, and you have unsaved edits here.
            <button onClick={() => { reloadFromDisk(diskChange.docId, diskChange.text); setDiskChange(null); }} title="Replace what is here with the file's contents (Undo brings your edits back)">Reload</button>
            <button onClick={() => { markDiskSeen(diskChange.docId, diskChange.text); setDiskChange(null); }} title="Keep editing; saving will overwrite the file">Keep mine</button>
          </div>
        )}
        <SectionTabs />
        <div className="editor-inner">
          {current
            ? <BlockList blocks={doc.blocks.slice(current.start, current.end)} offset={current.start} total={doc.blocks.length} />
            : <BlockList blocks={doc.blocks} />}
          <SectionPager />
        </div>
      </main>
      {hasSplitter(docked) && <div className="splitter" onMouseDown={startDrag} />}
      {/* the preview is drawn into a box of its own, which sits here or in the detached window */}
      <div className="preview-dock" ref={dockPreview} />
      {createPortal(<Preview />, previewSlot())}
      {githubDialog && <GitHubDialog mode={githubDialog} onClose={() => useStore.getState().setGithubDialog(null)} />}
    </div>
  );
}

async function openDoc() {
  try {
    if (!desktop) {
      const f = await pickFileToOpen();
      // an imported Typst file is a new document with no file of its own
      if (f && loadFile(f.text, undefined, f.name) && /\.json$/i.test(f.name)) f.keep(useStore.getState().docId);
      return;
    }
    const f = await desktop.openDocument();
    if (f) loadFile(f.text, f.path);
  } catch (e) {
    alert('Could not open that file: ' + e);
  }
}

/** Replaces the open document with what its file now holds. A file that does not parse is left alone. */
function reloadFromDisk(docId: string, text: string) {
  if (useStore.getState().docId !== docId) return;
  try {
    const d = JSON.parse(text) as Doc;
    if (!Array.isArray(d.blocks) || !Array.isArray(d.snippets)) return;
    d.settings ??= { paper: 'a4', fontSize: 11, numberTheorems: 'shared' };
    useStore.getState().replaceDoc(d);
    markSaved(docId, d, text);
  } catch { /* half-written or not a document: wait for the next change */ }
}

/**
 * Writes to the document's file, asking once where it is. A browser that cannot write to files downloads it instead.
 * `quiet` is for saving unasked: it never opens a dialog, and reports a failure by returning its message.
 */
async function saveDoc(saveAs: boolean, quiet = false): Promise<string | null> {
  const { doc, docId } = useStore.getState();
  const name = `${slug(doc.title)}.proof.json`;
  const text = JSON.stringify(doc, null, 2);
  if (!desktop) {
    if (!canSaveToFile()) { download(name, text, 'application/json'); return null; }
    try { await saveToFile(docId, text, name, saveAs); } catch (e) { alert('Could not save: ' + e); }
    return null;
  }
  const known = saveAs ? null : docFilePath(docId);
  if (quiet && !known) return null;
  try {
    const p = await desktop.saveDocument(known, text, name);
    if (p) {
      if (p !== known) setDocFilePath(docId, p);
      markSaved(docId, doc, text);
      void desktop.watchDocument(p);
      if (p !== known) refreshFiles();
    }
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!quiet) alert('Could not save: ' + msg);
    return msg;
  }
}
