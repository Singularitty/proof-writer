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
    report: null, diagnostics: [], failed: [], previous: {}, trusted: true,
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
    expect(afterSync.a.findings).toEqual([{ kind: 'deviation', block: 'a', message: 'extra hypothesis' }]);
  });
  it('records the proof hash of the job that proved it', () => {
    const previous = derive(input());
    const edited = input({ previous, target: 'b', items: [def('syn'), def('typ'), { ...st('a'), proofHash: 'p-a2' }, { ...st('b'), proofHash: 'p-b2' }] });
    const out = derive(edited);
    expect(out.a.proofHash).toBe('p-a');
    expect(out.b.proofHash).toBe('p-b2');
  });
  it('fails a definition with sorry in its region, and every statement', () => {
    const out = derive(input({ files: [{ path: 'PW/Defs.lean', text: DEFS + '\n  sorry' }, { path: 'PW/A.lean', text: proved('a') }, { path: 'PW/B.lean', text: proved('b') }] }));
    expect(out.typ.status).toBe('failed');
    expect(out.typ.findings).toEqual([{ kind: 'stuck', block: 'typ', message: 'This definition contains `sorry`; definitions must be complete.', lean: { file: 'PW/Defs.lean', line: 9 } }]);
    expect(out.syn.status).toBe('translated');
    expect(out.a.findings[0].message).toMatch(/definitions do not compile/);
    expect(out.b.status).toBe('failed');
  });
  it('fails every definition for a sorry above the first marker of its file', () => {
    const out = derive(input({ files: [{ path: 'PW/Defs.lean', text: 'sorry\n' + DEFS }, { path: 'PW/A.lean', text: proved('a') }, { path: 'PW/B.lean', text: proved('b') }] }));
    expect(out.syn.status).toBe('failed');
    expect(out.typ.status).toBe('failed');
  });
  it('calls a statement stated for a sorry in a helper lemma above its marker', () => {
    const helper = 'import PW.Defs\n\ntheorem helper : True := by\n  sorry\n\n-- pw: a\ntheorem a : True := by\n  trivial\n';
    const out = derive(input({ files: [{ path: 'PW/Defs.lean', text: DEFS }, { path: 'PW/A.lean', text: helper }, { path: 'PW/B.lean', text: proved('b') }] }));
    expect(out.a.status).toBe('stated');
    expect(out.b.status).toBe('proved');
    expect(out.b.assumes).toEqual(['a']);
  });
  it('names an axiom in the definitions when it fails the statements', () => {
    const out = derive(input({ files: [{ path: 'PW/Defs.lean', text: DEFS + '\naxiom cheat : False\n' }, { path: 'PW/A.lean', text: proved('a') }, { path: 'PW/B.lean', text: proved('b') }] }));
    expect(out.a.status).toBe('failed');
    expect(out.a.findings[0].message).toBe('Not checked: the definitions declare an axiom (cheat).');
    expect(out.b.findings[0].message).toBe('Not checked: the definitions declare an axiom (cheat).');
  });
  it('names an axiom in a cited statement\'s file when it fails the citing statement', () => {
    const files = [{ path: 'PW/Defs.lean', text: DEFS }, { path: 'PW/A.lean', text: proved('a') + 'axiom cheat : False\n' }, { path: 'PW/B.lean', text: proved('b') }];
    const out = derive(input({ files }));
    expect(out.b.findings[0].message).toBe('Not checked: a declares an axiom (cheat).');
  });
  it('keeps two identical errors at different lines', () => {
    const out = derive(input({ diagnostics: [err('PW/Defs.lean', 6, 'same'), err('PW/Defs.lean', 8, 'same')] }));
    expect(out.typ.findings.map((f) => f.lean?.line)).toEqual([6, 8]);
  });
});

