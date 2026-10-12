import { describe, it, expect } from 'vitest';
import { docItems } from '../src/lean/items';
import { leanView, owners } from '../src/lean/view';
import type { MechBlock, Mechanization } from '../src/lean/status';
import type { Doc } from '../src/model/types';

function doc(statementA = 'S'): Doc {
  return {
    version: 1, title: 't', author: '', snippets: [], settings: { paper: 'a4', fontSize: 11, numberTheorems: 'shared' },
    blocks: [
      { id: 'r', type: 'rules', title: 'Typing', rules: [{ id: 'r1', name: 'T-True', premises: [], conclusion: 'c' }] },
      { id: 'a', type: 'theorem', kind: 'lemma', title: 'A', label: 'lem:a', statement: statementA, proof: [{ id: 'ta', type: 'text', text: 'Easy.' }] },
      { id: 'b', type: 'theorem', kind: 'theorem', title: 'B', label: 'thm:b', statement: 'S', proof: [] },
      { id: 'c', type: 'theorem', kind: 'conjecture', title: 'C', label: 'conj:c', statement: 'S', proof: [{ id: 'tc', type: 'text', text: 'Maybe.' }] },
      { id: 'loose', type: 'text', text: 'Remark.' },
    ],
  };
}
function mech(d: Doc, over: Record<string, Partial<MechBlock>> = {}, proposals: Mechanization['proposals'] = []): Mechanization {
  const blocks: Mechanization['blocks'] = {};
  for (const i of docItems(d)) {
    blocks[i.id] = { kind: i.kind, hash: i.hash, proofHash: i.proofHash, file: 'PW/x.lean', names: [], status: i.kind === 'statement' ? 'proved' : 'translated', findings: [], ...over[i.id] };
  }
  return { version: 1, blocks, proposals };
}
const status = (d: Doc, m: Mechanization) => Object.fromEntries([...leanView(d, m).byId].map(([id, r]) => [id, r.status]));

describe('the rows of the Lean tab', () => {
  it('are all untranslated before the first sync', () => {
    const v = leanView(doc(), { version: 1, blocks: {}, proposals: [] });
    expect(v.definitions.map((r) => r.id)).toEqual(['r']);
    expect(v.statements.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(v.statements.every((r) => r.status === 'none')).toBe(true);
    expect(v.outOfDate).toBe(4);
    expect(v.needsSync).toBe(true);
  });
  it('show what the status file records when nothing changed', () => {
    const d = doc();
    const v = leanView(d, mech(d, { b: { status: 'stated' }, c: { status: 'failed' } }));
    expect(status(d, mech(d, { b: { status: 'stated' }, c: { status: 'failed' } }))).toEqual({ r: 'translated', a: 'proved', b: 'stated', c: 'failed' });
    expect(v.needsSync).toBe(false);
  });
  it('need a sync when a definition failed, so a failed translation is tried again', () => {
    const d = doc();
    const v = leanView(d, mech(d, { r: { status: 'failed' } }));
    expect(v.outOfDate).toBe(0);
    expect(v.needsSync).toBe(true);
    expect(leanView(d, mech(d, { a: { status: 'failed' } })).needsSync).toBe(false);
  });
  it('offer Prove for a statement with a written proof that is not a conjecture', () => {
    const d = doc();
    expect(leanView(d, mech(d)).statements.map((r) => r.canProve)).toEqual([true, false, false]);
  });
  it('mark an edited statement out of date, alone', () => {
    const d = doc();
    const m = mech(d);
    expect(status(doc('Changed.'), m)).toMatchObject({ r: 'translated', a: 'stale', b: 'proved' });
  });
  it('mark every statement out of date when a definition changed', () => {
    const d = doc();
    const m = mech(d);
    const edited = doc();
    (edited.blocks[0] as Extract<Doc['blocks'][number], { type: 'rules' }>).rules[0].conclusion = 'other';
    expect(status(edited, m)).toEqual({ r: 'stale', a: 'stale', b: 'stale', c: 'stale' });
  });
  it('need a sync when a translated block was deleted', () => {
    const d = doc();
    const m = mech(d);
    const fewer = { ...d, blocks: d.blocks.filter((b) => b.id !== 'c') };
    expect(leanView(fewer, m).needsSync).toBe(true);
  });
  it('need a sync, and mark every statement out of date, when a definition was deleted', () => {
    const d = doc();
    const m = mech(d);
    const fewer = { ...d, blocks: d.blocks.filter((b) => b.id !== 'r') };
    const v = leanView(fewer, m);
    expect(v.needsSync).toBe(true);
    expect(v.statements.map((r) => r.status)).toEqual(['stale', 'stale', 'stale']);
  });
  it('call a proof with a recorded deviation proved with deviations, and pass on what it assumes', () => {
    const d = doc();
    const m = mech(d, { a: { assumes: ['b'], findings: [{ kind: 'deviation', block: 'a', message: 'extra hypothesis' }] } });
    const row = leanView(d, m).byId.get('a')!;
    expect(row.status).toBe('deviations');
    expect(row.assumes).toEqual(['b']);
  });
  it('note a written proof edited since it was proved', () => {
    const d = doc();
    const m = mech(d);
    const edited = doc();
    (edited.blocks[1] as Extract<Doc['blocks'][number], { type: 'theorem' }>).proof = [{ id: 'ta', type: 'text', text: 'Harder than it looked.' }];
    const row = leanView(edited, m).byId.get('a')!;
    expect(row.status).toBe('proved');
    expect(row.proofChanged).toBe(true);
  });
  it('put open proposals under the item that owns their block, and say which still apply', () => {
    const d = doc();
    const proposals: Mechanization['proposals'] = [
      { id: 'p1', state: 'open', block: 'ta', target: { field: 'text' }, before: 'Easy.', after: 'By induction.', why: 'w' },
      { id: 'p2', state: 'open', block: 'a', target: { field: 'statement' }, before: 'Not the text', after: 'x', why: 'w' },
      { id: 'p3', state: 'dismissed', block: 'a', target: { field: 'statement' }, before: 'S', after: 'y', why: 'w' },
      { id: 'p4', state: 'open', block: 'loose', target: { field: 'text' }, before: 'Remark.', after: 'Note.', why: 'w' },
    ];
    const v = leanView(d, mech(d, {}, proposals));
    expect(v.byId.get('a')!.proposals.map((p) => [p.id, p.applicable])).toEqual([['p1', true], ['p2', false]]);
    expect(v.loose.map((p) => p.id)).toEqual(['p4']);
  });
  it('return the same view for the same document and status', () => {
    const d = doc();
    const m = mech(d);
    expect(leanView(d, m)).toBe(leanView(d, m));
  });
});

describe('owners', () => {
  it('map a block inside a proof to its statement, and an item to itself', () => {
    const d = doc();
    const own = owners(d, new Set(docItems(d).map((i) => i.id)));
    expect(own.get('ta')).toBe('a');
    expect(own.get('a')).toBe('a');
    expect(own.has('loose')).toBe(false);
  });
});
