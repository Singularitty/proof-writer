import { describe, it, expect } from 'vitest';
import { docItems, staleness } from '../src/lean/items';
import type { Block, Doc, Rule } from '../src/model/types';

let n = 0;
const id = () => `t${++n}`;
function doc(blocks: Block[], snippets: Doc['snippets'] = []): Doc {
  return { version: 1, title: 't', author: '', snippets, blocks, settings: { paper: 'a4', fontSize: 11, numberTheorems: 'shared' } };
}
const rule = (name: string, conclusion: string, premises: string[] = []): Rule => ({ id: id(), name, premises, conclusion });
const rules = (rs: Rule[], title = 'Typing'): Block & { type: 'rules' } => ({ id: id(), type: 'rules', title, judgment: '\\ty{\\Gamma}{e}{\\tau}', rules: rs });
const grammar = (): Block & { type: 'grammar' } => ({ id: id(), type: 'grammar', title: 'Syntax', rows: [{ id: id(), category: 'Types', metavar: '\\tau', alternatives: ['\\mathsf{Bool}'] }] });
const stmt = (label: string, kind: 'lemma' | 'theorem' | 'definition' | 'conjecture' = 'lemma', proof?: Block[]): Block & { type: 'theorem' } =>
  ({ id: id(), type: 'theorem', kind, title: '', label, statement: 'If $\\ty{\\Gamma}{e}{\\tau}$ then fine.', proof });
const text = (t: string): Block => ({ id: id(), type: 'text', text: t });
const ty = { id: 's1', kind: 'math' as const, name: 'ty', arity: 3, body: '#1 \\vdash #2 : #3' };

const record = (d: Doc) => Object.fromEntries(docItems(d).map((i) => [i.id, { hash: i.hash, proofHash: i.proofHash, kind: i.kind }]));

describe('the items of a document', () => {
  it('lists grammars, rules, definitions and statements in order', () => {
    const d = doc([grammar(), rules([rule('T-True', 'x')]), stmt('def:val', 'definition'), stmt('lem:a', 'lemma', [text('By induction.')]), stmt('conj:b', 'conjecture')]);
    expect(docItems(d).map((i) => i.kind)).toEqual(['grammar', 'rules', 'definition', 'statement', 'statement']);
    expect(docItems(d).map((i) => i.hasProof)).toEqual([false, false, false, true, false]);
  });
  it('finds rules inside a definition', () => {
    const inner = rules([rule('V-True', 'v')]);
    const d = doc([{ ...stmt('def:val', 'definition'), proof: [inner] }]);
    expect(docItems(d).map((i) => i.id)).toContain(inner.id);
  });
});

describe('hashes', () => {
  it('change with the content that carries meaning and not with titles', () => {
    const r = rules([rule('T-True', 'x')]);
    const before = docItems(doc([r]))[0].hash;
    expect(docItems(doc([{ ...r, title: 'Other title' }]))[0].hash).toBe(before);
    expect(docItems(doc([{ ...r, rules: [{ ...r.rules[0], premises: ['p'] }] }]))[0].hash).not.toBe(before);
    expect(docItems(doc([{ ...r, rules: [{ ...r.rules[0], side: 'x \\notin \\Gamma' }] }]))[0].hash).not.toBe(before);
  });
  it('change when a snippet the block uses changes, directly or through another snippet', () => {
    const r = rules([rule('T-True', '\\ty{\\Gamma}{e}{\\tau}')]);
    const before = docItems(doc([r], [ty]))[0].hash;
    expect(docItems(doc([r], [{ ...ty, body: '#1 \\Vdash #2 : #3' }]))[0].hash).not.toBe(before);
    const unused = { id: 's2', kind: 'math' as const, name: 'step', arity: 2, body: '#1 \\to #2' };
    expect(docItems(doc([r], [ty, unused]))[0].hash).toBe(before);
    const outer = { id: 's3', kind: 'math' as const, name: 'ty', arity: 3, body: '\\turn{#1} #2 : #3' };
    const turn = { id: 's4', kind: 'math' as const, name: 'turn', arity: 1, body: '#1 \\vdash' };
    const viaBefore = docItems(doc([r], [outer, turn]))[0].hash;
    expect(docItems(doc([r], [outer, { ...turn, body: '#1 \\Vdash' }]))[0].hash).not.toBe(viaBefore);
  });
  it('keep a statement and its proof apart', () => {
    const s = stmt('lem:a', 'lemma', [text('By induction.')]);
    const a = docItems(doc([s]))[0];
    const b = docItems(doc([{ ...s, proof: [{ ...s.proof![0], text: 'By cases.' } as Block] }]))[0];
    expect(b.hash).toBe(a.hash);
    expect(b.proofHash).not.toBe(a.proofHash);
  });
});

describe('module names', () => {
  const names = (labels: string[]) => docItems(doc(labels.map((l) => stmt(l)))).map((i) => i.module!);
  it('are made from labels', () => {
    expect(names(['lem:canonical', 'thm:type-soundness'])).toEqual(['LemCanonical', 'ThmTypeSoundness']);
  });
  it('are valid and distinct whatever the labels', () => {
    const ms = names(['2nd', 'lem:a-b', 'lem:a_b', '', '', 'defs', 'λ→']);
    for (const m of ms) expect(m).toMatch(/^[A-Z][A-Za-z0-9_]*$/);
    expect(new Set(ms).size).toBe(ms.length);
    expect(ms).not.toContain('Defs');
  });
});

describe('staleness', () => {
  it('is empty right after recording', () => {
    const d = doc([rules([rule('T-True', 'x')]), stmt('lem:a')]);
    const s = staleness(docItems(d), record(d));
    expect([...s.stale]).toEqual([]);
    expect(s.defsStale).toBe(false);
  });
  it('marks a changed statement alone', () => {
    const r = rules([rule('T-True', 'x')]);
    const a = stmt('lem:a');
    const rec = record(doc([r, a]));
    const s = staleness(docItems(doc([r, { ...a, statement: 'Changed.' }])), rec);
    expect([...s.stale]).toEqual([a.id]);
    expect(s.defsStale).toBe(false);
  });
  it('reports a changed, new or deleted definition as stale definitions', () => {
    const r = rules([rule('T-True', 'x')]);
    const g = grammar();
    const a = stmt('lem:a');
    const rec = record(doc([r, a]));
    expect(staleness(docItems(doc([{ ...r, judgment: 'other' }, a])), rec).defsStale).toBe(true);
    const added = staleness(docItems(doc([r, g, a])), rec);
    expect(added.defsStale).toBe(true);
    expect([...added.fresh]).toEqual([g.id]);
    const gone = staleness(docItems(doc([a])), rec);
    expect(gone.defsStale).toBe(true);
    expect(gone.deleted).toEqual([r.id]);
  });
  it('does not call a deleted statement a stale definition', () => {
    const a = stmt('lem:a');
    const b = stmt('lem:b');
    const s = staleness(docItems(doc([a])), record(doc([a, b])));
    expect(s.deleted).toEqual([b.id]);
    expect(s.defsStale).toBe(false);
  });
  it('notes a proof edited since it was proved', () => {
    const a = stmt('lem:a', 'lemma', [text('By induction.')]);
    const rec = record(doc([a]));
    const s = staleness(docItems(doc([{ ...a, proof: [text('By cases.')] }])), rec);
    expect([...s.proofChanged]).toEqual([a.id]);
    expect([...s.stale]).toEqual([]);
  });
});
