// The two records of a mechanization: what a job reports when it ends, and
// what the app keeps in mechanization.json. Both are read defensively: the
// report is written by a model and the file can be edited by hand, so
// anything malformed is dropped rather than trusted.

import type { Id } from '../model/types';
import type { ItemKind } from './items';

export const FINDING_KINDS = ['deviation', 'inconsistency', 'stuck'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface Finding {
  kind: FindingKind;
  block: Id;
  /** A case of a case analysis, when the finding is about one. */
  at?: Id;
  /** Other blocks an inconsistency involves. */
  related?: Id[];
  message: string;
  lean?: { file: string; line: number };
}

export const PROPOSAL_FIELDS = ['statement', 'text', 'premise', 'conclusion', 'side', 'alternative'] as const;
export type ProposalField = (typeof PROPOSAL_FIELDS)[number];

export interface ProposalTarget {
  field: ProposalField;
  /** For premise, conclusion and side: the rule. */
  rule?: Id;
  /** For alternative: the grammar production. */
  row?: Id;
  /** For premise and alternative: which one. A premise index one past the end adds a premise. */
  index?: number;
}

export interface Proposal { block: Id; target: ProposalTarget; before: string; after: string; why: string }
export interface StoredProposal extends Proposal { id: string; state: 'open' | 'dismissed' | 'accepted' }

export const OUTCOMES = ['done', 'partial', 'failed'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface Change { file: string; name: string; change: 'added' | 'changed' | 'removed' }

export interface JobReport {
  outcome: Outcome;
  summary: string;
  /** Lean declarations that came from each block. */
  blocks: { block: Id; file: string; names: string[] }[];
  findings: Finding[];
  proposals: Proposal[];
  changes: Change[];
}

export type BlockStatus = 'translated' | 'stated' | 'proved' | 'failed';

export interface MechBlock {
  kind: ItemKind;
  hash: string;
  proofHash?: string;
  file: string;
  names: string[];
  status: BlockStatus;
  /** Cited statements still unproved. */
  assumes?: Id[];
  findings: Finding[];
}

export interface LastJob {
  kind: 'sync' | 'prove';
  target?: Id;
  endedAt: string;
  model?: string;
  effort?: string;
  outcome: Outcome | 'cancelled';
  summary: string;
  changes: Change[];
}

export interface Mechanization {
  version: 1;
  blocks: Record<Id, MechBlock>;
  proposals: StoredProposal[];
  lastJob?: LastJob;
}

export const emptyMechanization = (): Mechanization => ({ version: 1, blocks: {}, proposals: [] });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const oneOf = <T extends string>(v: unknown, all: readonly T[]): v is T => isStr(v) && (all as readonly string[]).includes(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);
const list = <T>(v: unknown, read: (x: unknown) => T | null): T[] => (Array.isArray(v) ? v.map(read).filter((x): x is T => x !== null) : []);

function readFinding(v: unknown, known: ReadonlySet<Id> | null): Finding | null {
  if (!isObj(v) || !oneOf(v.kind, FINDING_KINDS) || !isStr(v.block) || !isStr(v.message)) return null;
  if (known && !known.has(v.block)) return null;
  const f: Finding = { kind: v.kind, block: v.block, message: v.message };
  if (isStr(v.at)) f.at = v.at;
  const related = strings(v.related).filter((id) => !known || known.has(id));
  if (related.length) f.related = related;
  if (isObj(v.lean) && isStr(v.lean.file) && typeof v.lean.line === 'number') f.lean = { file: v.lean.file, line: v.lean.line };
  return f;
}

function readTarget(v: unknown): ProposalTarget | null {
  if (!isObj(v) || !oneOf(v.field, PROPOSAL_FIELDS)) return null;
  const index = typeof v.index === 'number' && Number.isInteger(v.index) && v.index >= 0 ? v.index : undefined;
  switch (v.field) {
    case 'statement': case 'text': return { field: v.field };
    case 'conclusion': case 'side': return isStr(v.rule) ? { field: v.field, rule: v.rule } : null;
    case 'premise': return isStr(v.rule) && index !== undefined ? { field: 'premise', rule: v.rule, index } : null;
    case 'alternative': return isStr(v.row) && index !== undefined ? { field: 'alternative', row: v.row, index } : null;
  }
}

function readProposal(v: unknown, known: ReadonlySet<Id> | null): Proposal | null {
  if (!isObj(v) || !isStr(v.block) || !isStr(v.before) || !isStr(v.after)) return null;
  if (known && !known.has(v.block)) return null;
  const target = readTarget(v.target);
  return target ? { block: v.block, target, before: v.before, after: v.after, why: isStr(v.why) ? v.why : '' } : null;
}

function readChange(v: unknown): Change | null {
  if (!isObj(v) || !isStr(v.file) || !isStr(v.name) || !oneOf(v.change, ['added', 'changed', 'removed'] as const)) return null;
  return { file: v.file, name: v.name, change: v.change };
}

/** A job's report with everything malformed, or about a block the document does not have, left out. Null if it is not a report at all. */
export function readReport(v: unknown, known: ReadonlySet<Id>): JobReport | null {
  if (!isObj(v) || !oneOf(v.outcome, OUTCOMES)) return null;
  return {
    outcome: v.outcome,
    summary: isStr(v.summary) ? v.summary : '',
    blocks: list(v.blocks, (b) => (isObj(b) && isStr(b.block) && known.has(b.block) && isStr(b.file) ? { block: b.block, file: b.file, names: strings(b.names) } : null)),
    findings: list(v.findings, (f) => readFinding(f, known)),
    proposals: list(v.proposals, (p) => readProposal(p, known)),
    changes: list(v.changes, readChange),
  };
}

function readBlock(v: unknown): MechBlock | null {
  if (!isObj(v) || !isStr(v.hash) || !isStr(v.file)) return null;
  if (!oneOf(v.kind, ['grammar', 'rules', 'definition', 'statement'] as const)) return null;
  if (!oneOf(v.status, ['translated', 'stated', 'proved', 'failed'] as const)) return null;
  const b: MechBlock = { kind: v.kind, hash: v.hash, file: v.file, names: strings(v.names), status: v.status, findings: list(v.findings, (f) => readFinding(f, null)) };
  if (isStr(v.proofHash)) b.proofHash = v.proofHash;
  const assumes = strings(v.assumes);
  if (assumes.length) b.assumes = assumes;
  return b;
}

function readLastJob(v: unknown): LastJob | undefined {
  if (!isObj(v) || !oneOf(v.kind, ['sync', 'prove'] as const) || !isStr(v.endedAt)) return undefined;
  if (!oneOf(v.outcome, [...OUTCOMES, 'cancelled'] as const)) return undefined;
  const j: LastJob = { kind: v.kind, endedAt: v.endedAt, outcome: v.outcome, summary: isStr(v.summary) ? v.summary : '', changes: list(v.changes, readChange) };
  if (isStr(v.target)) j.target = v.target;
  if (isStr(v.model)) j.model = v.model;
  if (isStr(v.effort)) j.effort = v.effort;
  return j;
}

/** What mechanization.json holds. A missing, unreadable or foreign file reads as an empty one. */
export function readMechanization(v: unknown): Mechanization {
  if (!isObj(v) || v.version !== 1 || !isObj(v.blocks)) return emptyMechanization();
  const blocks: Record<Id, MechBlock> = {};
  for (const [id, raw] of Object.entries(v.blocks)) {
    const b = readBlock(raw);
    if (b) blocks[id] = b;
  }
  const proposals = list(v.proposals, (p): StoredProposal | null => {
    const read = readProposal(p, null);
    if (!read || !isObj(p) || !isStr(p.id) || !oneOf(p.state, ['open', 'dismissed', 'accepted'] as const)) return null;
    return { ...read, id: p.id, state: p.state };
  });
  const out: Mechanization = { version: 1, blocks, proposals };
  const lastJob = readLastJob(v.lastJob);
  if (lastJob) out.lastJob = lastJob;
  return out;
}
