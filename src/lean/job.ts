// One job from start to finish, as the window sees it: tell Claude what to do,
// then build, then work out from the build what is now true and record it.
// The order matters: the build runs whatever the run reported, even after a
// cancel, because the Lean files are whatever they are by then. What the run
// reported decides only how far the result is trusted: whether a sync may
// record that the blocks are translated as they now read, and clear away the
// files of statements that are gone.

import type { Doc, Id } from '../model/types';
import { walkBlocks } from '../export/context';
import { checkDoc } from '../check';
import { uid } from '../model/util';
import type { LeanBridge, LeanBuildResult, LeanRunResult } from '../util/desktop';
import { failedModules, parseBuild } from './build';
import { derive } from './derive';
import { docItems, staleness } from './items';
import { mergeProposals } from './proposals';
import { REPORT_SCHEMA, provePrompt, syncPrompt } from './prompt';
import { docMarkdown } from './snapshot';
import { readReport, type JobReport, type MechBlock, type Mechanization } from './status';
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

/** An error from the main process without Electron's wrapping. */
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** A statement's id to the ids of the statements and definitions its proof cites. */
function citesOf(doc: Doc): Map<Id, Id[]> {
  const report = checkDoc(doc);
  const byLabel = new Map<string, Id>();
  for (const s of report.statements) if (s.label && !byLabel.has(s.label)) byLabel.set(s.label, s.id);
  return new Map(report.statements.map((s) => [s.id, s.cites.map((l) => byLabel.get(l)).filter((x): x is Id => !!x && x !== s.id)]));
}

/**
 * Findings are kept per definition or statement; one about a block inside a
 * proof moves to the statement, remembering the block. The other blocks it
 * names are replaced by their owners in the same way, so it is listed under
 * each of them.
 */
function attach(report: JobReport, own: Map<Id, Id>): JobReport {
  const findings = report.findings.flatMap((f) => {
    const owner = own.get(f.block);
    if (!owner) return [];
    const moved = owner === f.block ? { ...f } : { ...f, block: owner, at: f.at ?? f.block };
    const related = [...new Set((f.related ?? []).flatMap((id) => { const o = own.get(id); return o && o !== owner ? [o] : []; }))];
    if (related.length) moved.related = related;
    else delete moved.related;
    return [moved];
  });
  return { ...report, findings };
}

/**
 * The record as it stands while a proof of `target` is attempted: not proved.
 * The job rewrites the statement's file, so a record of it as proved would be
 * about a file that no longer exists if the job never reports back (the
 * window is closed, another document is opened, the app quits).
 */
function unproved(mech: Mechanization, target: Id): Mechanization | null {
  const rec = mech.blocks[target];
  if (!rec) return null;
  const { proofHash: _proofHash, assumes: _assumes, ...rest } = rec;
  const block: MechBlock = { ...rest, status: rec.status === 'proved' ? 'stated' : rec.status };
  return { ...mech, blocks: { ...mech.blocks, [target]: block } };
}

