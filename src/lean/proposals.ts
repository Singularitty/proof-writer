// Edits to the document that a job proposes. One proposal changes one field,
// and only while that field still reads as it did when the proposal was made:
// the user may have rewritten it since.

import type { Block, Doc, Id } from '../model/types';
import { walkBlocks } from '../export/context';
import type { Proposal, StoredProposal } from './status';

function find(doc: Doc, id: Id): Block | null {
  let found: Block | null = null;
  walkBlocks(doc.blocks, (b) => { if (b.id === id && !found) found = b; });
  return found;
}

/** A way to read and write the targeted field; null when the target is gone. */
function field(doc: Doc, p: Proposal): { get: () => string; set: (v: string) => void } | null {
  const b = find(doc, p.block);
  if (!b) return null;
  const t = p.target;
  if (t.field === 'statement') return b.type === 'theorem' ? { get: () => b.statement, set: (v) => { b.statement = v; } } : null;
  if (t.field === 'text') return b.type === 'text' ? { get: () => b.text, set: (v) => { b.text = v; } } : null;
  if (t.field === 'alternative') {
    const row = b.type === 'grammar' ? b.rows.find((r) => r.id === t.row) : undefined;
    const i = t.index ?? -1;
    if (!row || i < 0 || i >= row.alternatives.length) return null;
    return { get: () => row.alternatives[i], set: (v) => { row.alternatives[i] = v; } };
  }
  const rule = b.type === 'rules' ? b.rules.find((r) => r.id === t.rule) : undefined;
  if (!rule) return null;
  if (t.field === 'conclusion') return { get: () => rule.conclusion, set: (v) => { rule.conclusion = v; } };
  if (t.field === 'side') return { get: () => rule.side ?? '', set: (v) => { if (v) rule.side = v; else delete rule.side; } };
  const i = t.index ?? -1;
  if (i < 0 || i > rule.premises.length) return null;
  return {
    get: () => rule.premises[i] ?? '',
    // an empty premise is no premise: proposing '' removes it
    set: (v) => { if (v) rule.premises[i] = v; else rule.premises.splice(i, 1); },
  };
}

/** What the targeted field holds now; '' for a premise one past the end; null when the target is gone. */
export function currentText(doc: Doc, p: Proposal): string | null {
  return field(doc, p)?.get() ?? null;
}

export const applies = (doc: Doc, p: Proposal) => currentText(doc, p) === p.before;

/** Makes the edit in place (give it an immer draft). False, and nothing changed, when it no longer applies. */
export function applyProposal(doc: Doc, p: Proposal): boolean {
  const f = field(doc, p);
  if (!f || f.get() !== p.before) return false;
  f.set(p.after);
  return true;
}

const same = (a: Proposal, b: Proposal) => a.block === b.block && a.after === b.after && JSON.stringify(a.target) === JSON.stringify(b.target);

/**
 * The proposals to keep after a job. Ones the user settled stay, so a
 * dismissed one is not offered again. Open ones the job could have revisited
 * (all of them after a sync; the statement's own after a proof) give way to
 * what the job proposes now.
 */
export function mergeProposals(old: StoredProposal[], fresh: Proposal[], scope: Id | null, newId: () => string): StoredProposal[] {
  const out = old.filter((p) => p.state !== 'open' || (scope !== null && p.block !== scope));
  for (const p of fresh) {
    if (out.some((q) => same(q, p))) continue;
    out.push({ ...p, id: newId(), state: 'open' });
  }
  return out;
}
