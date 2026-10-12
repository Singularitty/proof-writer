import { describe, it, expect } from 'vitest';
import { derive, type DeriveInput } from '../src/lean/derive';
import type { Item } from '../src/lean/items';
import type { Diagnostic } from '../src/lean/build';

const def = (id: string): Item => ({ id, kind: 'rules', hash: 'h-' + id, hasProof: false, label: '', title: id });
const st = (id: string): Item => ({ id, kind: 'statement', hash: 'h-' + id, proofHash: 'p-' + id, hasProof: true, label: id, title: id, module: id.toUpperCase() });
const err = (file: string, line: number, message = 'boom'): Diagnostic => ({ file, line, column: 0, severity: 'error', message });

const DEFS = ['-- pw: syn', 'inductive Ty where', '  | bool', '', '-- pw: typ', 'inductive HasType where', '  -- pw: typ r1', '  | tTrue : HasType'].join('\n');
const proved = (id: string) => `import PW.Defs\n\n-- pw: ${id}\ntheorem ${id} : True := by\n  trivial\n`;
const stated = (id: string) => `import PW.Defs\n\n-- pw: ${id}\ntheorem ${id} : True := by\n  sorry\n`;

function input(over: Partial<DeriveInput> = {}): DeriveInput {
  return {
    items: [def('syn'), def('typ'), st('a'), st('b')],
    cites: new Map([['a', []], ['b', ['a']]]),
    report: null, diagnostics: [], previous: {},
    files: [{ path: 'PW/Defs.lean', text: DEFS }, { path: 'PW/A.lean', text: proved('a') }, { path: 'PW/B.lean', text: proved('b') }],
    ...over,
  };
}
const statuses = (i: DeriveInput) => Object.fromEntries(Object.entries(derive(i)).map(([id, b]) => [id, b.status]));

