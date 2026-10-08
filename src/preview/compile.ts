import type { WorkerRequest, WorkerResponse } from './typst.worker';
import { createTypstRenderer, type TypstRenderer } from '@myriaddreamin/typst.ts';
import rendererWasm from '@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm?url';

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

export function compileTypst(source: string, format: 'vector' | 'pdf'): Promise<WorkerResponse> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    getWorker().postMessage({ id, source, format, fontBase: new URL('fonts/', document.baseURI).href } satisfies WorkerRequest);
  });
}

let rendererP: Promise<TypstRenderer> | null = null;
export function getRenderer(): Promise<TypstRenderer> {
  if (!rendererP) {
    rendererP = (async () => {
      const r = createTypstRenderer();
      await r.init({ getModule: () => rendererWasm });
      return r;
    })();
  }
  return rendererP;
}

export async function vectorToSvg(vector: Uint8Array): Promise<string> {
  const r = await getRenderer();
  return r.renderSvg({ format: 'vector', artifactContent: vector } as never);
}
