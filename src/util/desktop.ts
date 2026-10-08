/** Bridge exposed by electron/preload.cjs; undefined in the browser build. */
export interface DesktopBridge {
  platform: string;
  openDocument(): Promise<{ path: string; text: string } | null>;
  pendingOpen(): Promise<{ path: string; text: string } | null>;
  saveDocument(path: string | null, text: string, suggestedName: string): Promise<string | null>;
  saveFile(suggestedName: string, data: string | Uint8Array, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  openPdf(name: string, data: Uint8Array): Promise<string>;
  onMenu(cb: (channel: 'open' | 'save' | 'save-as') => void): () => void;
}

declare global {
  interface Window { desktop?: DesktopBridge }
}

export const desktop: DesktopBridge | undefined = typeof window !== 'undefined' ? window.desktop : undefined;

/** File each open document was last saved to or opened from (desktop only), keyed by doc id. */
const filePaths = new Map<string, string>();
export const docFilePath = (docId: string) => filePaths.get(docId) ?? null;
export const setDocFilePath = (docId: string, p: string) => { filePaths.set(docId, p); };
