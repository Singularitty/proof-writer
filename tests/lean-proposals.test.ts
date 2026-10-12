import { describe, it, expect } from 'vitest';
import { applies, applyProposal, currentText, mergeProposals } from '../src/lean/proposals';
import type { Proposal, StoredProposal } from '../src/lean/status';
import type { Doc } from '../src/model/types';

function doc(): Doc {
  return {
    version: 1, title: 't', author: '', snippets: [], settings: { paper: 'a4', fontSize: 11, numberTheorems: 'shared' },
    blocks: [
      { id: 'g', type: 'grammar', title: 'Syntax', rows: [{ id: 'row', category: 'Types', metavar: '\\tau', alternatives: ['Bool', 'Nat'] }] },
      { id: 'r', type: 'rules', title: 'Typing', rules: [{ id: 'r1', name: 'T-App', premises: ['p0', 'p1'], conclusion: 'c' }] },
      { id: 'thm', type: 'theorem', kind: 'lemma', title: '', label: 'lem:a', statement: 'Old statement.', proof: [{ id: 'txt', type: 'text', text: 'By induction.' }] },
    ],
  };
}
const p = (block: string, target: Proposal['target'], before: string, after: string): Proposal => ({ block, target, before, after, why: 'w' });

describe('what a proposal targets', () => {
  it('reads each kind of field, including one nested in a proof', () => {
    expect(currentText(doc(), p('thm', { field: 'statement' }, '', ''))).toBe('Old statement.');
    expect(currentText(doc(), p('txt', { field: 'text' }, '', ''))).toBe('By induction.');
    expect(currentText(doc(), p('r', { field: 'premise', rule: 'r1', index: 1 }, '', ''))).toBe('p1');
    expect(currentText(doc(), p('r', { field: 'conclusion', rule: 'r1' }, '', ''))).toBe('c');
    expect(currentText(doc(), p('r', { field: 'side', rule: 'r1' }, '', ''))).toBe('');
    expect(currentText(doc(), p('g', { field: 'alternative', row: 'row', index: 0 }, '', ''))).toBe('Bool');
  });
  it('treats a premise one past the end as empty, and anything further as gone', () => {
    expect(currentText(doc(), p('r', { field: 'premise', rule: 'r1', index: 2 }, '', ''))).toBe('');
    expect(currentText(doc(), p('r', { field: 'premise', rule: 'r1', index: 3 }, '', ''))).toBe(null);
  });
  it('is null when the block, rule or row is gone or of the wrong type', () => {
    expect(currentText(doc(), p('nope', { field: 'statement' }, '', ''))).toBe(null);
    expect(currentText(doc(), p('r', { field: 'statement' }, '', ''))).toBe(null);
    expect(currentText(doc(), p('r', { field: 'conclusion', rule: 'deleted' }, '', ''))).toBe(null);
    expect(currentText(doc(), p('g', { field: 'alternative', row: 'row', index: 9 }, '', ''))).toBe(null);
    expect(currentText(doc(), p('g', { field: 'alternative', row: 'deleted', index: 0 }, '', ''))).toBe(null);
  });
});

describe('applying a proposal', () => {
  it('replaces the field when it still holds the before text', () => {
    const d = doc();
    expect(applyProposal(d, p('thm', { field: 'statement' }, 'Old statement.', 'New statement.'))).toBe(true);
    expect(currentText(d, p('thm', { field: 'statement' }, '', ''))).toBe('New statement.');
  });
  it('adds, changes and removes premises, and sets a side condition', () => {
    const d = doc();
    applyProposal(d, p('r', { field: 'premise', rule: 'r1', index: 2 }, '', 'p2'));
    applyProposal(d, p('r', { field: 'premise', rule: 'r1', index: 0 }, 'p0', 'q0'));
    applyProposal(d, p('r', { field: 'premise', rule: 'r1', index: 1 }, 'p1', ''));
    applyProposal(d, p('r', { field: 'side', rule: 'r1' }, '', 'x \\notin \\Gamma'));
    const rule = (d.blocks[1] as Extract<Doc['blocks'][number], { type: 'rules' }>).rules[0];
    expect(rule.premises).toEqual(['q0', 'p2']);
    expect(rule.side).toBe('x \\notin \\Gamma');
  });
  it('does nothing when the field has moved on', () => {
    const d = doc();
    const before = JSON.stringify(d);
    const stale = p('thm', { field: 'statement' }, 'Something else.', 'New.');
    expect(applies(d, stale)).toBe(false);
    expect(applyProposal(d, stale)).toBe(false);
    expect(applyProposal(d, p('r', { field: 'conclusion', rule: 'deleted' }, 'c', 'd'))).toBe(false);
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe('merging proposals after a job', () => {
  const stored = (id: string, block: string, after: string, state: StoredProposal['state']): StoredProposal => ({ ...p(block, { field: 'statement' }, 'a', after), id, state });
  let n = 0;
  const newId = () => `n${++n}`;
  it('after a sync, replaces open proposals and remembers dismissed ones', () => {
    const old = [stored('o1', 'thm', 'x', 'open'), stored('o2', 'thm', 'y', 'dismissed')];
    const out = mergeProposals(old, [p('thm', { field: 'statement' }, 'a', 'y'), p('thm', { field: 'statement' }, 'a', 'z')], null, newId);
    expect(out.map((q) => [q.after, q.state])).toEqual([['y', 'dismissed'], ['z', 'open']]);
  });
  it('after a prove job, keeps open proposals for other blocks', () => {
    const old = [stored('o1', 'other', 'x', 'open'), stored('o2', 'thm', 'y', 'open')];
    const out = mergeProposals(old, [p('thm', { field: 'statement' }, 'a', 'z')], 'thm', newId);
    expect(out.map((q) => [q.block, q.after])).toEqual([['other', 'x'], ['thm', 'z']]);
  });
  it('does not add the same proposal twice', () => {
    const fresh = p('thm', { field: 'statement' }, 'a', 'z');
    expect(mergeProposals([], [fresh, fresh], null, newId)).toHaveLength(1);
  });
});