const FILES = (a: string, b: string, more: DeriveInput['files'] = []) => [{ path: 'PW/Defs.lean', text: DEFS }, { path: 'PW/A.lean', text: a }, { path: 'PW/B.lean', text: b }, ...more];
const report = (findings: NonNullable<DeriveInput['report']>['findings']) => ({ outcome: 'done' as const, summary: '', blocks: [], proposals: [], changes: [], findings });
const messages = (b: { findings: { message: string }[] }) => b.findings.map((f) => f.message);

describe('the hashes a job records', () => {
  const edited = [def('syn'), { ...def('typ'), hash: 'h-typ2' }, st('a'), st('b')];
  it('keeps the recorded hash of an edited block when the sync cannot be trusted', () => {
    const previous = derive(input());
    const out = derive(input({ previous, items: edited, trusted: false }));
    expect(out.typ.hash).toBe('h-typ');
    expect(out.a.hash).toBe('h-a');
  });
  it('records the new hash after a sync that can be trusted', () => {
    const previous = derive(input());
    expect(derive(input({ previous, items: edited })).typ.hash).toBe('h-typ2');
  });
  it('never changes a recorded hash in a prove job, trusted or not', () => {
    const previous = derive(input());
    expect(derive(input({ previous, items: edited, target: 'b' })).typ.hash).toBe('h-typ');
  });
  it('gives a block with no record the hash it has now', () => {
    expect(derive(input({ trusted: false })).typ.hash).toBe('h-typ');
    expect(derive(input({ trusted: false, target: 'b' })).a.hash).toBe('h-a');
  });
  it('keeps the record of a deleted block unless a trusted sync ran', () => {
    const previous = derive(input());
    const fewer = [def('syn'), st('a'), st('b')];
    expect(derive(input({ previous, items: fewer, trusted: false })).typ).toEqual(previous.typ);
    expect(derive(input({ previous, items: fewer, target: 'b' })).typ).toEqual(previous.typ);
    expect(derive(input({ previous, items: fewer })).typ).toBeUndefined();
  });
});

describe('what a statement depends on', () => {
  // b imports a without its written proof citing it
  const uncited = new Map<string, string[]>([['a', []], ['b', []]]);
  const importsA = (id: string) => `import PW.Defs\nimport PW.A\n\n-- pw: ${id}\ntheorem ${id} : True := by\n  trivial\n`;
  it('calls a proof that imports an unproved statement proved assuming it', () => {
    const out = derive(input({ cites: uncited, files: FILES(stated('a'), importsA('b')) }));
    expect(out.b.status).toBe('proved');
    expect(out.b.assumes).toEqual(['a']);
  });
  it('fails a statement importing one whose file declares an axiom, naming it', () => {
    const out = derive(input({ cites: uncited, files: FILES(proved('a') + 'axiom cheat : False\n', importsA('b')) }));
    expect(out.b.status).toBe('failed');
    expect(messages(out.b)).toEqual(['Not checked: a declares an axiom (cheat).']);
  });
  it('fails a statement importing one that does not compile', () => {
    const out = derive(input({ cites: uncited, files: FILES(proved('a'), importsA('b')), diagnostics: [err('PW/A.lean', 5)] }));
    expect(out.b.status).toBe('failed');
    expect(messages(out.b)).toEqual(['Not checked: a does not compile.']);
  });
  it('follows imports through other statements', () => {
    const items = [def('syn'), def('typ'), st('a'), st('b'), st('c')];
    const cites = new Map<string, string[]>([['a', []], ['b', []], ['c', []]]);
    const importsB = 'import PW.B\n\n-- pw: c\ntheorem c : True := by\n  trivial\n';
    const out = derive(input({ items, cites, files: FILES(stated('a'), importsA('b'), [{ path: 'PW/C.lean', text: importsB }]) }));
    expect(out.c.status).toBe('proved');
    expect(out.c.assumes).toEqual(['a']);
  });
  it('fails a statement importing a module that is not there', () => {
    const text = 'import PW.Defs\nimport PW.Missing\n\n-- pw: b\ntheorem b : True := by\n  trivial\n';
    const out = derive(input({ files: FILES(proved('a'), text) }));
    expect(out.b.status).toBe('failed');
    expect(messages(out.b)).toEqual(['PW/B.lean imports PW.Missing, which is not in the project.']);
    expect(out.a.status).toBe('proved');
  });
  it('fails a statement importing a file of no block that holds a sorry, an axiom or an error', () => {
    const imp = 'import PW.Defs\nimport PW.Extra\n\n-- pw: b\ntheorem b : True := by\n  trivial\n';
    const extra = (text: string) => FILES(proved('a'), imp, [{ path: 'PW/Extra.lean', text }]);
    expect(messages(derive(input({ files: extra('theorem h : True := by sorry\n') })).b)).toEqual(['Not checked: PW/Extra.lean, which it relies on, holds a `sorry`.']);
    expect(messages(derive(input({ files: extra('axiom cheat : False\n') })).b)).toEqual(['Not checked: PW/Extra.lean, which it relies on, declares an axiom (cheat).']);
    expect(messages(derive(input({ files: extra('theorem h : True := trivial\n'), diagnostics: [err('PW/Extra.lean', 1)] })).b)).toEqual(['Not checked: PW/Extra.lean, which it relies on, does not compile.']);
    expect(derive(input({ files: extra('theorem h : True := trivial\n') })).b.status).toBe('proved');
  });
});

