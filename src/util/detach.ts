import { useStore } from '../store';

/**
 * The preview in a window of its own. It is not a second copy of the app: the box the preview is drawn into is moved
 * into the other window's page, so it goes on sharing this window's document, compiler and undo history.
 */

const NAME = 'proof-writer-preview';
let slot: HTMLDivElement | null = null;
let dock: HTMLElement | null = null;
let win: Window | null = null;
let stopMirroring: (() => void) | null = null;

/** The box the preview is drawn into, wherever it currently sits. */
export function previewSlot(): HTMLDivElement {
  return (slot ??= Object.assign(document.createElement('div'), { className: 'preview-slot' }));
}

const previewWindow = () => (win && !win.closed ? win : null);

/** Moves the preview, keeping its place in the pages (which are a different size in a window of another width). */
function place(to: HTMLElement) {
  const box = previewSlot();
  const pages = box.querySelector('.pdf-wrap');
  const at = pages && pages.scrollHeight ? pages.scrollTop / pages.scrollHeight : 0;
  to.appendChild(box);
  if (pages) pages.scrollTop = at * pages.scrollHeight;
}

/** Ref for the preview's place in the main window. */
export function dockPreview(el: HTMLElement | null) {
  dock = el;
  if (el && !previewWindow()) place(el);
}

/** Gives the other window this one's styles and theme, and keeps them in step (the Typst styles arrive late). */
function mirrorLook(to: Document): () => void {
  const copy = () => {
    const theme = document.documentElement.dataset.theme;
    if (theme) to.documentElement.dataset.theme = theme;
    else delete to.documentElement.dataset.theme;
    to.head.replaceChildren(...[...document.head.querySelectorAll<HTMLElement>('style, link[rel="stylesheet"]')].map((n) => {
      const c = to.importNode(n, true);
      // a relative address would be read against the blank page
      if (n.tagName === 'LINK') (c as HTMLLinkElement).href = (n as HTMLLinkElement).href;
      return c;
    }));
    to.title = 'Preview — Proof Writer';
  };
  copy();
  const seen = new MutationObserver(copy);
  seen.observe(document.head, { childList: true });
  seen.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => seen.disconnect();
}

/** Undo, redo, save and open are handled by the main window; pass them on from the other one. */
function passShortcut(e: KeyboardEvent) {
  if (!e.ctrlKey && !e.metaKey) return;
  const copy = new KeyboardEvent('keydown', { key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, cancelable: true });
  if (!window.dispatchEvent(copy)) e.preventDefault();
}

export function detachPreview() {
  if (previewWindow()) { win!.focus(); return; }
  const w = window.open('', NAME, 'popup,width=820,height=1000');
  if (!w) { alert('The new window was blocked. Allow pop-ups for this page to move the preview to its own window.'); return; }
  win = w;
  stopMirroring = mirrorLook(w.document);
  w.document.body.className = 'detached';
  w.document.body.replaceChildren();
  place(w.document.body);
  w.addEventListener('keydown', passShortcut);
  // closing the window puts the preview back
  w.addEventListener('pagehide', () => { if (win === w) attachPreview(); });
  useStore.getState().setPreviewDetached(true);
}

export function attachPreview() {
  const w = win;
  win = null;
  stopMirroring?.();
  stopMirroring = null;
  if (dock) place(dock);
  useStore.getState().setPreviewDetached(false);
  if (w && !w.closed) w.close();
}

export function focusPreviewWindow() {
  previewWindow()?.focus();
}

// the other window cannot outlive this one: everything it shows is drawn from here
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => previewWindow()?.close());
