import type { Doc } from '../model/types';
import { useStore } from '../store';

/** One entry of the open folder. */
export interface FolderEntry { name: string; path: string; kind: 'dir' | 'file'; modified: number }
/** A listing of the open folder or of a folder inside it. */
export interface FolderListing { root: string; dir: string; parent: string | null; entries: FolderEntry[] }

/** Where the two programs a mechanization needs were found; null for one that was not. */
export interface LeanTools { claude: string | null; lake: string | null }
/**
 * How a job ended. `report` is whatever the agent answered with, unchecked.
 * `touched` lists what the run created, changed or deleted among the Lean
 * files under PW/ (paths relative to the Lean folder), and `CONVENTIONS.md` if
 * it changed that, which the app then put back.
 */
export interface LeanRunResult { ok: boolean; report: unknown; cancelled: boolean; error?: string; touched?: string[] }
/**
 * A build's output and the Lean files as they are after it, paths relative to the Lean folder.
 * `code` is null for a build that was stopped (`cancelled` says it was by Cancel) or ran past its time limit.
 * `removed` lists the Lean files of statements the document no longer has, which were moved to the trash.
 */
export interface LeanBuildResult { started: boolean; code: number | null; output: string; files: { path: string; text: string }[]; removed: string[]; cancelled?: boolean }

/** Mechanizing the window's document in Lean (electron/lean.cjs). Every call is confined to that document's Lean folder. */
export interface LeanBridge {
  tools(): Promise<LeanTools>;
  /** The Lean folder's path and what its mechanization.json holds (null if there is none). */
  open(docPath: string): Promise<{ dir: string; status: unknown }>;
  /**
   * Runs Claude Code in the Lean folder, creating the project first if needed. Resolves when the run ends.
   * `modules` are the Lean module names of the document's statements, which PW.lean is made to import for the run.
   */
  run(job: { docPath: string; prompt: string; snapshot: { json: string; md: string }; schema: unknown; model: string; effort: string; modules: string[] }): Promise<LeanRunResult>;
  /** Stops what this window is running: the job, or the build that follows it. */
  cancel(): Promise<void>;
  /** Builds the project. Given `keep` (Lean module names), first moves the other modules' files, except Defs, to the trash. */
  build(docPath: string, keep?: string[]): Promise<LeanBuildResult>;
  writeStatus(docPath: string, status: unknown): Promise<void>;
  /** Rewrites the files that make the folder a Lake project, leaving the Lean sources alone. */
  recreate(docPath: string): Promise<void>;
  reveal(docPath: string): Promise<void>;
  /** Activity of the running job, a line at a time. */
  onEvent(cb: (e: { line: string }) => void): () => void;
}

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
  lean: LeanBridge;
}

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
