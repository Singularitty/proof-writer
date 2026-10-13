import { describe, it, expect } from 'vitest';
import { collapsedAround, findInDoc, replaceAll, replaceHit } from '../src/model/search';
import { findInRuns } from '../src/preview/find';
import type { Block } from '../src/model/types';

const doc = (): Block[] => [
  { id: 'h', type: 'heading', level: 1, text: 'Typing rules' },
  { id: 't', type: 'text', text: 'A typing context $\\Gamma$ maps variables to types. Typing is decidable.' },
  { id: 'g', type: 'grammar', title: 'Syntax', rows: [{ id: 'g1', category: 'Types', metavar: '\\tau', alternatives: ['\\mathsf{Bool}', '\\tau \\to \\tau'] }] },
  { id: 'r', type: 'rules', title: 'Typing', judgment: '\\Gamma \\vdash e : \\tau', rules: [{ id: 'r1', name: 'T-Var', premises: ['x : \\tau \\in \\Gamma'], conclusion: '\\Gamma \\vdash x : \\tau', side: 'x fresh' }] },
  { id: 'd', type: 'derivation', caption: 'An example', root: { id: 'n1', judgment: '\\vdash e : \\tau', rule: 'T-App', children: [{ id: 'n2', judgment: 'leafy', children: [] }] } },
  {
    id: 'th', type: 'theorem', kind: 'lemma', title: 'Substitution', label: 'lem:subst', statement: 'If needle then done.', collapsed: true,
    proof: [
      { id: 'c', type: 'cases', intro: 'By induction.', cases: [{ id: 'c1', title: 'Case [[T-Var]]', body: [{ id: 'ct', type: 'text', text: 'the needle is here' }] }] },
    ],
  },
  { id: 'w', type: 'raw', typst: '#needle()', latex: '\\needle' },
];

describe('findInDoc', () => {
  it('finds nothing for an empty query', () => {
    expect(findInDoc(doc(), '')).toEqual([]);
  });

  it('finds every occurrence, in document order, ignoring case', () => {
    const hits = findInDoc(doc(), 'typing');
    expect(hits.map((h) => [h.block, h.start])).toEqual([['h', 0], ['t', 2], ['t', 51], ['r', 0]]);
    expect(hits[1].text.slice(hits[1].start, hits[1].end)).toBe('typing');
  });

  it('can match case', () => {
    expect(findInDoc(doc(), 'Typing', { matchCase: true }).map((h) => h.block)).toEqual(['h', 't', 'r']);
  });

  it('reads the query literally', () => {
    expect(findInDoc(doc(), '\\tau \\to').map((h) => h.block)).toEqual(['g']);
    expect(findInDoc(doc(), '.*')).toEqual([]);
  });

  it('looks in every kind of field', () => {
    const where = (q: string) => findInDoc(doc(), q).map((h) => h.block);
    expect(where('Syntax')).toEqual(['g']);
    expect(where('mathsf')).toEqual(['g']);
    expect(where('T-Var')).toEqual(['r', 'c']);
    expect(where('fresh')).toEqual(['r']);
    expect(where('T-App')).toEqual(['d']);
    expect(where('leafy')).toEqual(['d']);
    expect(where('An example')).toEqual(['d']);
    expect(where('lem:subst')).toEqual(['th']);
    expect(where('needle')).toEqual(['th', 'ct', 'w', 'w']);
    expect(where('induction')).toEqual(['c']);
  });
});

describe('replacing', () => {
  it('replaces one hit and leaves the others', () => {
    const blocks = doc();
    const hits = findInDoc(blocks, 'typing');
    expect(replaceHit(blocks, hits[2], 'Checking')).toBe(true);
    expect((blocks[1] as { text: string }).text).toBe('A typing context $\\Gamma$ maps variables to types. Checking is decidable.');
  });

  it('refuses a hit the document has moved on from', () => {
    const blocks = doc();
    const hit = findInDoc(blocks, 'decidable')[0];
    (blocks[1] as { text: string }).text = 'short';
    expect(replaceHit(blocks, hit, 'x')).toBe(false);
    expect((blocks[1] as { text: string }).text).toBe('short');
  });

  it('replaces everything, nested fields included, and counts', () => {
    const blocks = doc();
    expect(replaceAll(blocks, 'needle', '$1')).toBe(4);
    expect(findInDoc(blocks, 'needle')).toEqual([]);
    expect(findInDoc(blocks, '$1').length).toBe(4);
    expect((blocks[6] as { latex: string }).latex).toBe('\\$1');
  });
});

describe('collapsedAround', () => {
  it('names the collapsed proofs a block is inside', () => {
    expect(collapsedAround(doc(), 'ct')).toEqual(['th']);
    expect(collapsedAround(doc(), 'c')).toEqual(['th']);
    expect(collapsedAround(doc(), 'th')).toEqual([]);
    expect(collapsedAround(doc(), 't')).toEqual([]);
  });
});

describe('findInRuns', () => {
  const runs = (...texts: string[]) => texts.map((text) => ({ text, gap: false }));

  it('finds text inside one run', () => {
    expect(findInRuns(runs('Type Soundness for the '), 'sound', false)).toEqual([[{ run: 0, start: 5, end: 10 }]]);
  });

  it('finds text running over several runs', () => {
    expect(findInRuns(runs('the λ-', 'Calculus'), 'λ-calc', false)).toEqual([[{ run: 0, start: 4, end: 6 }, { run: 1, start: 0, end: 4 }]]);
  });

  it('reads math letters as plain ones', () => {
    expect(findInRuns(runs('𝖡', '𝗈', '𝗈', '𝗅', '|', '𝜏'), 'Bool', true)).toEqual([[
      { run: 0, start: 0, end: 2 }, { run: 1, start: 0, end: 2 }, { run: 2, start: 0, end: 2 }, { run: 3, start: 0, end: 2 },
    ]]);
    expect(findInRuns(runs('𝖡', '𝜏'), 'τ', false)).toEqual([[{ run: 1, start: 0, end: 2 }]]);
  });

  it('treats a line break as a space', () => {
    const lines = [{ text: 'end of one', gap: false }, { text: 'line and', gap: true }];
    expect(findInRuns(lines, 'one line', false)).toEqual([[{ run: 0, start: 7, end: 10 }, { run: 1, start: 0, end: 4 }]]);
    expect(findInRuns(lines, 'oneline', false)).toEqual([]);
  });

  it('respects case when asked', () => {
    expect(findInRuns(runs('Types'), 'types', true)).toEqual([]);
    expect(findInRuns(runs('Types'), 'types', false).length).toBe(1);
  });
});
