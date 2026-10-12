import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { docItems, staleness } from '../src/lean/items';
import { EFFORTS, MODELS, REPORT_SCHEMA, provePrompt, syncPrompt } from '../src/lean/prompt';
import { docMarkdown } from '../src/lean/snapshot';
import { FINDING_KINDS, OUTCOMES, PROPOSAL_FIELDS } from '../src/lean/status';
import { sampleDoc } from '../src/model/sample';
import type { Doc } from '../src/model/types';

const instructions = readFileSync(new URL('../electron/lean-instructions.md', import.meta.url), 'utf8');

const doc: Doc = {
  version: 1, title: 'Tiny', author: '', settings: { paper: 'a4', fontSize: 11, numberTheorems: 'shared' },
  snippets: [{ id: 's', kind: 'math', name: 'ty', arity: 3, body: '#1 \\vdash #2 : #3' }],
  blocks: [
    { id: 'h', type: 'heading', level: 1, text: 'Typing' },
    { id: 'g', type: 'grammar', title: 'Syntax', rows: [{ id: 'row', category: 'Types', metavar: '\\tau', alternatives: ['\\mathsf{Bool}'] }] },
    { id: 'r', type: 'rules', title: 'Typing', judgment: '\\ty{\\Gamma}{e}{\\tau}', rules: [{ id: 'r1', name: 'T-True', premises: ['p'], conclusion: 'c', side: 's' }] },
    { id: 'a', type: 'theorem', kind: 'lemma', title: 'Canonical forms', label: 'lem:canonical', statement: 'Values of type Bool are booleans.', proof: [
      { id: 'cs', type: 'cases', intro: 'By cases.', cases: [{ id: 'c1', title: 'Case [[T-True]]', body: [{ id: 't', type: 'text', text: 'Immediate.' }] }] },
    ] },
    { id: 'b', type: 'theorem', kind: 'theorem', title: 'Progress', label: 'thm:progress', statement: 'Well-typed terms step.', proof: [{ id: 't2', type: 'text', text: 'By [[lem:canonical]].' }] },
  ],
};

describe('the snapshot in Markdown', () => {
  const md = docMarkdown(doc);
  it('shows every id an agent may need to name', () => {
    for (const id of ['g', 'row', 'r', 'r1', 'a', 'cs', 'c1', 't', 'b']) expect(md).toContain('`' + id + '`');
  });
  it('shows macros, rules and statements as written', () => {
    expect(md).toContain('\\ty');
    expect(md).toContain('#1 \\vdash #2 : #3');
    expect(md).toContain('T-True');
    expect(md).toContain('Lemma 1 (Canonical forms)');
    expect(md).toContain('Theorem 2 (Progress)');
    expect(md).toContain('Values of type Bool are booleans.');
  });
  it('handles the sample document', () => {
    expect(docMarkdown(sampleDoc()).length).toBeGreaterThan(500);
  });
});

describe('the job prompts', () => {
  const items = docItems(doc);
  const cites = new Map([['a', []], ['b', ['a']]]);
  it('names every statement, its module and what it imports', () => {
    const p = syncPrompt({ items, stale: staleness(items, {}), cites, first: true });
    expect(p).toContain('PW/LemCanonical.lean');
    expect(p).toContain('PW/ThmProgress.lean');
    expect(p).toContain('PW.LemCanonical');
    expect(p).toMatch(/nothing has been translated/i);
  });
  it('lists what changed, appeared and went away on a later sync', () => {
    const recorded = Object.fromEntries(items.filter((i) => i.id !== 'g').map((i) => [i.id, { hash: i.id === 'r' ? 'old' : i.hash, kind: i.kind }]));
    recorded.gone = { hash: 'x', kind: 'statement' };
    const p = syncPrompt({ items, stale: staleness(items, recorded), cites, first: false });
    expect(p).toMatch(/Changed.*`r`/);
    expect(p).toMatch(/New.*`g`/);
    expect(p).toMatch(/Deleted.*`gone`/);
  });
  it('asks for one proof and says what may be cited', () => {
    const p = provePrompt({ item: items.find((i) => i.id === 'b')!, cited: [items.find((i) => i.id === 'a')!] });
    expect(p).toContain('`b`');
    expect(p).toContain('PW/ThmProgress.lean');
    expect(p).toContain('PW.LemCanonical');
  });
});

describe('the instructions and the report schema', () => {
  it('agree on every word a report may use', () => {
    for (const word of [...FINDING_KINDS, ...PROPOSAL_FIELDS, ...OUTCOMES]) expect(instructions).toContain('`' + word + '`');
    expect(REPORT_SCHEMA.properties.findings.items.properties.kind.enum).toEqual([...FINDING_KINDS]);
    expect(REPORT_SCHEMA.properties.proposals.items.properties.target.properties.field.enum).toEqual([...PROPOSAL_FIELDS]);
    expect(REPORT_SCHEMA.properties.outcome.enum).toEqual([...OUTCOMES]);
  });
  it('state the rules a job is held to', () => {
    for (const phrase of ['-- pw:', 'PW/Defs.lean', 'axiom', 'sorry', 'document.json', 'CONVENTIONS.md', 'lake build']) expect(instructions).toContain(phrase);
  });
  it('forbid, by name, the files a job must not touch', () => {
    const mustNot = instructions.split('## What must not be done')[1].split('\n## ')[0];
    for (const name of ['document.json', 'mechanization.json', 'PW/Defs.lean', 'CONVENTIONS.md']) expect(mustNot).toContain(name);
  });
  it('offer the models and efforts the CLI takes', () => {
    expect(MODELS).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});
