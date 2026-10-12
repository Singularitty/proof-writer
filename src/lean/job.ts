// One job from start to finish, as the window sees it: tell Claude what to do,
// then build, then work out from the build what is now true and record it.
// The order matters: the build runs whatever the run reported, even after a
// cancel, because the Lean files are whatever they are by then.

import type { Doc, Id } from '../model/types';
import { walkBlocks } from '../export/context';
import { checkDoc } from '../check';
import { uid } from '../model/util';
import type { LeanBridge } from '../util/desktop';
import { parseBuild } from './build';
import { derive } from './derive';
import { docItems, staleness } from './items';
import { mergeProposals } from './proposals';
import { REPORT_SCHEMA, provePrompt, syncPrompt } from './prompt';
import { docMarkdown } from './snapshot';
import { readReport, type JobReport, type Mechanization } from './status';
import { leanView, owners } from './view';

export interface JobDeps {
  bridge: LeanBridge;
  doc: Doc;
  docPath: string;
  mech: Mechanization;
  /** '' leaves the choice to the user's Claude Code settings. */
  model: string;
  effort: string;
  now?: () => Date;
  newId?: () => string;
  /** Called as each job of a proof request starts: the sync, if one is needed, then the proof. */
  onPhase?: (kind: 'sync' | 'prove') => void;
}

export interface JobResult { mech: Mechanization; ok: boolean; error: string | null }

/** A statement's id to the ids of the statements and definitions its proof cites. */
function citesOf(doc: Doc): Map<Id, Id[]> {
  const report = checkDoc(doc);
  const byLabel = new Map<string, Id>();
  for (const s of report.statements) if (s.label && !byLabel.has(s.label)) byLabel.set(s.label, s.id);
  return new Map(report.statements.map((s) => [s.id, s.cites.map((l) => byLabel.get(l)).filter((x): x is Id => !!x && x !== s.id)]));
}

/** Findings are kept per definition or statement; one about a block inside a proof moves to the statement, remembering the block. */
function attach(report: JobReport, own: Map<Id, Id>): JobReport {
  const findings = report.findings.flatMap((f) => {
    const owner = own.get(f.block);
    if (!owner) return [];
    return [owner === f.block ? f : { ...f, block: owner, at: f.at ?? f.block }];
  });
  return { ...report, findings };
}

export async function performJob(d: JobDeps, kind: 'sync' | 'prove', target?: Id): Promise<JobResult> {
  const { bridge, doc, docPath, mech, model, effort } = d;
  const items = docItems(doc);
  const byId = new Map(items.map((i) => [i.id, i]));
  const cites = citesOf(doc);
  const item = target ? byId.get(target) : undefined;
  if (kind === 'prove' && !item) return { mech, ok: false, error: 'That statement is no longer in the document.' };

  d.onPhase?.(kind);
  const prompt = kind === 'sync'
    ? syncPrompt({ items, stale: staleness(items, mech.blocks), cites, first: Object.keys(mech.blocks).length === 0 })
    : provePrompt({ item: item!, cited: (cites.get(item!.id) ?? []).map((c) => byId.get(c)).filter((c) => c?.kind === 'statement').map((c) => c!) });
  const ran = await bridge.run({ docPath, prompt, snapshot: { json: JSON.stringify(doc, null, 2), md: docMarkdown(doc) }, schema: REPORT_SCHEMA, model, effort });

  // A sync also clears away the Lean files of statements the document no
  // longer has; a proof never does, since it can only have touched its own
  const keep = items.flatMap((i) => (i.kind === 'statement' && i.module ? [i.module] : []));
  const built = await (kind === 'sync' ? bridge.build(docPath, keep) : bridge.build(docPath));
  if (!built.started) return { mech, ok: false, error: `lake build could not run: ${built.output}` };
  const diagnostics = parseBuild(built.output);
  // Lake failed without a single Lean error (a broken lakefile, a missing
  // toolchain, a build cut short): the files were not checked, so their
  // contents must not be read as statuses
  if (built.code !== 0 && !diagnostics.some((x) => x.severity === 'error')) {
    return { mech, ok: false, error: `lake build could not run: ${built.output.trim().split('\n').slice(-6).join('\n')}` };
  }

  const own = owners(doc, new Set(byId.keys()));
  const known = new Set<Id>();
  walkBlocks(doc.blocks, (b) => { known.add(b.id); });
  const read = readReport(ran.report, known);
  // nothing ran and nothing is there: recording every block as failed would say more than is known.
  // Unless the build removed files, which the record must keep
  if (!ran.ok && !read && built.files.length === 0 && built.removed.length === 0) return { mech, ok: false, error: ran.error ?? 'The job failed.' };
  const report = read && attach(read, own);

  // A proof revisits the statement and the blocks of its written proof, so
  // their old open proposals give way to what it proposes now
  const oldProposals = kind === 'prove'
    ? mech.proposals.filter((p) => p.state !== 'open' || own.get(p.block) !== target)
    : mech.proposals;
  const blocks = derive({ items, cites, report, diagnostics, files: built.files, previous: mech.blocks, target: kind === 'prove' ? target : undefined });
  const next: Mechanization = {
    version: 1,
    blocks,
    proposals: mergeProposals(oldProposals, read?.proposals ?? [], kind === 'prove' ? target! : null, d.newId ?? uid),
    lastJob: {
      kind,
      ...(kind === 'prove' ? { target } : {}),
      endedAt: (d.now?.() ?? new Date()).toISOString(),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      outcome: ran.cancelled ? 'cancelled' : read?.outcome ?? 'failed',
      summary: read?.summary || ran.error || '',
      changes: [...(read?.changes ?? []), ...built.removed.map((file) => ({ file, name: '(file)', change: 'removed' as const }))],
    },
  };
  await bridge.writeStatus(docPath, next);
  return { mech: next, ok: ran.ok, error: ran.ok ? null : ran.error ?? 'The job failed.' };
}

/** A proof request: the definitions and statements are brought up to date first, and the proof is not attempted if that fails. */
export async function proveWithSync(d: JobDeps, target: Id): Promise<JobResult> {
  let mech = d.mech;
  if (leanView(d.doc, mech).needsSync) {
    const synced = await performJob(d, 'sync');
    mech = synced.mech;
    const status = mech.blocks[target]?.status;
    if (!synced.ok || !status || status === 'failed') {
      return { mech, ok: false, error: synced.error ?? 'The statement does not compile after the sync, so its proof was not attempted.' };
    }
  }
  return performJob({ ...d, mech }, 'prove', target);
}
