import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import type { Block, Doc } from './model/types';
import { emptyDoc, sampleDoc } from './model/sample';
import { uid } from './model/util';
import type { GitHubSource } from './util/github';

const INDEX_KEY = 'proof-writer:index';
const DOC_KEY = (id: string) => `proof-writer:doc:${id}`;
const MAX_HISTORY = 200;

export interface DocMeta {
  id: string;
  title: string;
  updated: number;
  /** The GitHub file this document was opened from or last committed to. */
  github?: GitHubSource;
}

function load<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}
/** Writes to localStorage; on failure (storage full or blocked) flags it so the UI can warn. */
function save(key: string, v: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(v));
    // (useStore isn't defined yet while the initial state is being built)
    try { if (useStore.getState().storageError) useStore.setState({ storageError: null }); } catch { /* initialising */ }
    return true;
  } catch (e) {
    const full = e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22);
    setTimeout(() => useStore.setState({
      storageError: full
        ? 'Browser storage is full, so recent changes are not saved here. Save the document as .json, or delete old documents.'
        : 'This browser is not letting the app save documents (private window or blocked storage). Save as .json to keep your work.',
    }));
    return false;
  }
}

// Ask the browser not to evict our storage under pressure (best effort).
try { void navigator.storage?.persist?.(); } catch { /* ignore */ }

/** Something that can receive inserted text (the last focused math or prose field). */
export interface InsertTarget { insert: (text: string) => void; kind: 'math' | 'prose' }

interface State {
  docId: string;
  doc: Doc;
  index: DocMeta[];
  past: Doc[];
  future: Doc[];
  /** Coalesce rapid edits of the same field into one undo step. */
  lastEditKey: string | null;
  lastEditTime: number;
  selectedBlock: string | null;
  /** Section shown in the editor (id of its top-level H1, or PREAMBLE); null shows the whole document. */
  section: string | null;
  insertTarget: InsertTarget | null;
  /** Set when saving to browser storage failed. */
  storageError: string | null;
  githubDialog: 'open' | 'commit' | null;
  /** The block the preview was last asked to show; `n` makes each request distinct. */
  pdfTarget: { id: string; n: number } | null;
  showInPdf: (id: string) => void;
  setGithubDialog: (m: 'open' | 'commit' | null) => void;

  update: (f: (d: Draft<Doc>) => void, editKey?: string) => void;
  undo: () => void;
  redo: () => void;
  selectBlock: (id: string | null) => void;
  setSection: (id: string | null) => void;
  setInsertTarget: (t: InsertTarget | null) => void;
  openDoc: (id: string) => void;
  newDoc: (sample?: boolean) => void;
  importDoc: (d: Doc, meta?: Partial<DocMeta>) => void;
  /** Swap in new contents for the open document (it changed on disk); one undo step. */
  replaceDoc: (d: Doc) => void;
  deleteDoc: (id: string) => void;
  renameDoc: (id: string, title: string) => void;
  duplicateDoc: (id: string) => void;
  setGithubSource: (id: string, src: GitHubSource | undefined) => void;
}

