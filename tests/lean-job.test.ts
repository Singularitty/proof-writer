import { describe, it, expect } from 'vitest';
import { performJob, proveWithSync, type JobDeps } from '../src/lean/job';
import { REPORT_SCHEMA } from '../src/lean/prompt';
import { emptyMechanization, type Mechanization } from '../src/lean/status';
import { leanView } from '../src/lean/view';
import type { LeanBridge, LeanBuildResult, LeanRunResult } from '../src/util/desktop';
import type { Doc } from '../src/model/types';

const doc: Doc = {
  version: 1, title: 't', author: '', snippets: [], settings: { paper: 'a4', fontSize: 11, numberTheorems: 'shared' },
  blocks: [
    { id: 'r', type: 'rules', title: 'Typing', rules: [{ id: 'r1', name: 'T-True', premises: [], conclusion: 'c' }] },
    { id: 'a', type: 'theorem', kind: 'lemma', title: 'A', label: 'lem:a', statement: 'S', proof: [{ id: 'ta', type: 'text', text: 'Easy.' }] },
    { id: 'b', type: 'theorem', kind: 'theorem', title: 'B', label: 'thm:b', statement: 'S', proof: [{ id: 'tb', type: 'text', text: 'By [[lem:a]].' }] },
  ],
};
const DEFS = { path: 'PW/Defs.lean', text: '-- pw: r\ninductive T where\n  -- pw: r r1\n  | t : T\n' };
const file = (module: string, id: string, proof: string) => ({ path: `PW/${module}.lean`, text: `import PW.Defs\n\n-- pw: ${id}\ntheorem ${id} : True := by\n  ${proof}\n` });
const STATED = [DEFS, file('LemA', 'a', 'sorry'), file('ThmB', 'b', 'sorry')];
const B_PROVED = [DEFS, file('LemA', 'a', 'sorry'), file('ThmB', 'b', 'trivial')];
const built = (files: LeanBuildResult['files'], output = ''): LeanBuildResult => ({ started: true, code: output ? 1 : 0, output, files, removed: [] });
const ok = (report: unknown = { outcome: 'done', summary: 'Done.' }): LeanRunResult => ({ ok: true, report, cancelled: false });

function fake(runs: LeanRunResult[], builds: LeanBuildResult[]) {
  const calls: string[] = [];
  const written: unknown[] = [];
  const jobs: Parameters<LeanBridge['run']>[0][] = [];
  const keeps: (string[] | undefined)[] = [];
  const next = <T,>(list: T[]) => (list.length > 1 ? list.shift()! : list[0]);
  const bridge: LeanBridge = {
    tools: async () => ({ claude: 'claude', lake: 'lake' }),
    open: async () => ({ dir: '/d', status: null }),
    run: async (job) => { calls.push('run'); jobs.push(job); return next(runs); },
    cancel: async () => {},
    build: async (_p, keep) => { calls.push('build'); keeps.push(keep); return next(builds); },
    writeStatus: async (_p, s) => { calls.push('write'); written.push(s); },
    recreate: async () => {},
    reveal: async () => {},
    onEvent: () => () => {},
  };
  return { bridge, calls, written, jobs, keeps };
}
let n = 0;
const deps = (bridge: LeanBridge, over: Partial<JobDeps> = {}): JobDeps =>
  ({ bridge, doc, docPath: '/docs/t.json', mech: emptyMechanization(), model: 'opus', effort: 'high', now: () => new Date('2026-10-12T10:00:00Z'), newId: () => `p${++n}`, ...over });

