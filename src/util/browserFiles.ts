import { useSyncExternalStore } from 'react';

// Saving to a file on disk from the browser, through the File System Access API.
// Chromium browsers have it; elsewhere a save is a download and Open reads a copy.

interface FileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}
interface Pickers {
  showSaveFilePicker(o: { suggestedName: string; types: PickerType[] }): Promise<FileHandle>;
  showOpenFilePicker(o: { types: PickerType[] }): Promise<FileHandle[]>;
}
type PickerType = { description: string; accept: Record<string, string[]> };

const DOCUMENT: PickerType = { description: 'Proof Writer document', accept: { 'application/json': ['.json'] } };
const TYPST: PickerType = { description: 'Typst file', accept: { 'text/plain': ['.typ'] } };

const pickers = (): Pickers | null =>
  typeof window !== 'undefined' && 'showSaveFilePicker' in window && 'showOpenFilePicker' in window ? (window as unknown as Pickers) : null;

/** True when this browser can write to a file the user picked. */
export const canSaveToFile = () => pickers() !== null;

/** The file each document is saved to, keyed by doc id. It lasts until the page is reloaded. */
const handles = new Map<string, FileHandle>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/** Name of the file a document is saved to, or null. */
export const useSaveFileName = (docId: string) =>
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => handles.get(docId)?.name ?? null);

/** The document that was written a moment ago, so the Save button can say so. */
let justSaved: string | null = null;
export const useJustSaved = (docId: string) =>
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => justSaved === docId);

const cancelled = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/**
 * Writes a document to its file, asking for one the first time or when `saveAs`.
 * Returns the file's name, or null if the user cancelled.
 */
export async function saveToFile(docId: string, text: string, suggestedName: string, saveAs: boolean): Promise<string | null> {
  const p = pickers();
  if (!p) throw new Error('This browser cannot save to a file.');
  let h = saveAs ? undefined : handles.get(docId);
  if (!h) {
    try { h = await p.showSaveFilePicker({ suggestedName, types: [DOCUMENT] }); }
    catch (e) { if (cancelled(e)) return null; throw e; }
  }
  const w = await h.createWritable();
  await w.write(text);
  await w.close();
  handles.set(docId, h);
  justSaved = docId;
  changed();
  setTimeout(() => { if (justSaved === docId) { justSaved = null; changed(); } }, 1500);
  return h.name;
}

/** Asks for a file to open. `keep` ties the file to a document, so saving that document writes back to it. */
export async function pickFileToOpen(): Promise<{ name: string; text: string; keep: (docId: string) => void } | null> {
  const p = pickers();
  if (!p) throw new Error('This browser cannot open a file in place.');
  let h: FileHandle;
  try { [h] = await p.showOpenFilePicker({ types: [DOCUMENT, TYPST] }); }
  catch (e) { if (cancelled(e)) return null; throw e; }
  const text = await (await h.getFile()).text();
  return { name: h.name, text, keep: (docId) => { handles.set(docId, h); changed(); } };
}
