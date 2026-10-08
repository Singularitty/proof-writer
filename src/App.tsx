import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { BlockList } from './components/Blocks';
import { Sidebar } from './components/Sidebar';
import { Preview } from './preview/Preview';
import { Icon } from './components/Icon';
import { download, slug } from './util/download';
import { desktop, docFilePath, setDocFilePath } from './util/desktop';
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
  const update = useStore((s) => s.update);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const [previewWidth, setPreviewWidth] = useState(() => {
    try { return +(localStorage.getItem('proof-writer:pw') ?? '') || 640; } catch { return 640; }
  });
  const [showSettings, setShowSettings] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

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
      } else if (mod && e.key.toLowerCase() === 'o' && desktop) {
        e.preventDefault();
        openDoc();
      }
    };
    window.addEventListener('keydown', onKey);
    // In the desktop app, the File menu and "Open with" route here.
    const offMenu = desktop?.onMenu((c) => (c === 'open' ? openDoc() : saveDoc(c === 'save-as')));
    desktop?.pendingOpen().then((f) => f && loadJson(f.text, f.path));
    return () => { window.removeEventListener('keydown', onKey); offMenu?.(); };
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

  const importJson = async (f: File) => loadJson(await f.text());
  return (
    <div className="app" style={{ gridTemplateColumns: `260px 1fr 6px ${previewWidth}px` }}>
      <header className="topbar">
        <span className="logo">⊢ Proof Writer</span>
        <input className="doc-title" value={doc.title} onChange={(e) => update((d) => { d.title = e.target.value; }, 'title')} placeholder="Document title" />
        <input className="doc-author" value={doc.author} onChange={(e) => update((d) => { d.author = e.target.value; }, 'author')} placeholder="Author" />
        <span className="grow" />
        <button className="theme-toggle" onClick={cycleTheme} title={`Theme: ${theme} (click to change)`} aria-label={`Theme: ${theme}`}><Icon name={THEME_ICON[theme]} /></button>
        <button onClick={() => useStore.getState().undo()} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo (Ctrl+Z)"><Icon name="undo" /></button>
        <button onClick={() => useStore.getState().redo()} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo (Ctrl+Shift+Z)"><Icon name="redo" /></button>
        <button onClick={() => (desktop ? openDoc() : fileInput.current?.click())} title="Open a .json document (Ctrl+O)" aria-label="Open a .json document">Open .json</button>
        <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importJson(f); e.target.value = ''; }} />
        <button onClick={() => saveDoc(false)} title="Save the document as JSON (Ctrl+S)" aria-label="Save the document as JSON (Ctrl+S)">Save .json</button>
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
        <div className="editor-inner">
          <BlockList blocks={doc.blocks} />
        </div>
      </main>
      <div className="splitter" onMouseDown={startDrag} />
      <Preview />
    </div>
  );
}

function loadJson(text: string, path?: string) {
  try {
    const d = JSON.parse(text) as Doc;
    if (!Array.isArray(d.blocks) || !Array.isArray(d.snippets)) throw new Error('not a proof-writer document');
    d.settings ??= { paper: 'a4', fontSize: 11, numberTheorems: 'shared' };
    useStore.getState().importDoc(d);
    if (path) setDocFilePath(useStore.getState().docId, path);
  } catch (e) {
    alert('Could not open that file: ' + (e instanceof Error ? e.message : e));
  }
}

async function openDoc() {
  try {
    const f = await desktop?.openDocument();
    if (f) loadJson(f.text, f.path);
  } catch (e) {
    alert('Could not open that file: ' + e);
  }
}

/** Desktop: writes to the document's file (asking once for a path); browser: downloads it. */
async function saveDoc(saveAs: boolean) {
  const { doc, docId } = useStore.getState();
  const name = `${slug(doc.title)}.proof.json`;
  const text = JSON.stringify(doc, null, 2);
  if (!desktop) { download(name, text, 'application/json'); return; }
  try {
    const p = await desktop.saveDocument(saveAs ? null : docFilePath(docId), text, name);
    if (p) setDocFilePath(docId, p);
  } catch (e) {
    alert('Could not save: ' + e);
  }
}