describe('a sync', () => {
  it('runs Claude, builds, and records statuses from the build', async () => {
    const f = fake([ok()], [built(STATED)]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(f.calls).toEqual(['run', 'build', 'write']);
    expect(f.jobs[0].prompt).toMatch(/^Job: sync/);
    expect(f.jobs[0].prompt).toContain('PW/ThmB.lean');
    expect(JSON.parse(f.jobs[0].snapshot.json)).toEqual(doc);
    expect(f.jobs[0].snapshot.md).toContain('T-True');
    expect(f.jobs[0].schema).toBe(REPORT_SCHEMA);
    expect([f.jobs[0].model, f.jobs[0].effort]).toEqual(['opus', 'high']);
    expect(r.ok).toBe(true);
    expect(Object.fromEntries(Object.entries(r.mech.blocks).map(([id, b]) => [id, b.status]))).toEqual({ r: 'translated', a: 'stated', b: 'stated' });
    expect(r.mech.lastJob).toEqual({ kind: 'sync', endedAt: '2026-10-12T10:00:00.000Z', model: 'opus', effort: 'high', outcome: 'done', summary: 'Done.', changes: [] });
    expect(f.written).toEqual([r.mech]);
  });
  it('does not take the agent’s word for it', async () => {
    const f = fake([ok({ outcome: 'done', summary: 'All proved!' })], [built(STATED, "error: ././././PW/Defs.lean:2:0: unknown identifier 'x'")]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(r.mech.blocks.r.status).toBe('failed');
    expect(r.mech.blocks.a.status).toBe('failed');
  });
  it('moves a finding about a block inside a proof to the statement, keeping where it was', async () => {
    const report = { outcome: 'partial', summary: '', findings: [{ kind: 'stuck', block: 'tb', message: 'This step does not follow.' }, { kind: 'stuck', block: 'nowhere', message: 'x' }] };
    const r = await performJob(deps(fake([ok(report)], [built(STATED)]).bridge), 'sync');
    expect(r.mech.blocks.b.findings).toEqual([{ kind: 'stuck', block: 'b', at: 'tb', message: 'This step does not follow.' }]);
  });
  it('stores proposals with ids, open', async () => {
    const report = { outcome: 'partial', summary: '', proposals: [{ block: 'a', target: { field: 'statement' }, before: 'S', after: 'S, for closed terms', why: 'Needed in the base case.' }] };
    const r = await performJob(deps(fake([ok(report)], [built(STATED)]).bridge), 'sync');
    expect(r.mech.proposals).toHaveLength(1);
    expect(r.mech.proposals[0]).toMatchObject({ block: 'a', state: 'open', after: 'S, for closed terms' });
    expect(r.mech.proposals[0].id).toMatch(/^p\d+$/);
  });
  it('writes nothing when the build cannot run', async () => {
    const f = fake([ok()], [{ started: false, code: null, output: 'spawn lake ENOENT', files: [], removed: [] }]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/lake build could not run.*ENOENT/) });
    expect(r.mech).toEqual(emptyMechanization());
    expect(f.calls).toEqual(['run', 'build']);
  });
  it('writes nothing when Lake fails without a Lean error, whatever the files look like', async () => {
    const f = fake([ok()], [{ started: true, code: 1, output: 'error: lakefile.toml:3:0: unexpected character\n', files: B_PROVED, removed: [] }]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/lake build could not run.*lakefile/s) });
    expect(r.mech).toEqual(emptyMechanization());
    expect(f.calls).toEqual(['run', 'build']);
  });
  it('writes nothing when the run failed before producing anything', async () => {
    const f = fake([{ ok: false, report: null, cancelled: false, error: 'Not logged in' }], [built([])]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(r).toMatchObject({ ok: false, error: 'Not logged in' });
    expect(f.calls).toEqual(['run', 'build']);
  });
  it('passes the statements’ modules as keep, and a proof passes none', async () => {
    const f = fake([ok()], [built(STATED)]);
    const synced = await performJob(deps(f.bridge), 'sync');
    expect(f.keeps[0]).toEqual(['LemA', 'ThmB']);
    await performJob(deps(f.bridge, { mech: synced.mech }), 'prove', 'b');
    expect(f.keeps[1]).toBeUndefined();
  });
  it('records the files the app removed, after the report’s own changes', async () => {
    const report = { outcome: 'done', summary: '', changes: [{ file: 'PW/LemA.lean', name: 'a', change: 'added' }] };
    const f = fake([ok(report)], [{ ...built(STATED), removed: ['PW/Old.lean'] }]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(r.mech.lastJob?.changes).toEqual([
      { file: 'PW/LemA.lean', name: 'a', change: 'added' },
      { file: 'PW/Old.lean', name: '(file)', change: 'removed' },
    ]);
  });
  it('still records the files the build removed when the run failed and nothing is left', async () => {
    const f = fake([{ ok: false, report: null, cancelled: false, error: 'Not logged in' }], [{ ...built([]), removed: ['PW/Old.lean'] }]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(f.calls).toEqual(['run', 'build', 'write']);
    expect(r.ok).toBe(false);
    expect(r.mech.lastJob?.changes).toEqual([{ file: 'PW/Old.lean', name: '(file)', change: 'removed' }]);
  });
  it('records a cancelled job, with statuses from what is on disk', async () => {
    const f = fake([{ ok: false, report: null, cancelled: true, error: 'Cancelled.' }], [built(STATED)]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(r.ok).toBe(false);
    expect(r.mech.lastJob?.outcome).toBe('cancelled');
    expect(r.mech.blocks.a.status).toBe('stated');
    expect(f.calls).toEqual(['run', 'build', 'write']);
  });
});

describe('a proof', () => {
  it('syncs first when something is out of date, then proves', async () => {
    const f = fake([ok(), ok({ outcome: 'done', summary: 'Proved B.' })], [built(STATED), built(B_PROVED)]);
    const phases: string[] = [];
    const r = await proveWithSync(deps(f.bridge, { onPhase: (k) => phases.push(k) }), 'b');
    expect(f.calls).toEqual(['run', 'build', 'write', 'write', 'run', 'build', 'write']);
    expect(phases).toEqual(['sync', 'prove']);
    expect(f.jobs[1].prompt).toMatch(/^Job: prove/);
    expect(f.jobs[1].prompt).toContain('PW/ThmB.lean');
    expect(f.jobs[1].prompt).toContain('PW.LemA');
    expect(r.mech.blocks.b).toMatchObject({ status: 'proved', assumes: ['a'] });
    expect(r.mech.lastJob).toMatchObject({ kind: 'prove', target: 'b', summary: 'Proved B.' });
  });
  it('goes straight to the proof when everything is up to date', async () => {
    const synced = (await performJob(deps(fake([ok()], [built(STATED)]).bridge), 'sync')).mech;
    const f = fake([ok()], [built(B_PROVED)]);
    await proveWithSync(deps(f.bridge, { mech: synced }), 'b');
    expect(f.calls).toEqual(['write', 'run', 'build', 'write']);
    expect(f.jobs[0].prompt).toMatch(/^Job: prove/);
  });
  it('is not attempted when the sync leaves the statement failed', async () => {
    const f = fake([ok()], [built(STATED, "error: ././././PW/Defs.lean:2:0: unknown identifier 'x'")]);
    const r = await proveWithSync(deps(f.bridge), 'b');
    expect(f.calls).toEqual(['run', 'build', 'write']);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not attempted/);
  });
  it('keeps a proof that failed as failed, with Lean’s error', async () => {
    const synced = (await performJob(deps(fake([ok()], [built(STATED)]).bridge), 'sync')).mech;
    const f = fake([ok({ outcome: 'failed', summary: 'Stuck in the base case.' })], [built(B_PROVED, 'error: ././././PW/ThmB.lean:5:2: unsolved goals')]);
    const r = await proveWithSync(deps(f.bridge, { mech: synced }), 'b');
    expect(r.mech.blocks.b.status).toBe('failed');
    expect(r.mech.blocks.b.findings[0]).toMatchObject({ kind: 'stuck', message: 'unsolved goals', lean: { file: 'PW/ThmB.lean', line: 5 } });
    expect(r.mech.blocks.a.status).toBe('stated');
  });
});

describe('proposals after a proof', () => {
  it('give way for blocks inside the proved statement, and only those', async () => {
    const synced = (await performJob(deps(fake([ok()], [built(STATED)]).bridge), 'sync')).mech;
    const old: typeof synced.proposals = [
      { id: 'o1', state: 'open', block: 'tb', target: { field: 'text' }, before: 'By [[lem:a]].', after: 'x', why: 'w' },
      { id: 'o2', state: 'open', block: 'a', target: { field: 'statement' }, before: 'S', after: 'y', why: 'w' },
      { id: 'o3', state: 'dismissed', block: 'tb', target: { field: 'text' }, before: 'By [[lem:a]].', after: 'z', why: 'w' },
    ];
    const f = fake([ok()], [built(B_PROVED)]);
    const r = await performJob(deps(f.bridge, { mech: { ...synced, proposals: old } }), 'prove', 'b');
    expect(r.mech.proposals.map((p) => [p.id, p.state])).toEqual([['o2', 'open'], ['o3', 'dismissed']]);
  });
});

const statusOf = (m: Mechanization) => Object.fromEntries(Object.entries(m.blocks).map(([id, b]) => [id, b.status]));
const PROVED = [DEFS, file('LemA', 'a', 'trivial'), file('ThmB', 'b', 'trivial')];
const failedRun = (error: string, cancelled = false): LeanRunResult => ({ ok: false, report: null, cancelled, error });
/** The document with its rule edited after everything was translated. */
const editedDoc = (): Doc => ({ ...doc, blocks: [{ id: 'r', type: 'rules', title: 'Typing', rules: [{ id: 'r1', name: 'T-True', premises: [], conclusion: 'changed' }] }, ...doc.blocks.slice(1)] });

describe('a sync that did not finish', () => {
  it('leaves edited blocks out of date, however clean the old files build', async () => {
    const proved = (await performJob(deps(fake([ok()], [built(PROVED)]).bridge), 'sync')).mech;
    expect(statusOf(proved)).toEqual({ r: 'translated', a: 'proved', b: 'proved' });
    const edited = editedDoc();
    for (const run of [failedRun('Cancelled.', true), failedRun('Not logged in'), ok('not a report')]) {
      const r = await performJob(deps(fake([run], [built(PROVED)]).bridge, { doc: edited, mech: proved }), 'sync');
      const view = leanView(edited, r.mech);
      expect([...view.byId.values()].map((row) => row.status)).toEqual(['stale', 'stale', 'stale']);
      expect(view.needsSync).toBe(true);
    }
  });
  it('records the edit once a sync has finished', async () => {
    const proved = (await performJob(deps(fake([ok()], [built(PROVED)]).bridge), 'sync')).mech;
    const edited = editedDoc();
    const r = await performJob(deps(fake([ok()], [built(PROVED)]).bridge, { doc: edited, mech: proved }), 'sync');
    const view = leanView(edited, r.mech);
    expect([...view.byId.values()].map((row) => row.status)).toEqual(['translated', 'proved', 'proved']);
    expect(view.needsSync).toBe(false);
  });
  it('does not clear away Lean files: the build is asked to keep everything', async () => {
    const synced = (await performJob(deps(fake([ok()], [built(STATED)]).bridge), 'sync')).mech;
    const relabelled: Doc = { ...doc, blocks: doc.blocks.map((b) => (b.id === 'a' && b.type === 'theorem' ? { ...b, label: 'lem:renamed' } : b)) };
    for (const run of [failedRun('Not logged in'), failedRun('Cancelled.', true), ok('not a report')]) {
      const f = fake([run], [built(STATED)]);
      await performJob(deps(f.bridge, { doc: relabelled, mech: synced }), 'sync');
      expect(f.keeps).toEqual([undefined]);
    }
    const f = fake([ok()], [built(STATED)]);
    await performJob(deps(f.bridge, { doc: relabelled, mech: synced }), 'sync');
    expect(f.keeps).toEqual([['LemRenamed', 'ThmB']]);
  });
});

describe('a build that says less than it seems to', () => {
  it('writes nothing when the build was killed or timed out, whatever the files look like', async () => {
    const f = fake([ok()], [{ started: true, code: null, output: "warning: ././././PW/LemA.lean:5:2: declaration uses 'sorry'\n", files: B_PROVED, removed: [] }]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^lake build could not run/) });
    expect(r.mech).toEqual(emptyMechanization());
    expect(f.calls).toEqual(['run', 'build']);
  });
  it('writes nothing when the build was killed with a Lean error already printed', async () => {
    const f = fake([ok()], [{ started: true, code: null, output: 'error: ././././PW/LemA.lean:5:2: unsolved goals\n', files: B_PROVED, removed: [] }]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^lake build could not run/) });
    expect(f.calls).toEqual(['run', 'build']);
  });
  it('says a cancelled build was cancelled', async () => {
    const f = fake([ok()], [{ started: true, code: null, output: '', files: B_PROVED, removed: [], cancelled: true }]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(r).toMatchObject({ ok: false, error: 'lake build could not run: it was cancelled.' });
    expect(f.calls).toEqual(['run', 'build']);
  });
  it('fails a statement whose module Lake reports as failed with no positioned error', async () => {
    const output = ['✔ [1/4] Built PW.Defs', '✖ [2/4] Building PW.LemA', "error: bad import 'PW.Nope'", 'Some required builds logged failures:', '- PW.LemA', 'error: build failed'].join('\n');
    const r = await performJob(deps(fake([ok()], [built(PROVED, output)]).bridge), 'sync');
    expect(statusOf(r.mech)).toEqual({ r: 'translated', a: 'failed', b: 'failed' });
    expect(r.mech.blocks.a.findings).toEqual([{ kind: 'stuck', block: 'a', message: 'Lake reports that PW.LemA failed to build.' }]);
  });
  it('does not read a failed-looking line of a build that succeeded as a failure', async () => {
    // Lake before 4.9 printed "Building" for every module.
    const r = await performJob(deps(fake([ok()], [{ ...built(PROVED), output: '[1/3] Building PW.Defs\n[2/3] Building PW.LemA\n' }]).bridge), 'sync');
    expect(statusOf(r.mech)).toEqual({ r: 'translated', a: 'proved', b: 'proved' });
  });
  it('writes nothing when the only Lean error is in a file that is not the project’s', async () => {
    const f = fake([ok()], [built(PROVED, 'error: ././././lakefile.lean:3:0: unknown constant')]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^lake build could not run/) });
    expect(f.calls).toEqual(['run', 'build']);
  });
});

