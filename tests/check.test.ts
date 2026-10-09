import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDoc } from '../src/check';
import { sampleDoc } from '../src/model/sample';
import type { Block, Doc, ProofNode, Rule } from '../src/model/types';

let n = 0;
const id = () => `t${++n}`;

function doc(blocks: Block[], snippets: Doc['snippets'] = []): Doc {
  return { version: 1, title: 't', author: '', snippets, blocks, settings: { paper: 'a4', fontSize: 11, numberTheorems: 'shared' } };
}
const text = (t: string): Block => ({ id: id(), type: 'text', text: t });
const rule = (name: string, conclusion: string, premises: string[] = []): Rule => ({ id: id(), name, premises, conclusion });
const lemma = (label: string, proof?: Block[], kind: 'lemma' | 'theorem' | 'definition' = 'lemma'): Block & { type: 'theorem' } =>
  ({ id: id(), type: 'theorem', kind, title: label, label, statement: 'S', proof });
const cases = (intro: string, titles: string[], over?: string): Block & { type: 'cases' } => ({
  id: id(), type: 'cases', intro,
  cases: titles.map((title) => ({ id: id(), title, body: [text('Done.')] })),
  ...(over ? { over: { kind: 'rules' as const, block: over } } : {}),
});

// Two judgments with distinct shapes, written without macros.
const typing = (): Block & { type: 'rules' } => ({
  id: id(), type: 'rules', title: 'Typing', judgment: '\\Gamma \\vdash e : \\tau',
  rules: [
    rule('T-True', '\\Gamma \\vdash \\mathsf{true} : \\mathsf{Bool}'),
    rule('T-Not', '\\Gamma \\vdash \\mathsf{not}\\ e : \\mathsf{Bool}', ['\\Gamma \\vdash e : \\mathsf{Bool}']),
  ],
});
const stepping = (): Block & { type: 'rules' } => ({
  id: id(), type: 'rules', title: 'Evaluation', judgment: 'e \\longrightarrow e\'',
  rules: [rule('E-Not', '\\mathsf{not}\\ \\mathsf{true} \\longrightarrow \\mathsf{false}')],
});

const codes = (d: Doc) => checkDoc(d).issues.map((i) => i.code);

