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
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const cb = pending.get(ev.data.id);
      pending.delete(ev.data.id);
      cb?.(ev.data);
    };
  }
  return worker;
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

let sessionP: Promise<RenderSession> | null = null;
function getSession(r: TypstRenderer): Promise<RenderSession> {
  if (!sessionP) {
    sessionP = new Promise((resolve) => {
      // the session is freed when this callback's promise settles, so it never does
      void r.runWithSession((s) => { resolve(s); return new Promise<void>(() => {}); });
    });
  }
  return sessionP;
}

/** The element the preview is drawn in. It outlives the component showing it, so coming back to the PDF tab costs nothing. */
export const livePages: HTMLDivElement | null = typeof document === 'undefined' ? null : Object.assign(document.createElement('div'), { className: 'pages' });

/** Heights of the pages now drawn, in points. */
let heights: number[] = [];
export const pageHeights = () => heights;

/** True when the renderer's copy of the document can no longer be trusted, and the compiler must send it whole. */
let needFull = true;
/** True while the page shows exactly what the renderer last described, so the next change can be patched in. */
let pageInStep = false;

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

async function apply(r: TypstRenderer, session: RenderSession, res: Extract<WorkerResponse, { ok: true }>) {
  const host = livePages!;
  r.manipulateData({ renderSession: session, action: res.full ? 'reset' : 'merge', data: res.data });
  // the drawing, described in terms of the one before it
  const drawing = r.renderSvgDiff({ renderSession: session });
  const current = host.firstElementChild as SVGElement | null;
  let patched = false;
  if (current && pageInStep) {
    try {
      const t = document.createElement('template');
      t.innerHTML = drawing;
      patchRoot(current, t.content.firstElementChild as SVGElement);
      patched = true;
    } catch { /* the page had drifted from what the renderer assumed: draw it whole below */ }
  }
  if (!patched) {
    pageInStep = false;
    host.innerHTML = await r.renderSvg({ renderSession: session });
    pageInStep = true;
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
  const session = await getSession(r);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ask({ kind: 'live', source, full: needFull });
    if (!res.ok) return res;
    const done = applying.then(async () => {
      // a change can only be merged into the document it was made against
      if (needFull && !res.full) return false;
      try {
        await apply(r, session, res);
        needFull = false;
        return true;
      } catch {
        needFull = true;
        return false;
      }
    });
    applying = done;
    if (await done) return { ok: true, diagnostics: res.diagnostics, ms: res.ms, anchors: res.anchors };
  }
  return { ok: false, diagnostics: ['The preview could not be drawn.'] };
}
