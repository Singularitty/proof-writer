import type { Doc } from '../model/types';
import { useStore } from '../store';

/** One entry of the open folder. */
export interface FolderEntry { name: string; path: string; kind: 'dir' | 'file'; modified: number }
/** A listing of the open folder or of a folder inside it. */
export interface FolderListing { root: string; dir: string; parent: string | null; entries: FolderEntry[] }

/** Bridge exposed by electron/preload.cjs; undefined in the browser build. */
export interface DesktopBridge {
  platform: string;
  openDocument(): Promise<{ path: string; text: string } | null>;
  pendingOpen(): Promise<{ path: string; text: string } | null>;
  saveDocument(path: string | null, text: string, suggestedName: string): Promise<string | null>;
  saveFile(suggestedName: string, data: string | Uint8Array, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  openPdf(name: string, data: Uint8Array): Promise<string>;
  onMenu(cb: (channel: 'open' | 'save' | 'save-as') => void): () => void;
  /** Watch this window's document file for changes made outside the app; null stops. Resolves to what the file holds now, or null if it is not there. */
  watchDocument(path: string | null): Promise<string | null>;
  onDocumentChanged(cb: (f: { path: string; text: string }) => void): () => void;
  /** The folder this window works in. Everything but `pick` and `open` is confined to it. */
  workspace: {
    /** Asks for a folder. */
    pick(): Promise<FolderListing | null>;
    /** Reopens a folder by path; null if it is no longer there. */
    open(dir: string): Promise<FolderListing | null>;
    list(dir: string): Promise<FolderListing>;
    read(path: string): Promise<string>;
    /** Creates a document, never overwriting one. Returns its path. */
    create(dir: string, name: string, text: string): Promise<string>;
    /** Renames a document within its folder. Returns its new path. */
    rename(path: string, name: string): Promise<string>;
    /** Moves a document to the system's trash. */
    trash(path: string): Promise<void>;
    reveal(path: string): Promise<void>;
  };
  /** Signing in to GitHub; the token is kept by the app, not the page, and shared by its windows. */
  github: {
    /** Starts a sign-in; `onCode` hears the code to enter. Resolves to the token, or null if cancelled. */
    signIn(clientId: string): Promise<string | null>;
    cancel(): Promise<void>;
    /** The token from the last sign-in, or ''. */
    token(): Promise<string>;
    signOut(): Promise<void>;
    onCode(cb: (c: DeviceCode) => void): () => void;
  };
}
/** What to enter on GitHub to finish signing in, and where. */
export interface DeviceCode { userCode: string; verificationUri: string }

declare global {
  interface Window { desktop?: DesktopBridge }
}

export const desktop: DesktopBridge | undefined = typeof window !== 'undefined' ? window.desktop : undefined;

/** The file a document was last saved to or opened from (desktop only). It is kept with the document's library entry, so it survives a restart. */
export const docFilePath = (docId: string) => useStore.getState().index.find((m) => m.id === docId)?.file ?? null;
export const setDocFilePath = (docId: string, p: string) => { useStore.getState().setDocFile(docId, p); };

/** The last part of a path, on either kind of system. */
export const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** What each document's file held when it was last opened, saved or reloaded, and the document as it was then. */
const saved = new Map<string, { doc: Doc; text: string }>();
export const savedState = (docId: string) => saved.get(docId) ?? null;
export const markSaved = (docId: string, doc: Doc, text: string) => {
  saved.set(docId, { doc, text });
  useStore.getState().markFileSaved(docId);
};
/** The file changed and the user kept their own version: remember the file's text so the same change is not raised again. */
export const markDiskSeen = (docId: string, text: string) => {
  const s = saved.get(docId);
  if (s) saved.set(docId, { doc: s.doc, text });
};
