/// <reference lib="webworker" />
import { createTypstCompiler, loadFonts, type TypstCompiler } from '@myriaddreamin/typst.ts';
import type { IncrementalServer } from '@myriaddreamin/typst.ts/compiler';
import type { Anchor } from './anchors';
import compilerWasm from '@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm?url';

const FONTS = [
  'NewCM10-Regular.otf', 'NewCM10-Bold.otf', 'NewCM10-Italic.otf', 'NewCM10-BoldItalic.otf',
  'NewCMMath-Regular.otf', 'DejaVuSansMono.ttf',
];

/**
 * `pdf` compiles a document to a PDF. `live` compiles for the preview: the
 * compiler remembers what it last sent and answers with only what changed,
 * unless `full` asks for the whole document again.
 */
export type WorkerRequest =
  | { id: number; kind: 'pdf'; source: string; fontBase: string }
  | { id: number; kind: 'live'; source: string; fontBase: string; full: boolean };
export type WorkerResponse =
  | { id: number; ok: true; data: Uint8Array; diagnostics: string[]; ms: number; /** Where each block starts, when the source carries anchors. */ anchors: Anchor[]; /** The data is the whole document, not a change to the last one. */ full: boolean }
  | { id: number; ok: false; diagnostics: string[]; /** The compiler itself failed, and cannot be used again. */ crashed?: boolean };

let compilerP: Promise<TypstCompiler> | null = null;

function getCompiler(fontBase: string): Promise<TypstCompiler> {
  if (!compilerP) {
    compilerP = (async () => {
      const c = createTypstCompiler();
      await c.init({
        getModule: () => compilerWasm,
        beforeBuild: [loadFonts(FONTS.map((f) => fontBase + f), { assets: false })],
      });
      return c;
    })();
  }
  return compilerP;
}

/** The compiler's memory of the document the preview holds. It lives as long as the worker. */
let serverP: Promise<IncrementalServer> | null = null;
let sentAny = false;
function getServer(c: TypstCompiler): Promise<IncrementalServer> {
  if (!serverP) {
    serverP = new Promise((resolve) => {
      // the server is freed when this callback's promise settles, so it never does
      void c.withIncrementalServer((s) => { resolve(s); return new Promise<void>(() => {}); });
    });
  }
  return serverP;
}

function fmtDiag(d: unknown): string {
  if (typeof d === 'string') return d;
  const x = d as { severity?: string; range?: string; message?: string; path?: string };
  return `${x.severity ?? 'error'} ${x.path ?? ''}:${x.range ?? ''} ${x.message ?? JSON.stringify(d)}`;
}

async function handle(req: WorkerRequest): Promise<WorkerResponse> {
  const { id, source, fontBase } = req;
  const t0 = performance.now();
  try {
    const c = await getCompiler(fontBase);
    c.addSource('/main.typ', source);
    if (req.kind === 'pdf') {
      const r = await c.compile({ mainFilePath: '/main.typ', format: 1, diagnostics: 'full' });
      const diagnostics = (r.diagnostics ?? []).map(fmtDiag);
      if (!r.result) return { id, ok: false, diagnostics };
      return { id, ok: true, data: r.result, diagnostics, ms: performance.now() - t0, anchors: [], full: true };
    }
    const server = await getServer(c);
    const full = req.full || !sentAny;
    if (req.full && sentAny) server.reset();
    const r = await c.compile({ mainFilePath: '/main.typ', incrementalServer: server, diagnostics: 'full' });
    const diagnostics = (r.diagnostics ?? []).map(fmtDiag);
    if (!r.result) return { id, ok: false, diagnostics };
    sentAny = true;
    let anchors: Anchor[] = [];
    if (source.includes('<pw-src>')) {
      try {
        // a query needs a compiled snapshot of its own; Typst's cache makes the second compile cheap
        anchors = await c.runWithWorld({ mainFilePath: '/main.typ' }, async (world) => {
          await world.compile({ diagnostics: 'none' });
          return ((await world.query({ selector: '<pw-src>', field: 'value' })) as Anchor[]) ?? [];
        });
      } catch { /* without anchors, clicking the preview does nothing */ }
    }
    return { id, ok: true, data: r.result, diagnostics, ms: performance.now() - t0, anchors, full };
  } catch (e) {
    // An error in the source comes back as diagnostics. Anything thrown is the compiler
    // failing part-way through a call, which leaves it refusing every call after.
    return { id, ok: false, crashed: true, diagnostics: [String(e instanceof Error ? e.message : e)] };
  }
}

// One request at a time, in the order they came: each change builds on the one before.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  queue = queue.then(async () => {
    const res = await handle(ev.data);
    if (res.ok) self.postMessage(res, [res.data.buffer]);
    else self.postMessage(res);
  });
};
