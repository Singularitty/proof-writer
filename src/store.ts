import { create } from 'zustand';
import { produce, type Draft } from 'immer';
import type { Block, Doc } from './model/types';
import { emptyDoc, sampleDoc } from './model/sample';
import { uid } from './model/util';

const INDEX_KEY = 'proof-writer:index';
const DOC_KEY = (id: string) => `proof-writer:doc:${id}`;
const MAX_HISTORY = 200;

export interface DocMeta { id: string; title: string; updated: number }

function load<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}
function save(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage full or unavailable */ }
}

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
  insertTarget: InsertTarget | null;

  update: (f: (d: Draft<Doc>) => void, editKey?: string) => void;
  undo: () => void;
  redo: () => void;
  selectBlock: (id: string | null) => void;
  setInsertTarget: (t: InsertTarget | null) => void;
  openDoc: (id: string) => void;
  newDoc: (sample?: boolean) => void;
  importDoc: (d: Doc) => void;
  deleteDoc: (id: string) => void;
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
function persist(id: string, doc: Doc, index: DocMeta[]): DocMeta[] {
  const next = index.map((m) => (m.id === id ? { ...m, title: doc.title, updated: Date.now() } : m));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    save(DOC_KEY(id), doc);
    save(INDEX_KEY, next);
    save('proof-writer:last', id);
  }, 300);
  return next;
}

export const useStore = create<State>((set, get) => ({
  ...initial(),
  past: [],
  future: [],
  lastEditKey: null,
  lastEditTime: 0,
  selectedBlock: null,
  insertTarget: null,

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
  setInsertTarget: (t) => set({ insertTarget: t }),
  openDoc: (id) => {
    const { docId, doc, index } = get();
    save(DOC_KEY(docId), doc);
    const d = load<Doc>(DOC_KEY(id));
    if (!d) return;
    save('proof-writer:last', id);
    set({ docId: id, doc: d, past: [], future: [], selectedBlock: null, index });
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
    set({ docId: id, doc: d, index: nextIndex, past: [], future: [], selectedBlock: null });
  },
  importDoc: (d) => {
    const { docId, doc, index } = get();
    save(DOC_KEY(docId), doc);
    const id = uid();
    const nextIndex = [{ id, title: d.title, updated: Date.now() }, ...index];
    save(DOC_KEY(id), d);
    save(INDEX_KEY, nextIndex);
    save('proof-writer:last', id);
    set({ docId: id, doc: d, index: nextIndex, past: [], future: [], selectedBlock: null });
  },
  deleteDoc: (id) => {
    const { docId, index } = get();
    const nextIndex = index.filter((m) => m.id !== id);
    try { localStorage.removeItem(DOC_KEY(id)); } catch { /* ignore */ }
    save(INDEX_KEY, nextIndex);
    set({ index: nextIndex });
    if (id === docId) {
      if (nextIndex.length) get().openDoc(nextIndex[0].id);
      else get().newDoc(false);
    }
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