describe('what a job is given', () => {
  it('names the statements’ modules, for a sync and for a proof', async () => {
    const f = fake([ok()], [built(STATED)]);
    const synced = await performJob(deps(f.bridge), 'sync');
    await performJob(deps(f.bridge, { mech: synced.mech }), 'prove', 'b');
    expect(f.jobs.map((j) => j.modules)).toEqual([['LemA', 'ThmB'], ['LemA', 'ThmB']]);
  });
  it('tells a sync where a relabelled statement’s Lean text is now', async () => {
    const synced = (await performJob(deps(fake([ok()], [built(STATED)]).bridge), 'sync')).mech;
    const relabelled: Doc = { ...doc, blocks: doc.blocks.map((b) => (b.id === 'a' && b.type === 'theorem' ? { ...b, label: 'lem:renamed' } : b)) };
    const f = fake([ok()], [built(STATED)]);
    await performJob(deps(f.bridge, { doc: relabelled, mech: synced }), 'sync');
    expect(f.jobs[0].prompt).toContain('PW/LemRenamed.lean (its Lean text is currently in PW/LemA.lean; move it to the file named here)');
    expect(f.jobs[0].prompt).not.toContain('PW/ThmB.lean (its Lean text');
  });
});

describe('a prove job and the record', () => {
  const provedB = async () => (await performJob(deps(fake([ok()], [built(B_PROVED)]).bridge), 'sync')).mech;
  it('records its target as not proved before it starts', async () => {
    const mech = await provedB();
    expect(mech.blocks.b).toMatchObject({ status: 'proved', assumes: ['a'], proofHash: expect.any(String) });
    const f = fake([ok()], [built(B_PROVED)]);
    await performJob(deps(f.bridge, { mech }), 'prove', 'b');
    expect(f.calls).toEqual(['write', 'run', 'build', 'write']);
    const first = f.written[0] as Mechanization;
    expect(first.blocks.b.status).toBe('stated');
    expect(first.blocks.b).not.toHaveProperty('proofHash');
    expect(first.blocks.b).not.toHaveProperty('assumes');
    expect(first.blocks.a).toEqual(mech.blocks.a);
    expect(first.lastJob).toEqual(mech.lastJob);
  });
  it('leaves that record standing when the build cannot run', async () => {
    const mech = await provedB();
    const f = fake([ok()], [{ started: true, code: null, output: '', files: B_PROVED, removed: [] }]);
    const r = await performJob(deps(f.bridge, { mech }), 'prove', 'b');
    expect(f.calls).toEqual(['write', 'run', 'build']);
    expect(r.ok).toBe(false);
    expect(r.mech).toEqual(f.written[0]);
    expect(r.mech.blocks.b.status).toBe('stated');
  });
  it('returns that record when the main process refuses the job or the build', async () => {
    const mech = await provedB();
    const refusing = fake([ok()], [built(B_PROVED)]);
    refusing.bridge.run = async () => { throw new Error("Error invoking remote method 'lean-run': Error: Claude Code or Lean was not found."); };
    const r = await performJob(deps(refusing.bridge, { mech }), 'prove', 'b');
    expect(r).toMatchObject({ ok: false, error: 'Claude Code or Lean was not found.' });
    expect(r.mech).toEqual(refusing.written[0]);
    const noBuild = fake([ok()], [built(B_PROVED)]);
    noBuild.bridge.build = async () => { throw new Error('That is not the document this window has open.'); };
    const b = await performJob(deps(noBuild.bridge, { mech }), 'prove', 'b');
    expect(b).toMatchObject({ ok: false, error: 'That is not the document this window has open.' });
    expect(b.mech.blocks.b.status).toBe('stated');
  });
  it('does not call a failed target stated', async () => {
    const mech = await provedB();
    const failed: Mechanization = { ...mech, blocks: { ...mech.blocks, b: { ...mech.blocks.b, status: 'failed' } } };
    const f = fake([ok()], [{ started: false, code: null, output: 'x', files: [], removed: [] }]);
    await performJob(deps(f.bridge, { mech: failed }), 'prove', 'b');
    expect((f.written[0] as Mechanization).blocks.b.status).toBe('failed');
  });
  it('never moves a block’s recorded hash', async () => {
    const mech = await provedB();
    const r = await performJob(deps(fake([ok()], [built(B_PROVED)]).bridge, { doc: editedDoc(), mech }), 'prove', 'b');
    expect(r.mech.blocks.r.hash).toBe(mech.blocks.r.hash);
  });
  it('keeps a recorded deviation on the statement it proves', async () => {
    const deviation = { kind: 'deviation', block: 'b', message: 'Adds that the context is well formed.' };
    const synced = (await performJob(deps(fake([ok({ outcome: 'done', summary: '', findings: [deviation] })], [built(STATED)]).bridge), 'sync')).mech;
    const r = await performJob(deps(fake([ok()], [built(B_PROVED)]).bridge, { mech: synced }), 'prove', 'b');
    expect(r.mech.blocks.b.status).toBe('proved');
    expect(r.mech.blocks.b.findings).toEqual([deviation]);
  });
  it('says so when the job changed files other than its own', async () => {
    const mech = await provedB();
    const run = { ...ok(), touched: ['PW/ThmB.lean', 'PW/Defs.lean', 'CONVENTIONS.md'] };
    const r = await performJob(deps(fake([run], [built(B_PROVED)]).bridge, { mech }), 'prove', 'b');
    expect(r.mech.blocks.b.status).toBe('proved');
    expect(r.mech.blocks.b.findings).toEqual([{ kind: 'stuck', block: 'b', message: 'The proof job also changed PW/Defs.lean, CONVENTIONS.md, which it may not.' }]);
    const own = await performJob(deps(fake([{ ...ok(), touched: ['PW/ThmB.lean'] }], [built(B_PROVED)]).bridge, { mech }), 'prove', 'b');
    expect(own.mech.blocks.b.findings).toEqual([]);
    const sync = await performJob(deps(fake([run], [built(B_PROVED)]).bridge, { mech }), 'sync');
    expect(sync.mech.blocks.b.findings).toEqual([]);
  });
});

describe('findings that name other blocks', () => {
  it('reach the statement that owns a related block inside a proof', async () => {
    const report = { outcome: 'partial', summary: '', findings: [{ kind: 'inconsistency', block: 'r', related: ['ta', 'tb', 'r', 'nowhere'], message: 'The rule and the proofs disagree.' }] };
    const r = await performJob(deps(fake([ok(report)], [built(STATED)]).bridge), 'sync');
    const finding = { kind: 'inconsistency', block: 'r', related: ['a', 'b'], message: 'The rule and the proofs disagree.' };
    expect(r.mech.blocks.r.findings).toEqual([finding]);
    expect(r.mech.blocks.a.findings).toEqual([finding]);
    expect(r.mech.blocks.b.findings).toEqual([finding]);
  });
});