describe('modules Lake reports as failed', () => {
  it('fails a block whose module failed with no positioned diagnostic, and what rests on it', () => {
    const out = derive(input({ failed: ['A'] }));
    expect(out.a.status).toBe('failed');
    expect(out.a.findings).toEqual([{ kind: 'stuck', block: 'a', message: 'Lake reports that PW.A failed to build.' }]);
    expect(out.b.status).toBe('failed');
    expect(messages(out.b)).toEqual(['Not checked: a does not compile.']);
  });
  it('fails every definition and statement when the definitions module failed', () => {
    const out = derive(input({ failed: ['Defs'] }));
    expect(statuses(input({ failed: ['Defs'] }))).toEqual({ syn: 'failed', typ: 'failed', a: 'failed', b: 'failed' });
    expect(messages(out.typ)).toEqual(['Lake reports that PW.Defs failed to build.']);
  });
});

describe('where a block is', () => {
  it('counts a statement only in its own file, and says where else a marker for it is', () => {
    const out = derive(input({ files: FILES(proved('a'), stated('b'), [{ path: 'PW/Aaa.lean', text: '-- pw: b\n' }]) }));
    expect(out.b.status).toBe('stated');
    expect(out.b.file).toBe('PW/B.lean');
    expect(out.b.findings).toEqual([{ kind: 'stuck', block: 'b', message: 'A marker for this block is also in PW/Aaa.lean; it is ignored.' }]);
  });
  it('does not take a clean file elsewhere for a statement whose own file is missing', () => {
    const out = derive(input({ files: [{ path: 'PW/Defs.lean', text: DEFS }, { path: 'PW/A.lean', text: proved('a') }, { path: 'PW/Aaa.lean', text: proved('b') }] }));
    expect(out.b.status).toBe('failed');
    expect(messages(out.b)).toEqual(['A marker for this block is also in PW/Aaa.lean; it is ignored.', 'No Lean declaration was written for this block.']);
  });
  it('counts a definition only in PW/Defs.lean', () => {
    const out = derive(input({ items: [def('syn'), def('typ'), def('extra'), st('a')], files: FILES(proved('a') + '\n-- pw: extra\ndef extra := 1\n', proved('b')) }));
    expect(out.extra.status).toBe('failed');
    expect(out.a.status).toBe('failed');
  });
  it('fails a block whose marker has only a comment under it', () => {
    const out = derive(input({ files: FILES(proved('a'), 'import PW.Defs\n\n-- pw: b\n-- theorem b : True := trivial\n') }));
    expect(out.b.status).toBe('failed');
    expect(messages(out.b)).toEqual(['No Lean declaration was written for this block.']);
    expect(out.b.file).toBe('PW/B.lean');
  });
  it('fails a statement whose marker sits over a definition and no theorem', () => {
    const out = derive(input({ files: FILES(proved('a'), 'import PW.Defs\n\n-- pw: b\ndef b := 1\n') }));
    expect(out.b.status).toBe('failed');
  });
  it('does not take a marker inside a block comment for a declaration', () => {
    const out = derive(input({ files: FILES(proved('a'), 'import PW.Defs\n\n/-\n-- pw: b\ntheorem b : True := trivial\n-/\n') }));
    expect(out.b.status).toBe('failed');
    expect(messages(out.b)).toEqual(['No Lean declaration was written for this block.']);
  });
  it('gives a statement every error of its file, whatever other markers the file holds', () => {
    const text = proved('b') + '\n-- pw: zzz\ntheorem broken : False := by\n  trivial\n';
    const out = derive(input({ files: FILES(proved('a'), text), diagnostics: [err('PW/B.lean', 9)] }));
    expect(out.b.status).toBe('failed');
  });
  it('gives an error under a marker of no definition in PW/Defs.lean to the definition above it', () => {
    const text = DEFS + '\n-- pw: zzz\ndef broken : Nat := "x"\n';
    const out = derive(input({ files: [{ path: 'PW/Defs.lean', text }, { path: 'PW/A.lean', text: proved('a') }, { path: 'PW/B.lean', text: proved('b') }], diagnostics: [err('PW/Defs.lean', 10)] }));
    expect(out.typ.status).toBe('failed');
    expect(out.a.status).toBe('failed');
  });
  it('shows the file a block is in, not the one the report names', () => {
    const r = { ...report([]), blocks: [{ block: 'a', file: 'PW/Elsewhere.lean', names: ['a'] }] };
    const out = derive(input({ report: r }));
    expect(out.a.file).toBe('PW/A.lean');
    expect(out.a.names).toEqual(['a']);
  });
  it('remembers where a block without a declaration was last, while that file is still there', () => {
    const previous = { b: { kind: 'statement' as const, hash: 'h-b', file: 'PW/Old.lean', names: [], status: 'stated' as const, findings: [] } };
    const there = derive(input({ previous, files: [{ path: 'PW/Defs.lean', text: DEFS }, { path: 'PW/A.lean', text: proved('a') }, { path: 'PW/Old.lean', text: stated('b') }] }));
    expect(there.b.file).toBe('PW/Old.lean');
    const gone = derive(input({ previous, files: [{ path: 'PW/Defs.lean', text: DEFS }, { path: 'PW/A.lean', text: proved('a') }] }));
    expect(gone.b.file).toBe('');
  });
});

describe('recorded deviations', () => {
  const deviation = { kind: 'deviation' as const, block: 'b', message: 'extra hypothesis' };
  const previous = derive(input({ report: report([deviation, { kind: 'stuck', block: 'b', message: 'old' }]) }));
  it('stay on the statement a later prove job proves, when its report names none', () => {
    const out = derive(input({ previous, target: 'b', report: report([]) }));
    expect(out.b.status).toBe('proved');
    expect(out.b.findings).toEqual([deviation]);
  });
  it('are replaced by the deviations a later report names', () => {
    const now = { kind: 'deviation' as const, block: 'b', message: 'a different one' };
    expect(derive(input({ previous, target: 'b', report: report([now]) })).b.findings).toEqual([now]);
    expect(derive(input({ previous, report: report([now]) })).b.findings).toEqual([now]);
  });
  it('are dropped once the block has changed and been translated again', () => {
    const items = [def('syn'), def('typ'), st('a'), { ...st('b'), hash: 'h-b2' }];
    expect(derive(input({ previous, items, report: report([]) })).b.findings).toEqual([]);
  });
});