export async function performJob(d: JobDeps, kind: 'sync' | 'prove', target?: Id): Promise<JobResult> {
  const { bridge, doc, docPath, model, effort } = d;
  const items = docItems(doc);
  const byId = new Map(items.map((i) => [i.id, i]));
  const cites = citesOf(doc);
  const item = target ? byId.get(target) : undefined;
  if (kind === 'prove' && !item) return { mech: d.mech, ok: false, error: 'That statement is no longer in the document.' };

  d.onPhase?.(kind);
  // From here on `mech` is what the status file holds, which is what every
  // way out of this function that records nothing more must return.
  let mech = d.mech;
  const demoted = kind === 'prove' ? unproved(mech, target!) : null;
  if (demoted) {
    await bridge.writeStatus(docPath, demoted);
    mech = demoted;
  }
  const stopped = (error: string): JobResult => ({ mech, ok: false, error });

  const modules = items.flatMap((i) => (i.kind === 'statement' && i.module ? [i.module] : []));
  const prompt = kind === 'sync'
    ? syncPrompt({ items, stale: staleness(items, mech.blocks), cites, first: Object.keys(mech.blocks).length === 0, files: Object.fromEntries(Object.entries(mech.blocks).map(([id, b]) => [id, b.file])) })
    : provePrompt({ item: item!, cited: (cites.get(item!.id) ?? []).map((c) => byId.get(c)).filter((c) => c?.kind === 'statement').map((c) => c!) });
  // A request the main process refuses ends the job like any other failure,
  // so that what was already written to the status file is still returned.
  let ran: LeanRunResult;
  try {
    ran = await bridge.run({ docPath, prompt, snapshot: { json: JSON.stringify(doc, null, 2), md: docMarkdown(doc) }, schema: REPORT_SCHEMA, model, effort, modules });
  } catch (e) {
    return stopped(errorMessage(e));
  }

  const own = owners(doc, new Set(byId.keys()));
  const known = new Set<Id>();
  walkBlocks(doc.blocks, (b) => { known.add(b.id); });
  const read = readReport(ran.report, known);
  // A run that was cancelled, failed, timed out or answered with something
  // that is not a report may have stopped anywhere, so nothing is taken from
  // it but the files it left.
  const trusted = ran.ok && read !== null;

  // A sync also clears away the Lean files of statements the document no
  // longer has, but only one that finished: after any other, such a file may
  // still hold the only copy of a proof the sync was to move. A proof never
  // clears anything, since it can only have touched its own file.
  let built: LeanBuildResult;
  try {
    built = await (kind === 'sync' && trusted ? bridge.build(docPath, modules) : bridge.build(docPath));
  } catch (e) {
    return stopped(errorMessage(e));
  }
  if (!built.started) return stopped(`lake build could not run: ${built.output}`);
  const tail = built.output.trim().split('\n').slice(-6).join('\n');
  // A build that was killed (cancelled, or past its time limit) checked some
  // files and not others, and its output does not say which.
  if (built.code === null) return stopped(`lake build could not run: ${built.cancelled ? 'it was cancelled.' : tail || 'it was stopped before it finished.'}`);
  const diagnostics = parseBuild(built.output);
  // Lake's own account of what failed is asked for only when it says something did; see `failedModules`.
  const failed = built.code === 0 ? [] : failedModules(built.output);
  // Lake failed without a Lean error in one of the project's files and
  // without naming a module (a broken lakefile, a missing toolchain): the
  // files were not checked, so their contents must not be read as statuses
  const paths = new Set(built.files.map((f) => f.path));
  if (built.code !== 0 && !diagnostics.some((x) => x.severity === 'error' && paths.has(x.file)) && !failed.some((m) => paths.has(`PW/${m}.lean`))) {
    return stopped(`lake build could not run: ${tail}`);
  }

  // nothing ran and nothing is there: recording every block as failed would say more than is known.
  // Unless the build removed files, which the record must keep
  if (!ran.ok && !read && built.files.length === 0 && built.removed.length === 0) return stopped(ran.error ?? 'The job failed.');
  const report = read && attach(read, own);

  // A proof revisits the statement and the blocks of its written proof, so
  // their old open proposals give way to what it proposes now
  const oldProposals = kind === 'prove'
    ? mech.proposals.filter((p) => p.state !== 'open' || own.get(p.block) !== target)
    : mech.proposals;
  const blocks = derive({ items, cites, report, diagnostics, failed, files: built.files, previous: mech.blocks, target: kind === 'prove' ? target : undefined, trusted });
  if (kind === 'prove') {
    // The build still decides the statuses; this only says that what was
    // built is not only what the job was allowed to write.
    const foreign = (Array.isArray(ran.touched) ? ran.touched : []).filter((p) => p !== `PW/${item!.module}.lean`);
    if (foreign.length) blocks[target!].findings.push({ kind: 'stuck', block: target!, message: `The proof job also changed ${foreign.join(', ')}, which it may not.` });
  }
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
  // if this cannot be written, the status file still holds `mech`, and that is what is returned
  try {
    await bridge.writeStatus(docPath, next);
  } catch (e) {
    return stopped(errorMessage(e));
  }
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