describe('sample document', () => {
  it('reports nothing above informational severity', () => {
    const r = checkDoc(sampleDoc());
    expect(r.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });
  it('finds the induction in Progress and matches it to the typing rules', () => {
    const d = sampleDoc();
    const r = checkDoc(d);
    const typingBlock = d.blocks.find((b) => b.type === 'rules' && b.rules.some((x) => x.name === 'T-App'))!;
    const progress = d.blocks.find((b) => b.type === 'theorem' && b.label === 'thm:progress')!;
    expect(r.inductions).toHaveLength(1);
    expect(r.inductions[0].over).toEqual({ block: typingBlock.id, source: 'matched' });
    expect(r.inductions[0].statement).toBe(progress.id);
    expect(r.inductions[0].missing).toEqual([]);
    expect(r.inductions[0].covered).toEqual(['T-Var', 'T-Abs', 'T-App', 'T-True', 'T-False', 'T-If']);
  });
  it('records which statements cite which', () => {
    const r = checkDoc(sampleDoc());
    const by = Object.fromEntries(r.statements.map((s) => [s.label, s]));
    expect(by['thm:progress'].cites).toEqual(['lem:canonical']);
    expect(by['lem:canonical'].citedBy).toEqual(['thm:progress']);
    expect(by['thm:preservation'].hasProof).toBe(true);
  });
});

describe('references', () => {
  it('flags a reference to nothing', () => {
    const t = text('See [[lem:nope]].');
    const r = checkDoc(doc([t]));
    expect(r.issues).toEqual([expect.objectContaining({ code: 'dangling-ref', severity: 'error', block: t.id })]);
    expect(r.issues[0].message).toContain('lem:nope');
  });
  it('accepts references to labels and to rule names', () => {
    expect(codes(doc([typing(), lemma('lem:a', [text('By [[T-True]].')]), lemma('lem:b', [text('By [[lem:a]].')]), text('[[lem:b]]')]))).toEqual([]);
  });
  it('flags a label used twice', () => {
    const a = lemma('lem:a', [text('x')]);
    const b = lemma('lem:a', [text('x')]);
    const r = checkDoc(doc([a, b, text('[[lem:a]]')]));
    expect(r.issues).toEqual([expect.objectContaining({ code: 'duplicate-label', severity: 'error', block: b.id })]);
  });
  it('flags a rule name used twice', () => {
    const t = typing();
    t.rules.push(rule('T-True', 'x'));
    expect(codes(doc([t]))).toEqual(['duplicate-rule']);
  });
  it('flags circular dependencies between statements', () => {
    const r = checkDoc(doc([lemma('lem:a', [text('By [[lem:b]].')]), lemma('lem:b', [text('By [[lem:a]].')])]));
    expect(r.issues.map((i) => i.code)).toEqual(['cycle']);
    expect(r.issues[0].message).toContain('lem:a');
    expect(r.issues[0].message).toContain('lem:b');
  });
  it('notes a lemma nothing cites, as information only', () => {
    const r = checkDoc(doc([lemma('lem:a', [text('x')])]));
    expect(r.issues).toEqual([expect.objectContaining({ code: 'unused', severity: 'info' })]);
  });
  it('does not call a theorem unused', () => {
    expect(codes(doc([lemma('thm:a', [text('x')], 'theorem')]))).toEqual([]);
  });
});

describe('unfinished statements', () => {
  it('flags a theorem with no proof', () => {
    const t = lemma('thm:a', undefined, 'theorem');
    expect(checkDoc(doc([t])).issues).toEqual([expect.objectContaining({ code: 'no-proof', severity: 'warning', block: t.id })]);
  });
  it('flags a proof that holds only blank text', () => {
    expect(codes(doc([lemma('thm:a', [text('  ')], 'theorem')]))).toEqual(['no-proof']);
  });
  it('does not expect a proof of a definition', () => {
    expect(codes(doc([lemma('def:a', undefined, 'definition')]))).toEqual([]);
  });
});

describe('case coverage', () => {
  const intro = 'By induction on the derivation of $\\Delta \\vdash t : \\sigma$.';
  it('matches the intro against the judgment form and reports the missing rule', () => {
    const ty = typing();
    const c = cases(intro, ['[[T-True]]']);
    const r = checkDoc(doc([ty, stepping(), lemma('thm:a', [c], 'theorem')]));
    expect(r.inductions[0]).toMatchObject({ id: c.id, over: { block: ty.id, source: 'matched' }, expected: ['T-True', 'T-Not'], covered: ['T-True'], missing: ['T-Not'] });
    expect(r.issues).toEqual([expect.objectContaining({ code: 'missing-case', severity: 'error', block: c.id })]);
    expect(r.issues[0].message).toContain('T-Not');
  });
  it('prefers the recorded rules block over matching', () => {
    const ty = typing();
    const st = stepping();
    const c = cases(intro, ['[[E-Not]]'], st.id);
    const r = checkDoc(doc([ty, st, lemma('thm:a', [c], 'theorem')]));
    expect(r.inductions[0].over).toEqual({ block: st.id, source: 'recorded' });
    expect(r.issues).toEqual([]);
  });
  it('falls back to the rules the cases cite when the intro has no judgment', () => {
    const st = stepping();
    const c = cases('By induction on the evaluation derivation.', ['[[E-Not]]']);
    const r = checkDoc(doc([typing(), st, lemma('thm:a', [c], 'theorem')]));
    expect(r.inductions[0].over).toEqual({ block: st.id, source: 'matched' });
  });
  it('leaves the induction unknown when nothing identifies it', () => {
    const c = cases('By case analysis on $b$.', ['$b$ is true', '$b$ is false']);
    const r = checkDoc(doc([typing(), lemma('thm:a', [c], 'theorem')]));
    expect(r.inductions[0]).toMatchObject({ over: null, expected: [], missing: [] });
    expect(r.issues).toEqual([]);
  });
  it('counts several rules named in one case title', () => {
    const c = cases(intro, ['[[T-True]], [[T-Not]]']);
    expect(checkDoc(doc([typing(), lemma('thm:a', [c], 'theorem')])).issues).toEqual([]);
  });
  it('counts a rule named in a title without brackets', () => {
    const c = cases(intro, ['Case T-True', 'Case T-Not']);
    expect(checkDoc(doc([typing(), lemma('thm:a', [c], 'theorem')])).issues).toEqual([]);
  });
  it('flags a rule covered by two cases', () => {
    const c = cases(intro, ['[[T-True]]', '[[T-Not]]', '[[T-True]]']);
    const r = checkDoc(doc([typing(), lemma('thm:a', [c], 'theorem')]));
    expect(r.issues).toEqual([expect.objectContaining({ code: 'duplicate-case', severity: 'warning', block: c.id, at: c.cases[2].id })]);
  });
  it('flags a case with nothing written in it', () => {
    const c = cases(intro, ['[[T-True]]', '[[T-Not]]']);
    c.cases[1].body = [];
    const r = checkDoc(doc([typing(), lemma('thm:a', [c], 'theorem')]));
    expect(r.issues).toEqual([expect.objectContaining({ code: 'empty-case', severity: 'warning', at: c.cases[1].id })]);
  });
  it('flags a case citing a rule from another judgment', () => {
    const c = cases(intro, ['[[T-True]]', '[[T-Not]]', '[[E-Not]]']);
    const r = checkDoc(doc([typing(), stepping(), lemma('thm:a', [c], 'theorem')]));
    expect(r.issues).toEqual([expect.objectContaining({ code: 'foreign-case', severity: 'warning', at: c.cases[2].id })]);
  });
});

describe('proof trees', () => {
  const node = (judgment: string, ruleName?: string, children: ProofNode[] = [], extra: Partial<ProofNode> = {}): ProofNode =>
    ({ id: id(), judgment, rule: ruleName, children, ...extra });
  const tree = (root: ProofNode, unknowns?: string[]): Block => ({ id: id(), type: 'derivation', root, unknowns });
  const good = () => node('\\cdot \\vdash \\mathsf{not}\\ \\mathsf{true} : \\mathsf{Bool}', 'T-Not', [node('\\cdot \\vdash \\mathsf{true} : \\mathsf{Bool}', 'T-True')]);

  it('accepts a tree whose steps match their rules', () => {
    expect(codes(doc([typing(), tree(good())]))).toEqual([]);
  });
  it('flags an open leaf', () => {
    const t = tree(node('\\cdot \\vdash \\mathsf{not}\\ \\mathsf{true} : \\mathsf{Bool}', 'T-Not', [node('\\cdot \\vdash \\mathsf{true} : \\mathsf{Bool}')]));
    expect(checkDoc(doc([typing(), t])).issues).toEqual([expect.objectContaining({ code: 'open-leaf', severity: 'warning', block: t.id })]);
  });
  it('notes an elided derivation as information', () => {
    const root = good();
    root.children[0] = node('\\cdot \\vdash \\mathsf{true} : \\mathsf{Bool}', undefined, [], { elided: true });
    expect(checkDoc(doc([typing(), tree(root)])).issues).toEqual([expect.objectContaining({ code: 'elided', severity: 'info' })]);
  });
  it('flags unknowns left unsolved', () => {
    expect(codes(doc([typing(), tree(good(), ['\\tau_1'])]))).toEqual(['unknowns']);
  });
  it('flags a step whose rule was deleted', () => {
    const root = good();
    root.ruleRef = 'gone';
    const r = checkDoc(doc([typing(), tree(root)]));
    expect(r.issues).toEqual([expect.objectContaining({ code: 'rule-missing', severity: 'error', at: root.id })]);
  });
  it('flags a step whose judgment no longer matches the rule conclusion', () => {
    const ty = typing();
    ty.rules[1].conclusion = '\\Gamma \\vdash \\mathsf{neg}\\ e : \\mathsf{Bool}';
    const root = good();
    const r = checkDoc(doc([ty, tree(root)]));
    expect(r.issues).toEqual([expect.objectContaining({ code: 'rule-drift', severity: 'warning', at: root.id })]);
  });
  it('flags a step with a different number of premises than its rule', () => {
    const ty = typing();
    ty.rules[1].premises.push('\\Gamma \\vdash e : \\mathsf{Bool}');
    const root = good();
    expect(checkDoc(doc([ty, tree(root)])).issues).toEqual([expect.objectContaining({ code: 'rule-drift', at: root.id })]);
  });
  it('resolves the rule through ruleRef when the displayed name differs', () => {
    const ty = typing();
    const root = good();
    root.rule = 'renamed';
    root.ruleRef = ty.rules[1].id;
    expect(codes(doc([ty, tree(root)]))).toEqual([]);
  });
});

describe('command line', () => {
  const cli = join(__dirname, '../src/check/cli.ts');
  const run = (args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const dir = mkdtempSync(join(tmpdir(), 'pw-check-'));

  it('prints the report for a document file as JSON', () => {
    const t = text('See [[lem:nope]].');
    const file = join(dir, 'doc.json');
    writeFileSync(file, JSON.stringify(doc([t])));
    const out = JSON.parse(run([file]));
    expect(out.issues).toEqual([expect.objectContaining({ code: 'dangling-ref', block: t.id })]);
    expect(out).toHaveProperty('statements');
    expect(out).toHaveProperty('inductions');
  });
  it('exits with an error for a file that is not a document', () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, '{"hello": 1}');
    expect(() => run([file])).toThrow(/not a Proof Writer document/);
  });
});