function initial(): { docId: string; doc: Doc; index: DocMeta[] } {
  const index = load<DocMeta[]>(INDEX_KEY) ?? [];
  const last = load<string>('proof-writer:last');
  const id = last && index.some((m) => m.id === last) ? last : index[0]?.id;
  if (id) {
    const doc = load<Doc>(DOC_KEY(id));
    if (doc) return { docId: id, doc, index };
  }
  const doc = sampleDoc();
  const nid = uid();
  const meta = { id: nid, title: doc.title, updated: Date.now() };
  save(DOC_KEY(nid), doc);
  save(INDEX_KEY, [meta]);
  return { docId: nid, doc, index: [meta] };
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** The write the timer is waiting to make. */
let pendingSave: (() => void) | null = null;
function persist(id: string, doc: Doc, index: DocMeta[]): DocMeta[] {
  const next = index.map((m) => (m.id === id ? { ...m, title: doc.title, updated: Date.now() } : m));
  clearTimeout(saveTimer);
  pendingSave = () => {
    pendingSave = null;
    save(DOC_KEY(id), doc);
    save(INDEX_KEY, next);
    save('proof-writer:last', id);
  };
  saveTimer = setTimeout(() => pendingSave?.(), 300);
  return next;
}
/** Writes an edit still waiting on the timer, so closing or reloading the page loses nothing. */
function flushSave() {
  clearTimeout(saveTimer);
  pendingSave?.();
}
/** Forgets a waiting write (its document is being deleted). */
function dropSave() {
  clearTimeout(saveTimer);
  pendingSave = null;
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', flushSave);

export const useStore = create<State>((set, get) => ({
  ...initial(),
  past: [],
  future: [],
  lastEditKey: null,
  lastEditTime: 0,
  selectedBlock: null,
  section: null,
  insertTarget: null,
  storageError: null,
  githubDialog: null,
  pdfTarget: null,
  showInPdf: (id) => set({ pdfTarget: { id, n: (get().pdfTarget?.n ?? 0) + 1 } }),
  setGithubDialog: (m) => set({ githubDialog: m }),

  update: (f, editKey) => {
    const { doc, past, lastEditKey, lastEditTime, docId, index } = get();
    const next = produce(doc, f);
    if (next === doc) return;
    const now = Date.now();
    const coalesce = editKey && editKey === lastEditKey && now - lastEditTime < 1500;
    set({
      doc: next,
      past: coalesce ? past : [...past.slice(-MAX_HISTORY), doc],
      future: [],
      lastEditKey: editKey ?? null,
      lastEditTime: now,
      index: persist(docId, next, index),
    });
  },
  undo: () => {
    const { past, future, doc, docId, index } = get();
    if (!past.length) return;
    const prev = past[past.length - 1];
    set({ doc: prev, past: past.slice(0, -1), future: [doc, ...future], lastEditKey: null, index: persist(docId, prev, index) });
  },
  redo: () => {
    const { past, future, doc, docId, index } = get();
    if (!future.length) return;
    const nxt = future[0];
    set({ doc: nxt, past: [...past, doc], future: future.slice(1), lastEditKey: null, index: persist(docId, nxt, index) });
  },
  selectBlock: (id) => set({ selectedBlock: id }),
  setSection: (id) => set({ section: id }),
  setInsertTarget: (t) => set({ insertTarget: t }),
  openDoc: (id) => {
    const { docId, doc, index } = get();
    save(DOC_KEY(docId), doc);
    const d = load<Doc>(DOC_KEY(id));
    if (!d) return;
    save('proof-writer:last', id);
    set({ docId: id, doc: d, past: [], future: [], selectedBlock: null, section: null, index });
  },
  newDoc: (sample) => {
    const { docId, doc, index } = get();
    save(DOC_KEY(docId), doc);
    const d = sample ? sampleDoc() : emptyDoc();
    const id = uid();
    const nextIndex = [{ id, title: d.title, updated: Date.now() }, ...index];
    save(DOC_KEY(id), d);
    save(INDEX_KEY, nextIndex);
    save('proof-writer:last', id);
    set({ docId: id, doc: d, index: nextIndex, past: [], future: [], selectedBlock: null, section: null });
  },
  importDoc: (d, meta) => {
    const { docId, doc, index } = get();
    save(DOC_KEY(docId), doc);
    const id = uid();
    const nextIndex = [{ id, title: d.title, updated: Date.now(), ...meta }, ...index];
    save(DOC_KEY(id), d);
    save(INDEX_KEY, nextIndex);
    save('proof-writer:last', id);
    set({ docId: id, doc: d, index: nextIndex, past: [], future: [], selectedBlock: null, section: null });
  },
  replaceDoc: (d) => {
    const { doc, past, docId, index } = get();
    set({ doc: d, past: [...past.slice(-MAX_HISTORY), doc], future: [], lastEditKey: null, index: persist(docId, d, index) });
  },
  deleteDoc: (id) => {
    const { docId, index } = get();
    const nextIndex = index.filter((m) => m.id !== id);
    save(INDEX_KEY, nextIndex);
    set({ index: nextIndex });
    if (id === docId) {
      // opening another document saves the one that was open; this one is going away
      dropSave();
      if (nextIndex.length) get().openDoc(nextIndex[0].id);
      else get().newDoc(false);
    }
    try { localStorage.removeItem(DOC_KEY(id)); } catch { /* ignore */ }
  },
  renameDoc: (id, title) => {
    if (id === get().docId) { get().update((d) => { d.title = title; }, 'title'); return; }
    const d = load<Doc>(DOC_KEY(id));
    if (!d) return;
    d.title = title;
    save(DOC_KEY(id), d);
    const nextIndex = get().index.map((m) => (m.id === id ? { ...m, title } : m));
    save(INDEX_KEY, nextIndex);
    set({ index: nextIndex });
  },
  duplicateDoc: (id) => {
    const { docId, doc } = get();
    const src = id === docId ? doc : load<Doc>(DOC_KEY(id));
    if (!src) return;
    get().importDoc({ ...structuredClone(src), title: `${src.title} (copy)` });
  },
  setGithubSource: (id, src) => {
    const nextIndex = get().index.map((m) => (m.id === id ? { ...m, github: src } : m));
    save(INDEX_KEY, nextIndex);
    set({ index: nextIndex });
  },
}));

// ---------- tree helpers for nested block lists ----------

/** Find the array that contains the block with the given id (searching proofs and cases). */
export function findBlockList(blocks: Draft<Block>[], id: string): Draft<Block>[] | null {
  for (const b of blocks) {
    if (b.id === id) return blocks;
    if (b.type === 'theorem' && b.proof) {
      const r = findBlockList(b.proof, id);
      if (r) return r;
    }
    if (b.type === 'cases') {
      for (const c of b.cases) {
        const r = findBlockList(c.body, id);
        if (r) return r;
      }
    }
  }
  return null;
}

export function findBlock(blocks: Draft<Block>[], id: string): Draft<Block> | null {
  const list = findBlockList(blocks, id);
  return list?.find((b) => b.id === id) ?? null;
}

/** Update a block anywhere in the document. */
export function updateBlock<T extends Block['type']>(
  id: string,
  f: (b: Draft<Extract<Block, { type: T }>>) => void,
  editKey?: string,
) {
  useStore.getState().update((d) => {
    const b = findBlock(d.blocks, id);
    if (b) f(b as Draft<Extract<Block, { type: T }>>);
  }, editKey);
}
