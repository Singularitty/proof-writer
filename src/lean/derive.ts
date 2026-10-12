// What each block's status is after a build. Nothing here comes from what the
// agent says it did: the statuses follow from Lake's diagnostics, the modules
// Lake says failed, the marker comments and the text of the Lean files. The
// report only adds findings and the names of declarations.

import type { Id } from '../model/types';
import type { Item } from './items';
import type { Finding, JobReport, MechBlock } from './status';
import { declares, imports, markers, scan, type Diagnostic } from './build';

export interface DeriveInput {
  items: Item[];
  /** A statement's id to the ids of the statements its proof cites. */
  cites: Map<Id, Id[]>;
  report: JobReport | null;
  diagnostics: Diagnostic[];
  /** The modules Lake reports as failed, without their `PW.` prefix. */
  failed: string[];
  /** The Lean files after the build, paths relative to the Lean folder. */
  files: { path: string; text: string }[];
  previous: Record<Id, MechBlock>;
  /** The statement a prove job was for; absent for a sync. */
  target?: Id;
  /**
   * Whether the run ended well with a report. Only a sync that did may record
   * a block's new hash: after any other, the Lean text is still a translation
   * of what the block said before.
   */
  trusted: boolean;
}

interface Place { file: string; regions: [number, number][]; firstMarker: number }

const DEFS = 'PW/Defs.lean';
const pathOf = (module: string) => `PW/${module}.lean`;
/** The one file a block's declarations may be in. */
const fileOf = (item: Item) => (item.kind === 'statement' ? pathOf(item.module ?? '') : DEFS);

const within = (p: Place, line: number) => p.regions.some(([a, b]) => line >= a && line <= b);
const sameFinding = (a: Finding, b: Finding) => a.kind === b.kind && a.block === b.block && a.message === b.message
  && a.lean?.file === b.lean?.file && a.lean?.line === b.lean?.line;
const push = (list: Finding[], f: Finding) => { if (!list.some((x) => sameFinding(x, f))) list.push(f); };
const warnsSorry = (d: Diagnostic) => d.severity === 'warning' && /declaration uses 'sorry'/.test(d.message);

