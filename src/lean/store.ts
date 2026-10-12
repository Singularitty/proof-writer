// The Lean state of the open document, for the tab and the dots on statements:
// what the status file holds, the job that is running, and the model and
// effort the next job will use. Kept apart from the document store because
// none of it is part of the document or its undo history.

import { create } from 'zustand';
import type { Doc, Id } from '../model/types';
import { useStore } from '../store';
import { desktop, type LeanTools } from '../util/desktop';
import { performJob, proveWithSync, type JobDeps, type JobResult } from './job';
import { EFFORTS, MODELS, type Effort, type Model } from './prompt';
import { applyProposal } from './proposals';
import { emptyMechanization, readMechanization, type Mechanization } from './status';

const PREFS_KEY = 'proof-writer:lean';
const MAX_LINES = 8;

interface Prefs { model: Model | ''; effort: Effort | '' }

function readPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return {
      model: (MODELS as readonly string[]).includes(v.model ?? '') ? (v.model as Model) : '',
      effort: (EFFORTS as readonly string[]).includes(v.effort ?? '') ? (v.effort as Effort) : '',
    };
  } catch {
    return { model: '', effort: '' };
  }
}
/** Losing this is harmless, so a failure is not reported. */
function keepPrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

export interface RunningJob { kind: 'sync' | 'prove'; target?: Id; lines: string[]; model: string; effort: string }

interface LeanState extends Prefs {
  /** The file of the open document; null when it has none. */
  docPath: string | null;
  tools: LeanTools | null;
  dir: string | null;
  mech: Mechanization;
  job: RunningJob | null;
  error: string | null;
  /** The row the tab was last asked to show; `n` makes each request distinct. */
  focus: { id: Id; n: number } | null;

  load: (docPath: string | null) => Promise<void>;
  checkTools: () => Promise<void>;
  sync: () => Promise<void>;
  prove: (id: Id) => Promise<void>;
  cancel: () => void;
  /** Accepts or dismisses a proposal. Accepting edits the document as one undo step. */
  settle: (proposalId: string, accept: boolean) => Promise<void>;
  recreate: () => Promise<void>;
  reveal: () => void;
  setModel: (m: Model | '') => void;
  setEffort: (e: Effort | '') => void;
  show: (id: Id) => void;
}

/** An error from the main process without Electron's wrapping. */
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let listening = false;
function listen() {
  if (listening || !desktop) return;
  listening = true;
  desktop.lean.onEvent(({ line }) => {
    useLean.setState((s) => (s.job ? { job: { ...s.job, lines: [...s.job.lines, line].slice(-MAX_LINES) } } : {}));
  });
}

async function start(kind: 'sync' | 'prove', target?: Id) {
  const s = useLean.getState();
  if (!desktop || !s.docPath || s.job) return;
  const docPath = s.docPath;
  const { model, effort } = s;
  useLean.setState({ job: { kind, target, lines: [], model, effort }, error: null });
  try {
    const deps: JobDeps = {
      bridge: desktop.lean, doc: useStore.getState().doc, docPath, mech: s.mech, model, effort,
      onPhase: (k) => useLean.setState((st) => (st.job ? { job: { ...st.job, kind: k, lines: [] } } : {})),
    };
    const r: JobResult = kind === 'sync' ? await performJob(deps, 'sync') : await proveWithSync(deps, target!);
    // the user may have opened another document meanwhile; this result is not about it
    if (useLean.getState().docPath === docPath) useLean.setState({ mech: r.mech, error: r.error });
  } catch (e) {
    useLean.setState({ error: message(e) });
  } finally {
    useLean.setState({ job: null });
  }
}

export const useLean = create<LeanState>((set, get) => ({
  ...readPrefs(),
  docPath: null,
  tools: null,
  dir: null,
  mech: emptyMechanization(),
  job: null,
  error: null,
  focus: null,

  load: async (docPath) => {
    set({ docPath, dir: null, mech: emptyMechanization(), error: null });
    if (!desktop) return;
    listen();
    try {
      const tools = await desktop.lean.tools();
      if (!docPath) { set({ tools }); return; }
      // the main process serves only the document this window is watching
      await desktop.watchDocument(docPath);
      const { dir, status } = await desktop.lean.open(docPath);
      if (get().docPath === docPath) set({ tools, dir, mech: readMechanization(status) });
    } catch (e) {
      set({ error: message(e) });
    }
  },
  checkTools: async () => {
    if (desktop) set({ tools: await desktop.lean.tools() });
  },
  sync: () => start('sync'),
  prove: (id) => start('prove', id),
  cancel: () => { void desktop?.lean.cancel(); },
  settle: async (proposalId, accept) => {
    const { mech, docPath } = get();
    const p = mech.proposals.find((x) => x.id === proposalId);
    if (!p || p.state !== 'open') return;
    if (accept) {
      let applied = false;
      useStore.getState().update((d) => { applied = applyProposal(d as Doc, p); });
      if (!applied) return;
    }
    const next: Mechanization = { ...mech, proposals: mech.proposals.map((x) => (x.id === proposalId ? { ...x, state: accept ? 'accepted' as const : 'dismissed' as const } : x)) };
    set({ mech: next });
    if (desktop && docPath) {
      try { await desktop.lean.writeStatus(docPath, next); } catch (e) { set({ error: message(e) }); }
    }
  },
  recreate: async () => {
    const { docPath } = get();
    if (!desktop || !docPath) return;
    try { await desktop.lean.recreate(docPath); set({ error: null }); } catch (e) { set({ error: message(e) }); }
  },
  reveal: () => {
    const { docPath } = get();
    if (desktop && docPath) void desktop.lean.reveal(docPath).catch(() => {});
  },
  setModel: (model) => { set({ model }); keepPrefs({ model, effort: get().effort }); },
  setEffort: (effort) => { set({ effort }); keepPrefs({ model: get().model, effort }); },
  show: (id) => {
    useStore.getState().showView('sidebar');
    set({ focus: { id, n: (get().focus?.n ?? 0) + 1 } });
  },
}));
