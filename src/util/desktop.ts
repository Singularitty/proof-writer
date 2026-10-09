import type { Doc } from '../model/types';

/** Bridge exposed by electron/preload.cjs; undefined in the browser build. */
export interface DesktopBridge {
  platform: string;
  openDocument(): Promise<{ path: string; text: string } | null>;
  pendingOpen(): Promise<{ path: string; text: string } | null>;
  saveDocument(path: string | null, text: string, suggestedName: string): Promise<string | null>;
  saveFile(suggestedName: string, data: string | Uint8Array, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  openPdf(name: string, data: Uint8Array): Promise<string>;
  onMenu(cb: (channel: 'open' | 'save' | 'save-as') => void): () => void;
  /** Watch this window's document file for changes made outside the app; null stops. */
  watchDocument(path: string | null): Promise<void>;
  onDocumentChanged(cb: (f: { path: string; text: string }) => void): () => void;
}

declare global {
  interface Window { desktop?: DesktopBridge }
}

export const desktop: DesktopBridge | undefined = typeof window !== 'undefined' ? window.desktop : undefined;

/** File each open document was last saved to or opened from (desktop only), keyed by doc id. */
const filePaths = new Map<string, string>();
export const docFilePath = (docId: string) => filePaths.get(docId) ?? null;
export const setDocFilePath = (docId: string, p: string) => { filePaths.set(docId, p); };

/** What each document's file held when it was last opened, saved or reloaded, and the document as it was then. */
const saved = new Map<string, { doc: Doc; text: string }>();
export const savedState = (docId: string) => saved.get(docId) ?? null;
export const markSaved = (docId: string, doc: Doc, text: string) => { saved.set(docId, { doc, text }); };
/** The file changed and the user kept their own version: remember the file's text so the same change is not raised again. */
export const markDiskSeen = (docId: string, text: string) => {
  const s = saved.get(docId);
  if (s) saved.set(docId, { doc: s.doc, text });
};
