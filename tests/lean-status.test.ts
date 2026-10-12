import { describe, it, expect } from 'vitest';
import { emptyMechanization, readMechanization, readReport } from '../src/lean/status';

const known = new Set(['b1', 'b2']);
const report = {
  outcome: 'partial', summary: 'One lemma stuck.',
  blocks: [{ block: 'b1', file: 'PW/Defs.lean', names: ['Ty', 'HasType'] }, { block: 'nope', file: 'x', names: [] }],
  findings: [
    { kind: 'deviation', block: 'b2', message: 'Added a hypothesis.', lean: { file: 'PW/LemA.lean', line: 4 } },
    { kind: 'inconsistency', block: 'b2', related: ['b1', 'gone'], message: 'Rule and lemma disagree.' },
    { kind: 'stuck', block: 'gone', message: 'x' },
    { kind: 'opinion', block: 'b1', message: 'x' },
  ],
  proposals: [
    { block: 'b2', target: { field: 'statement' }, before: 'a', after: 'b', why: 'w' },
    { block: 'b1', target: { field: 'premise', rule: 'r1', index: 0 }, before: 'a', after: 'b', why: 'w' },
    { block: 'b1', target: { field: 'premise' }, before: 'a', after: 'b', why: 'no rule' },
    { block: 'b1', target: { field: 'title' }, before: 'a', after: 'b', why: 'w' },
  ],
  changes: [{ file: 'PW/Defs.lean', name: 'Ty', change: 'added' }, { file: 'x', name: 'y', change: 'renamed' }],
};

describe('reading a job report', () => {
  it('keeps what is well formed and names blocks the document has', () => {
    const r = readReport(report, known)!;
    expect(r.outcome).toBe('partial');
    expect(r.blocks.map((b) => b.block)).toEqual(['b1']);
    expect(r.findings.map((f) => f.kind)).toEqual(['deviation', 'inconsistency']);
    expect(r.findings[1].related).toEqual(['b1']);
    expect(r.proposals.map((p) => p.target.field)).toEqual(['statement', 'premise']);
    expect(r.changes).toEqual([{ file: 'PW/Defs.lean', name: 'Ty', change: 'added' }]);
  });
  it('is null for anything that is not a report', () => {
    for (const v of [null, 'text', 42, [], {}, { outcome: 'great' }]) expect(readReport(v, known)).toBe(null);
  });
  it('fills in missing lists', () => {
    expect(readReport({ outcome: 'done' }, known)).toEqual({ outcome: 'done', summary: '', blocks: [], findings: [], proposals: [], changes: [] });
  });
});

describe('reading the status file', () => {
  const good = {
    version: 1,
    blocks: {
      b1: { kind: 'rules', hash: 'h', file: 'PW/Defs.lean', names: ['HasType'], status: 'translated', findings: [] },
      b2: { kind: 'statement', hash: 'h', proofHash: 'p', file: 'PW/LemA.lean', names: ['lemA'], status: 'proved', assumes: ['b3'], findings: [{ kind: 'deviation', block: 'b2', message: 'm' }] },
      bad: { kind: 'statement', hash: 3, status: 'proved' },
    },
    proposals: [{ id: 'p1', state: 'dismissed', block: 'b2', target: { field: 'statement' }, before: 'a', after: 'b', why: 'w' }, { id: 'p2', state: 'maybe' }],
    lastJob: { kind: 'prove', target: 'b2', endedAt: '2026-10-12T10:00:00.000Z', model: 'opus', effort: 'high', outcome: 'done', summary: 's', changes: [] },
  };
  it('reads a file the app wrote', () => {
    const m = readMechanization(good);
    expect(Object.keys(m.blocks)).toEqual(['b1', 'b2']);
    expect(m.blocks.b2.assumes).toEqual(['b3']);
    expect(m.blocks.b2.findings).toHaveLength(1);
    expect(m.proposals.map((p) => p.id)).toEqual(['p1']);
    expect(m.lastJob?.model).toBe('opus');
  });
  it('is empty for anything else, and never throws', () => {
    for (const v of [null, undefined, 'x', [], {}, { version: 2, blocks: good.blocks }, { version: 1, blocks: 'no' }]) {
      expect(readMechanization(v)).toEqual(emptyMechanization());
    }
  });
  it('drops a last job it cannot read', () => {
    expect(readMechanization({ ...good, lastJob: { kind: 'dance' } }).lastJob).toBeUndefined();
  });
});
