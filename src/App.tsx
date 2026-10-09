import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { BlockList } from './components/Blocks';
import { Sidebar } from './components/Sidebar';
import { SectionPager, SectionTabs, useCurrentSection } from './components/Sections';
import { Preview } from './preview/Preview';
import { Icon } from './components/Icon';
import { download, slug } from './util/download';
import { desktop, docFilePath, markDiskSeen, markSaved, savedState, setDocFilePath } from './util/desktop';
import { externalChange } from './util/external';
import { loadFile } from './util/files';
import { canSaveToFile, pickFileToOpen, saveToFile, useJustSaved, useSaveFileName } from './util/browserFiles';
import { GitHubDialog } from './components/GitHubDialog';
import type { Doc } from './model/types';

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
    const offChanged = desktop?.onDocumentChanged(({ path, text }) => {
      const { docId, doc } = useStore.getState();
      if (docFilePath(docId) !== path) return;
      const s = savedState(docId);
      const action = externalChange({ disk: text, saved: s?.text ?? null, dirty: !s || s.doc !== doc });
      if (action === 'reload') reloadFromDisk(docId, text);
      else if (action === 'ask') setDiskChange({ docId, text });
    });
    // Each document has its own file; follow whichever one is open.
    const offDoc = useStore.subscribe((s, prev) => {
      if (s.docId === prev.docId) return;
      setDiskChange(null);
      void desktop?.watchDocument(docFilePath(s.docId));
    });
    return () => { window.removeEventListener('keydown', onKey); offMenu?.(); offChanged?.(); offDoc(); };
  }, []);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = previewWidth;
    const move = (ev: MouseEvent) => setPreviewWidth(Math.max(320, Math.min(window.innerWidth - 600, start - (ev.clientX - startX))));
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
    <div className="app" style={{ gridTemplateColumns: `minmax(220px, 300px) minmax(420px, 1fr) 6px minmax(260px, ${previewWidth}px)` }}>
      <header className="topbar">
        <span className="logo">⊢ Proof Writer</span>
        <input className="doc-title" value={doc.title} onChange={(e) => update((d) => { d.title = e.target.value; }, 'title')} placeholder="Document title" />
        <input className="doc-author" value={doc.author} onChange={(e) => update((d) => { d.author = e.target.value; }, 'author')} placeholder="Author" />
        <span className="grow" />
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
      <div className="splitter" onMouseDown={startDrag} />
      <Preview />
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

/** Writes to the document's file, asking once where it is. A browser that cannot write to files downloads it instead. */
async function saveDoc(saveAs: boolean) {
  const { doc, docId } = useStore.getState();
  const name = `${slug(doc.title)}.proof.json`;
  const text = JSON.stringify(doc, null, 2);
  if (!desktop) {
    if (!canSaveToFile()) { download(name, text, 'application/json'); return; }
    try { await saveToFile(docId, text, name, saveAs); } catch (e) { alert('Could not save: ' + e); }
    return;
  }
  try {
    const p = await desktop.saveDocument(saveAs ? null : docFilePath(docId), text, name);
    if (p) {
      setDocFilePath(docId, p);
      markSaved(docId, doc, text);
      void desktop.watchDocument(p);
    }
  } catch (e) {
    alert('Could not save: ' + e);
  }
}
