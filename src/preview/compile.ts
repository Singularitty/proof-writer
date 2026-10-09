import type { WorkerRequest, WorkerResponse } from './typst.worker';
import { createTypstRenderer, type TypstRenderer } from '@myriaddreamin/typst.ts';
import type { RenderSession } from '@myriaddreamin/typst.ts/renderer';
import { patchRoot } from '@myriaddreamin/typst.ts/render/svg/patch';
import rendererWasm from '@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm?url';
import type { Anchor } from './anchors';
import { PAGE_GAP, pageTops, totalHeight } from './pages';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (r: WorkerResponse) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./typst.worker.ts', import.meta.url), { type: 'module' });
    const w = worker;
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      if (!ev.data.ok && ev.data.crashed) return dropWorker(w, ev.data.diagnostics);
      const cb = pending.get(ev.data.id);
      pending.delete(ev.data.id);
      cb?.(ev.data);
    };
  }
  return worker;
}

/** Ends a worker whose compiler crashed. The next request starts a new one; the requests it still held are answered as failed. */
function dropWorker(w: Worker, diagnostics: string[]) {
  if (w !== worker) return;
  w.terminate();
  worker = null;
  const waiting = [...pending];
  pending.clear();
  for (const [id, cb] of waiting) cb({ id, ok: false, crashed: true, diagnostics });
}

type Ask = { kind: 'pdf'; source: string } | { kind: 'live'; source: string; full: boolean };
function ask(req: Ask): Promise<WorkerResponse> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage({ id, fontBase: new URL('fonts/', document.baseURI).href, ...req } satisfies WorkerRequest);
  });
}

/** Compiles a document to a PDF. */
export function compilePdf(source: string): Promise<WorkerResponse> {
  return ask({ kind: 'pdf', source });
}

// ---------- the live preview ----------
//
// The preview is not redrawn from scratch. The compiler sends only what an edit
// changed; the renderer keeps the document in a session and describes the new
// drawing in terms of the old one; and the page is patched in place, so an edit
// touches the few elements it affected.

let rendererP: Promise<TypstRenderer> | null = null;
function getRenderer(): Promise<TypstRenderer> {
  if (!rendererP) {
    rendererP = (async () => {
      const r = createTypstRenderer();
      await r.init({ getModule: () => rendererWasm });
      return r;
    })();
  }
  return rendererP;
}

/** The renderer's copy of the document, and a way to let go of it. */
let session: { s: RenderSession; free: () => void } | null = null;

/** Starts a new session, dropping the one before. A session's first drawing is complete; later ones describe changes. */
function newSession(r: TypstRenderer): Promise<RenderSession> {
  session?.free();
  session = null;
  return new Promise((resolve) => {
    // the session lives until `free` settles the callback's promise
    void r.runWithSession((s) => new Promise<void>((free) => { session = { s, free }; resolve(s); }));
  });
}

/** The renderer's own style rules, which its change-by-change drawings leave out. Added to the page once. */
async function addBaseStyles(r: TypstRenderer, s: RenderSession) {
  if (document.getElementById('pw-typst-css')) return;
  const only = await r.renderSvg({ renderSession: s, data_selection: { body: false, defs: false, css: true, js: false } });
  const t = document.createElement('template');
  t.innerHTML = only;
  const style = document.createElement('style');
  style.id = 'pw-typst-css';
  style.textContent = [...t.content.querySelectorAll('style')].map((x) => x.textContent ?? '').join('\n');
  document.head.appendChild(style);
}

/** The element the preview is drawn in. It outlives the component showing it, so coming back to the PDF tab costs nothing. */
export const livePages: HTMLDivElement | null = typeof document === 'undefined' ? null : Object.assign(document.createElement('div'), { className: 'pages' });

/** Heights of the pages now drawn, in points. */
let heights: number[] = [];
export const pageHeights = () => heights;

/** True when the page or the renderer's copy of the document cannot be trusted, and the compiler must send the document whole. */
let needFull = true;

/** Spreads the pages out as separate sheets. The patch puts them back edge to edge each time. */
function layOut(svg: SVGElement) {
  const pages = [...svg.querySelectorAll<SVGGElement>(':scope > g.typst-page')];
  heights = pages.map((p) => Number(p.getAttribute('data-page-height')));
  const width = Math.max(0, ...pages.map((p) => Number(p.getAttribute('data-page-width'))));
  const tops = pageTops(heights, PAGE_GAP);
  pages.forEach((p, i) => p.setAttribute('transform', `translate(0, ${tops[i]})`));
  const total = totalHeight(heights, PAGE_GAP);
  svg.setAttribute('viewBox', `0 0 ${width} ${total}`);
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  // the sheets are painted behind the pages; this assumes one paper size, which is all a document has
  const host = livePages!;
  host.style.setProperty('--pw-sheet', `${total ? (heights[0] / total) * 100 : 100}%`);
  host.style.setProperty('--pw-period', `${total ? ((heights[0] + PAGE_GAP) / total) * 100 : 100}%`);
}

async function apply(r: TypstRenderer, res: Extract<WorkerResponse, { ok: true }>) {
  const host = livePages!;
  if (res.full || !session) {
    // A whole document goes into a new session, whose first drawing is complete.
    // The page has to start from that drawing: later changes are patches to it.
    const s = await newSession(r);
    r.manipulateData({ renderSession: s, action: 'reset', data: res.data });
    host.innerHTML = r.renderSvgDiff({ renderSession: s });
    await addBaseStyles(r, s);
  } else {
    const s = session.s;
    r.manipulateData({ renderSession: s, action: 'merge', data: res.data });
    // the new drawing, described in terms of the one on the page
    const t = document.createElement('template');
    t.innerHTML = r.renderSvgDiff({ renderSession: s });
    patchRoot(host.firstElementChild as SVGElement, t.content.firstElementChild as SVGElement);
  }
  layOut(host.firstElementChild as SVGElement);
}

export type LiveResult =
  | { ok: true; diagnostics: string[]; ms: number; anchors: Anchor[] }
  | { ok: false; diagnostics: string[] };

// Changes are applied one at a time, in the order they were compiled.
let applying: Promise<unknown> = Promise.resolve();

/** Compiles `source` and brings the preview up to date with it. */
export async function renderLive(source: string): Promise<LiveResult> {
  const r = await getRenderer();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ask({ kind: 'live', source, full: needFull });
    if (!res.ok) {
      if (!res.crashed) return res;
      // the compiler was restarted and remembers nothing; try once more in case the document was not the cause
      needFull = true;
      if (attempt === 0) continue;
      return { ok: false, diagnostics: [`The Typst compiler crashed on this document and was restarted (${res.diagnostics.join('; ')}).`] };
    }
    const done = applying.then(async () => {
      // a change can only be applied to the document it was made against
      if (needFull && !res.full) return false;
      try {
        await apply(r, res);
        needFull = false;
        return true;
      } catch {
        // the page and the session may now disagree: start over from the whole document
        needFull = true;
        return false;
      }
    });
    applying = done;
    if (await done) return { ok: true, diagnostics: res.diagnostics, ms: res.ms, anchors: res.anchors };
  }
  return { ok: false, diagnostics: ['The preview could not be drawn.'] };
}