describe('deriving statuses', () => {
  it('calls a clean build translated and proved, and records where things are', () => {
    const out = derive(input());
    expect(statuses(input())).toEqual({ syn: 'translated', typ: 'translated', a: 'proved', b: 'proved' });
    expect(out.typ.file).toBe('PW/Defs.lean');
    expect(out.a).toMatchObject({ kind: 'statement', hash: 'h-a', proofHash: 'p-a', file: 'PW/A.lean', findings: [] });
    expect(out.b.assumes).toBeUndefined();
  });
  it('takes declaration names from the report', () => {
    const report = { outcome: 'done' as const, summary: '', blocks: [{ block: 'typ', file: 'PW/Defs.lean', names: ['HasType'] }], findings: [], proposals: [], changes: [] };
    expect(derive(input({ report })).typ.names).toEqual(['HasType']);
  });
  it('fails a block nothing was written for', () => {
    const out = derive(input({ items: [def('syn'), def('typ'), def('missing'), st('a')] }));
    expect(out.missing.status).toBe('failed');
    expect(out.missing.findings[0].message).toMatch(/No Lean declaration/);
  });
  it('pins a build error to the block whose region holds it', () => {
    const out = derive(input({ diagnostics: [err('PW/Defs.lean', 8, 'bad constructor')] }));
    expect(out.typ.status).toBe('failed');
    expect(out.typ.findings).toEqual([{ kind: 'stuck', block: 'typ', message: 'bad constructor', lean: { file: 'PW/Defs.lean', line: 8 } }]);
    expect(out.syn.status).toBe('translated');
  });
  it('gives an error above the first marker to every block of the file', () => {
    const text = 'import Nope\n' + DEFS;
    const out = derive(input({ files: [{ path: 'PW/Defs.lean', text }, { path: 'PW/A.lean', text: proved('a') }, { path: 'PW/B.lean', text: proved('b') }], diagnostics: [err('PW/Defs.lean', 1)] }));
    expect(out.syn.status).toBe('failed');
    expect(out.typ.status).toBe('failed');
  });
  it('does not check statements when a definition failed', () => {
    const out = derive(input({ diagnostics: [err('PW/Defs.lean', 2)] }));
    expect(out.a.status).toBe('failed');
    expect(out.a.findings[0].message).toMatch(/definitions do not compile/);
  });
  it('calls a statement with sorry stated, by scan or by the build warning', () => {
    const files = [{ path: 'PW/Defs.lean', text: DEFS }, { path: 'PW/A.lean', text: stated('a') }, { path: 'PW/B.lean', text: proved('b') }];
    expect(statuses(input({ files })).a).toBe('stated');
    const warned = input({ diagnostics: [{ file: 'PW/A.lean', line: 4, column: 8, severity: 'warning', message: "declaration uses 'sorry'" }] });
    expect(statuses(warned).a).toBe('stated');
  });
  it('lists the unproved statements a proof rests on', () => {
    const files = [{ path: 'PW/Defs.lean', text: DEFS }, { path: 'PW/A.lean', text: stated('a') }, { path: 'PW/B.lean', text: proved('b') }];
    const out = derive(input({ files }));
    expect(out.b.status).toBe('proved');
    expect(out.b.assumes).toEqual(['a']);
  });
  it('fails a statement citing a failed one, however clean its own file looks', () => {
    const out = derive(input({ diagnostics: [err('PW/A.lean', 5)] }));
    expect(out.a.status).toBe('failed');
    expect(out.b.status).toBe('failed');
    expect(out.b.findings[0].message).toMatch(/Not checked/);
  });
  it('survives a citation cycle', () => {
    expect(statuses(input({ cites: new Map([['a', ['b']], ['b', ['a']]]) }))).toMatchObject({ a: 'proved', b: 'proved' });
  });
  it('fails everything in a file that declares an axiom, and what cites it', () => {
    const files = [{ path: 'PW/Defs.lean', text: DEFS }, { path: 'PW/A.lean', text: proved('a') + 'axiom cheat : False\n' }, { path: 'PW/B.lean', text: proved('b') }];
    const out = derive(input({ files }));
    expect(out.a.status).toBe('failed');
    expect(out.a.findings[0].message).toMatch(/axiom.*cheat/);
    expect(out.b.status).toBe('failed');
  });
  it('attaches report findings to their block and to related blocks', () => {
    const report = { outcome: 'partial' as const, summary: '', blocks: [], proposals: [], changes: [], findings: [
      { kind: 'deviation' as const, block: 'a', message: 'extra hypothesis' },
      { kind: 'inconsistency' as const, block: 'b', related: ['typ'], message: 'rule and lemma disagree' },
    ] };
    const out = derive(input({ report }));
    expect(out.a.findings.map((f) => f.kind)).toEqual(['deviation']);
    expect(out.b.findings.map((f) => f.kind)).toEqual(['inconsistency']);
    expect(out.typ.findings.map((f) => f.kind)).toEqual(['inconsistency']);
  });
  it('keeps other blocks earlier deviations across a prove job, and drops their old stuck findings', () => {
    const previous = derive(input({ report: { outcome: 'done', summary: '', blocks: [], proposals: [], changes: [], findings: [{ kind: 'deviation', block: 'a', message: 'extra hypothesis' }, { kind: 'stuck', block: 'a', message: 'old' }] } }));
    const out = derive(input({ previous, target: 'b' }));
    expect(out.a.findings).toEqual([{ kind: 'deviation', block: 'a', message: 'extra hypothesis' }]);
    const afterSync = derive(input({ previous }));
    expect(afterSync.a.findings).toEqual([]);
  });
  it('records the proof hash of the job that proved it', () => {
    const previous = derive(input());
    const edited = input({ previous, target: 'b', items: [def('syn'), def('typ'), { ...st('a'), proofHash: 'p-a2' }, { ...st('b'), proofHash: 'p-b2' }] });
    const out = derive(edited);
    expect(out.a.proofHash).toBe('p-a');
    expect(out.b.proofHash).toBe('p-b2');
  });
});
