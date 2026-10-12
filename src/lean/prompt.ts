// What a job is told and what it must answer with. The standing rules are in
// electron/lean-instructions.md (CLAUDE.md in the Lean folder); a prompt only
// names the job. Along with that file and electron/lean.cjs, this is all the
// code that knows the prover is Lean.

import type { Id } from '../model/types';
import type { Item, Staleness } from './items';
import { FINDING_KINDS, OUTCOMES, PROPOSAL_FIELDS } from './status';

/** The CLI's model aliases; each follows the latest model of that name. */
export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Model = (typeof MODELS)[number];
export type Effort = (typeof EFFORTS)[number];

const text = { type: 'string' } as const;

/** JSON Schema of a job's final answer (JobReport in status.ts). */
export const REPORT_SCHEMA = {
  type: 'object',
  required: ['outcome', 'summary', 'blocks', 'findings', 'proposals', 'changes'],
  properties: {
    outcome: { type: 'string', enum: [...OUTCOMES] },
    summary: text,
    blocks: {
      type: 'array',
      items: { type: 'object', required: ['block', 'file', 'names'], properties: { block: text, file: text, names: { type: 'array', items: text } } },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'block', 'message'],
        properties: {
          kind: { type: 'string', enum: [...FINDING_KINDS] },
          block: text,
          at: text,
          related: { type: 'array', items: text },
          message: text,
          lean: { type: 'object', required: ['file', 'line'], properties: { file: text, line: { type: 'integer' } } },
        },
      },
    },
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        required: ['block', 'target', 'before', 'after', 'why'],
        properties: {
          block: text,
          target: {
            type: 'object',
            required: ['field'],
            properties: { field: { type: 'string', enum: [...PROPOSAL_FIELDS] }, rule: text, row: text, index: { type: 'integer' } },
          },
          before: text,
          after: text,
          why: text,
        },
      },
    },
    changes: {
      type: 'array',
      items: { type: 'object', required: ['file', 'name', 'change'], properties: { file: text, name: text, change: { type: 'string', enum: ['added', 'changed', 'removed'] } } },
    },
  },
};

const ids = (xs: Iterable<Id>) => [...xs].map((x) => '`' + x + '`').join(', ');
const named = (i: Item) => `\`${i.id}\`${i.label ? ` (${i.label})` : i.title ? ` (${i.title})` : ''}`;

/** `files` says where each block's Lean text was last found, so a statement whose module name has changed can be moved. */
export function syncPrompt(a: { items: Item[]; stale: Staleness; cites: Map<Id, Id[]>; first: boolean; files?: Record<Id, string> }): string {
  const byId = new Map(a.items.map((i) => [i.id, i]));
  const defs = a.items.filter((i) => i.kind !== 'statement');
  const statements = a.items.filter((i) => i.kind === 'statement');
  const lines = ['Job: sync. Bring the Lean definitions and the Lean statements up to date with document.json, as your instructions for this folder describe.', ''];
  if (a.first) lines.push('Nothing has been translated yet: this is the first sync.');
  else {
    lines.push('Since the last sync:');
    if (a.stale.stale.size) lines.push(`- Changed blocks: ${ids(a.stale.stale)}`);
    if (a.stale.fresh.size) lines.push(`- New blocks: ${ids(a.stale.fresh)}`);
    if (a.stale.deleted.length) lines.push(`- Deleted blocks: ${ids(a.stale.deleted)} (remove their declarations from PW/Defs.lean; the app removes a deleted statement's file)`);
    if (!a.stale.stale.size && !a.stale.fresh.size && !a.stale.deleted.length) lines.push('- Nothing is recorded as changed; check that every block below has its declaration and that the project builds.');
  }
  lines.push('', 'Definitions, all in PW/Defs.lean, in this order:');
  for (const d of defs) lines.push(`- ${named(d)}: ${d.kind}`);
  if (!defs.length) lines.push('- (none)');
  lines.push('', 'Statements, one file each, in this order:');
  for (const s of statements) {
    const imports = (a.cites.get(s.id) ?? []).map((c) => byId.get(c)?.module).filter(Boolean).map((m) => `PW.${m}`);
    const file = `PW/${s.module}.lean`;
    const was = a.files?.[s.id];
    const moved = was && was !== file ? ` (its Lean text is currently in ${was}; move it to the file named here)` : '';
    lines.push(`- ${named(s)}: ${file}${moved}${imports.length ? `, also imports ${imports.join(', ')}` : ''}`);
  }
  if (!statements.length) lines.push('- (none)');
  lines.push('', 'State every statement and leave `sorry` as the proof of any that has no proof yet. Keep an existing proof where it still compiles. Do not attempt new proofs in this job.');
  return lines.join('\n');
}

export function provePrompt(a: { item: Item; cited: Item[] }): string {
  const lines = [
    `Job: prove. Replace the \`sorry\` in PW/${a.item.module}.lean with a proof of the statement from block ${named(a.item)}, following the written proof in document.json as your instructions for this folder describe.`,
    '',
    'Edit that file only.',
  ];
  if (a.cited.length) lines.push('', 'The written proof cites these statements, which the file may import and use whether or not they are proved yet:', ...a.cited.map((c) => `- ${named(c)}: PW.${c.module}`));
  return lines.join('\n');
}
