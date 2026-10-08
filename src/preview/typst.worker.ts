/// <reference lib="webworker" />
import { createTypstCompiler, loadFonts, type TypstCompiler } from '@myriaddreamin/typst.ts';
import compilerWasm from '@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm?url';

const FONTS = [
  'NewCM10-Regular.otf', 'NewCM10-Bold.otf', 'NewCM10-Italic.otf', 'NewCM10-BoldItalic.otf',
  'NewCMMath-Regular.otf', 'DejaVuSansMono.ttf',
];

export type WorkerRequest = { id: number; source: string; format: 'vector' | 'pdf'; fontBase: string };
export type WorkerResponse =
  | { id: number; ok: true; data: Uint8Array; diagnostics: string[]; ms: number }
  | { id: number; ok: false; diagnostics: string[] };

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

function fmtDiag(d: unknown): string {
  if (typeof d === 'string') return d;
  const x = d as { severity?: string; range?: string; message?: string; path?: string };
  return `${x.severity ?? 'error'} ${x.path ?? ''}:${x.range ?? ''} ${x.message ?? JSON.stringify(d)}`;
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const { id, source, format, fontBase } = ev.data;
  const t0 = performance.now();
  try {
    const c = await getCompiler(fontBase);
    c.addSource('/main.typ', source);
    const r = await c.compile({ mainFilePath: '/main.typ', format: format === 'pdf' ? 1 : 0, diagnostics: 'full' });
    const diagnostics = (r.diagnostics ?? []).map(fmtDiag);
    if (!r.result) {
      self.postMessage({ id, ok: false, diagnostics } satisfies WorkerResponse);
      return;
    }
    const data = r.result;
    self.postMessage({ id, ok: true, data, diagnostics, ms: performance.now() - t0 } satisfies WorkerResponse, [data.buffer]);
  } catch (e) {
    self.postMessage({ id, ok: false, diagnostics: [String(e instanceof Error ? e.message : e)] } satisfies WorkerResponse);
  }
};
