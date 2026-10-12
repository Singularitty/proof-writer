// What each block's status is after a build. Nothing here comes from what the
// agent says it did: the statuses follow from Lake's diagnostics, the marker
// comments and the text of the Lean files. The report only adds findings and
// the names of declarations.

import type { Id } from '../model/types';
import type { Item } from './items';
import type { Finding, JobReport, MechBlock } from './status';
import { markers, scan, type Diagnostic } from './build';

export interface DeriveInput {
  items: Item[];
  /** A statement's id to the ids of the statements its proof cites. */
  cites: Map<Id, Id[]>;
  report: JobReport | null;
  diagnostics: Diagnostic[];
  /** The Lean files after the build, paths relative to the Lean folder. */
  files: { path: string; text: string }[];
  previous: Record<Id, MechBlock>;
  /** The statement a prove job was for; absent for a sync. */
  target?: Id;
}

interface Place { file: string; regions: [number, number][]; firstMarker: number }

/** Where each block's declarations are: the file, and the line ranges from each of its markers to the next block's. */
function places(files: DeriveInput['files']): Map<Id, Place> {
  const out = new Map<Id, Place>();
  for (const f of files) {
    const ms = markers(f.text);
    ms.forEach((m, i) => {
      const next = ms.slice(i + 1).find((x) => x.block !== m.block);
      const region: [number, number] = [m.line, next ? next.line - 1 : Infinity];
      const p = out.get(m.block);
      if (!p) out.set(m.block, { file: f.path, regions: [region], firstMarker: ms[0].line });
      else if (p.file === f.path) p.regions.push(region);
    });
  }
  return out;
}

const within = (p: Place, line: number) => p.regions.some(([a, b]) => line >= a && line <= b);
const sameFinding = (a: Finding, b: Finding) => a.kind === b.kind && a.block === b.block && a.message === b.message
  && a.lean?.file === b.lean?.file && a.lean?.line === b.lean?.line;
const push = (list: Finding[], f: Finding) => { if (!list.some((x) => sameFinding(x, f))) list.push(f); };
const warnsSorry = (d: Diagnostic) => d.severity === 'warning' && /declaration uses 'sorry'/.test(d.message);

export function derive(input: DeriveInput): Record<Id, MechBlock> {
  const { items, report, diagnostics, files, previous, target } = input;
  const where = places(files);
  const scans = new Map(files.map((f) => [f.path, scan(f.text)]));
  const axiomIn = (file: string) => scans.get(file)?.axioms[0]?.name;
  const out: Record<Id, MechBlock> = {};

  for (const item of items) {
    const p = where.get(item.id);
    const reported = report?.blocks.find((b) => b.block === item.id);
    const findings: Finding[] = [];
    // after a prove job the report is about one statement; what was learnt about the others still holds
    if (target && item.id !== target) for (const f of previous[item.id]?.findings ?? []) if (f.kind !== 'stuck') push(findings, f);
    for (const f of report?.findings ?? []) if (f.block === item.id || f.related?.includes(item.id)) push(findings, f);

    let failed = false;
    if (!p) {
      failed = true;
      push(findings, { kind: 'stuck', block: item.id, message: 'No Lean declaration was written for this block.' });
    } else {
      for (const d of diagnostics) {
        if (d.severity !== 'error' || d.file !== p.file) continue;
        if (!within(p, d.line) && d.line >= p.firstMarker) continue;
        failed = true;
        push(findings, { kind: 'stuck', block: item.id, message: d.message, lean: { file: d.file, line: d.line } });
      }
      for (const a of scans.get(p.file)?.axioms ?? []) {
        failed = true;
        push(findings, { kind: 'stuck', block: item.id, message: `${p.file} declares an axiom (${a.name}); nothing may be assumed without proof.`, lean: { file: p.file, line: a.line } });
      }
      // A definition must be complete. A `sorry` above the first marker of its file belongs to every definition there.
      if (item.kind !== 'statement') {
        const sorries = [
          ...(scans.get(p.file)?.sorries ?? []),
          ...diagnostics.filter((d) => d.file === p.file && warnsSorry(d)).map((d) => d.line),
        ];
        for (const line of sorries) {
          if (!within(p, line) && line >= p.firstMarker) continue;
          failed = true;
          push(findings, { kind: 'stuck', block: item.id, message: 'This definition contains `sorry`; definitions must be complete.', lean: { file: p.file, line } });
        }
      }
    }

    let status: MechBlock['status'] = failed ? 'failed' : 'translated';
    if (!failed && item.kind === 'statement' && p) {
      // A statement is only stated or proved by what its file holds: a helper lemma's `sorry` counts too.
      const hasSorry = (scans.get(p.file)?.sorries.length ?? 0) > 0 || diagnostics.some((d) => d.file === p.file && warnsSorry(d));
      status = hasSorry ? 'stated' : 'proved';
    }
    out[item.id] = { kind: item.kind, hash: item.hash, file: reported?.file ?? p?.file ?? '', names: reported?.names ?? [], status, findings };
  }

  const statements = items.filter((i) => i.kind === 'statement');
  // Lake builds nothing that imports a file that failed, so a statement's own
  // file being clean says nothing once something it rests on is broken.
  if (items.some((i) => i.kind !== 'statement' && out[i.id].status === 'failed')) {
    const defFiles = [...new Set(items.filter((i) => i.kind !== 'statement').flatMap((i) => { const f = where.get(i.id)?.file; return f ? [f] : []; }))];
    const defAxiom = defFiles.map(axiomIn).find((n): n is string => n !== undefined);
    const why = defAxiom !== undefined ? `the definitions declare an axiom (${defAxiom}).` : 'the definitions do not compile.';
    for (const s of statements) {
      if (out[s.id].status === 'failed') continue;
      out[s.id].status = 'failed';
      push(out[s.id].findings, { kind: 'stuck', block: s.id, message: `Not checked: ${why}` });
    }
  }

  const title = new Map(items.map((i) => [i.id, i.title || i.label || i.id]));
  const ownFailure = new Set(statements.filter((s) => out[s.id].status === 'failed').map((s) => s.id));
  /** Everything a statement cites, directly or through others. */
  const reach = (id: Id, seen = new Set<Id>()): Set<Id> => {
    for (const c of input.cites.get(id) ?? []) {
      if (seen.has(c) || c === id || !out[c]) continue;
      seen.add(c);
      reach(c, seen);
    }
    return seen;
  };
  for (const s of statements) {
    const b = out[s.id];
    if (b.status === 'failed') continue;
    const cited = [...reach(s.id)].filter((c) => c !== s.id);
    const broken = cited.find((c) => ownFailure.has(c));
    if (broken) {
      const brokenFile = where.get(broken)?.file;
      const ax = brokenFile !== undefined ? axiomIn(brokenFile) : undefined;
      b.status = 'failed';
      push(b.findings, { kind: 'stuck', block: s.id, message: ax !== undefined ? `Not checked: ${title.get(broken)} declares an axiom (${ax}).` : `Not checked: ${title.get(broken)} does not compile.` });
      continue;
    }
    if (b.status !== 'proved') continue;
    const assumes = cited.filter((c) => out[c].status === 'stated');
    if (assumes.length) b.assumes = assumes;
    const earlier = previous[s.id]?.proofHash;
    b.proofHash = s.id === target || earlier === undefined ? s.proofHash : earlier;
  }
  return out;
}