export function derive(input: DeriveInput): Record<Id, MechBlock> {
  const { items, report, diagnostics, files, previous, target } = input;
  const sync = target === undefined;
  const texts = new Map(files.map((f) => [f.path, f.text]));
  const scans = new Map(files.map((f) => [f.path, scan(f.text)]));
  const marks = new Map(files.map((f) => [f.path, markers(f.text)]));
  const imported = new Map(files.map((f) => [f.path, imports(f.text)]));
  const failedByLake = new Set(input.failed);
  const moduleOf = (file: string) => file.slice('PW/'.length, -'.lean'.length);
  const axiomIn = (file: string) => scans.get(file)?.axioms[0]?.name;
  const hasError = (file: string) => failedByLake.has(moduleOf(file)) || diagnostics.some((d) => d.severity === 'error' && d.file === file);
  const hasSorry = (file: string) => (scans.get(file)?.sorries.length ?? 0) > 0 || diagnostics.some((d) => d.file === file && warnsSorry(d));
  const missingImports = (file: string) => (imported.get(file) ?? []).filter((m) => !texts.has(pathOf(m)));

  const definitionIds = new Set(items.filter((i) => i.kind !== 'statement').map((i) => i.id));
  /**
   * Where a block's declarations are: the line ranges from each of its
   * markers to the next block's, in its own file and nowhere else. Only the
   * markers of blocks that belong in that file divide it, so what sits under
   * any other marker still counts against a block that does.
   */
  const placeOf = (item: Item): Place | null => {
    const file = fileOf(item);
    const here = (marks.get(file) ?? []).filter((m) => (item.kind === 'statement' ? m.block === item.id : definitionIds.has(m.block)));
    const regions: [number, number][] = [];
    here.forEach((m, i) => {
      if (m.block !== item.id) return;
      const next = here.slice(i + 1).find((x) => x.block !== m.block);
      regions.push([m.line, next ? next.line - 1 : Infinity]);
    });
    return regions.length ? { file, regions, firstMarker: here[0].line } : null;
  };

  const out: Record<Id, MechBlock> = {};

  for (const item of items) {
    const prev = previous[item.id];
    const p = placeOf(item);
    const reported = report?.blocks.find((b) => b.block === item.id);
    const findings: Finding[] = [];
    if (!sync && item.id !== target) {
      // after a prove job the report is about one statement; what was learnt about the others still holds
      for (const f of prev?.findings ?? []) if (f.kind !== 'stuck') push(findings, f);
    } else if (prev && prev.hash === item.hash && !report?.findings.some((f) => f.kind === 'deviation' && f.block === item.id)) {
      // A deviation holds for as long as the Lean text it is about does. A
      // report that names none for a block that has not changed is far more
      // likely to have left it out than to have found it gone.
      for (const f of prev.findings) if (f.kind === 'deviation') push(findings, f);
    }
    for (const f of report?.findings ?? []) if (f.block === item.id || f.related?.includes(item.id)) push(findings, f);

    const own = fileOf(item);
    for (const [file, ms] of marks) {
      if (file !== own && ms.some((m) => m.block === item.id)) push(findings, { kind: 'stuck', block: item.id, message: `A marker for this block is also in ${file}; it is ignored.` });
    }

    let failed = false;
    const fail = (message: string, line?: number) => {
      failed = true;
      push(findings, { kind: 'stuck', block: item.id, message, ...(line !== undefined && p ? { lean: { file: p.file, line } } : {}) });
    };
    if (!p) {
      fail('No Lean declaration was written for this block.');
    } else {
      // a marker alone compiles, and so does one with only a comment under it
      if (!declares(texts.get(p.file) ?? '', p.regions, item.kind === 'statement' ? 'statement' : 'definition')) fail('No Lean declaration was written for this block.');
      // A statement's file is all its own. In the definitions' file an error
      // belongs to the block whose region holds it, and one above the first
      // marker to every block.
      const mine = (line: number) => item.kind === 'statement' || within(p, line) || line < p.firstMarker;
      for (const d of diagnostics) if (d.severity === 'error' && d.file === p.file && mine(d.line)) fail(d.message, d.line);
      // a module can fail with nothing Lake pins to a line: a bad import, a crash
      if (failedByLake.has(moduleOf(p.file))) fail(`Lake reports that PW.${moduleOf(p.file)} failed to build.`);
      for (const m of missingImports(p.file)) fail(`${p.file} imports PW.${m}, which is not in the project.`);
      for (const a of scans.get(p.file)?.axioms ?? []) fail(`${p.file} declares an axiom (${a.name}); nothing may be assumed without proof.`, a.line);
      // A definition must be complete. A `sorry` above the first marker of its file belongs to every definition there.
      if (item.kind !== 'statement') {
        const sorries = [
          ...(scans.get(p.file)?.sorries ?? []),
          ...diagnostics.filter((d) => d.file === p.file && warnsSorry(d)).map((d) => d.line),
        ];
        for (const line of sorries) if (mine(line)) fail('This definition contains `sorry`; definitions must be complete.', line);
      }
    }

    let status: MechBlock['status'] = failed ? 'failed' : 'translated';
    // A statement is only stated or proved by what its file holds: a helper lemma's `sorry` counts too.
    if (!failed && item.kind === 'statement' && p) status = hasSorry(p.file) ? 'stated' : 'proved';
    // The record says which text of the block the Lean files translate, so it
    // moves on only when a sync has finished; a block with no record has no
    // older translation to be confused with.
    const record = prev && !(sync && input.trusted) ? prev : item;
    // where the block's Lean text is: its own file, or, until a sync moves it, the file it was last found in
    const file = p ? p.file : prev && texts.has(prev.file) ? prev.file : '';
    out[item.id] = { kind: record.kind, hash: record.hash, file, names: reported?.names ?? [], status, findings };
  }

  const statements = items.filter((i) => i.kind === 'statement');
  // Lake builds nothing that imports a file that failed, so a statement's own
  // file being clean says nothing once something it rests on is broken.
  if (items.some((i) => i.kind !== 'statement' && out[i.id].status === 'failed')) {
    const defAxiom = axiomIn(DEFS);
    const why = defAxiom !== undefined ? `the definitions declare an axiom (${defAxiom}).` : 'the definitions do not compile.';
    for (const s of statements) {
      if (out[s.id].status === 'failed') continue;
      out[s.id].status = 'failed';
      push(out[s.id].findings, { kind: 'stuck', block: s.id, message: `Not checked: ${why}` });
    }
  }

  const title = new Map(items.map((i) => [i.id, i.title || i.label || i.id]));
  const byId = new Map(items.map((i) => [i.id, i]));
  const statementIn = new Map(statements.map((s) => [fileOf(s), s.id]));
  const ownFailure = new Set(statements.filter((s) => out[s.id].status === 'failed').map((s) => s.id));
  /**
   * Everything a statement rests on, directly or through others: the
   * statements its written proof cites and the modules its file imports. The
   * imports are what Lean uses, whatever the document says, so both count.
   * Imported files that hold no statement are returned by path.
   */
  const reach = (start: Id) => {
    const reached = new Set<Id>();
    const others = new Set<string>();
    const visit = (id: Id) => {
      const take = (next: Id) => {
        if (next === start || reached.has(next)) return;
        reached.add(next);
        visit(next);
      };
      for (const c of input.cites.get(id) ?? []) if (byId.get(c)?.kind === 'statement') take(c);
      const follow = (file: string) => {
        for (const m of imported.get(file) ?? []) {
          const path = pathOf(m);
          const holds = statementIn.get(path);
          if (holds !== undefined) take(holds);
          else if (texts.has(path) && !others.has(path)) { others.add(path); follow(path); }
        }
      };
      follow(fileOf(byId.get(id)!));
    };
    visit(start);
    return { reached: [...reached], others: [...others] };
  };
  /** What is wrong with an imported file that holds no statement, if anything. */
  const problem = (file: string): string | null => {
    if (hasError(file) || missingImports(file).length) return 'does not compile';
    const ax = axiomIn(file);
    if (ax !== undefined) return `declares an axiom (${ax})`;
    return hasSorry(file) ? 'holds a `sorry`' : null;
  };
  for (const s of statements) {
    const b = out[s.id];
    if (b.status === 'failed') continue;
    const { reached, others } = reach(s.id);
    const broken = reached.find((c) => ownFailure.has(c));
    if (broken) {
      const ax = axiomIn(fileOf(byId.get(broken)!));
      b.status = 'failed';
      push(b.findings, { kind: 'stuck', block: s.id, message: ax !== undefined ? `Not checked: ${title.get(broken)} declares an axiom (${ax}).` : `Not checked: ${title.get(broken)} does not compile.` });
      continue;
    }
    // Such a file belongs to no block, so its `sorry` cannot be shown as a
    // statement the proof assumes; the proof is then not called proved at all.
    const bad = others.map((file) => [file, problem(file)] as const).find(([, why]) => why !== null);
    if (bad) {
      b.status = 'failed';
      push(b.findings, { kind: 'stuck', block: s.id, message: `Not checked: ${bad[0]}, which it relies on, ${bad[1]}.` });
      continue;
    }
    if (b.status !== 'proved') continue;
    const assumes = reached.filter((c) => out[c].status === 'stated');
    if (assumes.length) b.assumes = assumes;
    const earlier = previous[s.id]?.proofHash;
    b.proofHash = s.id === target || earlier === undefined ? s.proofHash : earlier;
  }

  // Only a sync that finished has dealt with the blocks the document no
  // longer has; until one does, their records stay, and with them the need
  // for a sync.
  if (!(sync && input.trusted)) for (const [id, b] of Object.entries(previous)) if (!out[id]) out[id] = b;
  return out;
}
