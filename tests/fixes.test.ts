import { describe, it, expect } from 'vitest';
import { expandTextSnippets } from '../src/export/prose';
import { checkDoc } from '../src/check';
import { uncoveredRules } from '../src/check/coverage';
import { sampleDoc } from '../src/model/sample';
import type { Block } from '../src/model/types';

const progressCases = (d: ReturnType<typeof sampleDoc>) =>
  (d.blocks.find((b) => b.type === 'theorem' && b.label === 'thm:progress') as Block & { type: 'theorem' }).proof![0] as Block & { type: 'cases' };
const typing = (d: ReturnType<typeof sampleDoc>) => d.blocks.find((b) => b.type === 'rules' && b.rules.some((r) => r.name === 'T-App')) as Block & { type: 'rules' };

describe('text snippets', () => {
  it('expand a snippet that names itself once and leave the inner reference', () => {
    expect(expandTextSnippets('{{a}}', new Map([['a', 'see {{a}} here']]))).toBe('see {{a}} here');
  });
  it('stop at a cycle between two snippets', () => {
    expect(expandTextSnippets('{{a}}', new Map([['a', 'A {{b}}'], ['b', 'B {{a}}']]))).toBe('A B {{a}}');
  });
  it('still expand nested snippets and repeated uses', () => {
    const s = new Map([['ind', 'By induction on {{what}}'], ['what', 'the derivation']]);
    expect(expandTextSnippets('{{ind}}. {{ind}}.', s)).toBe('By induction on the derivation. By induction on the derivation.');
    expect(expandTextSnippets('{{nope}}', s)).toBe('{{nope}}');
  });
});

describe('one case per rule', () => {
  const none = new Map<string, string>();
  it('offers only the rules no case names yet', () => {
    expect(uncoveredRules(['[[T-Var]]', 'Case T-App', '[[T-True]], [[T-False]]'], ['T-Var', 'T-Abs', 'T-App', 'T-True', 'T-False', 'T-If'], none)).toEqual(['T-Abs', 'T-If']);
  });
  it('offers every rule when there are no cases', () => {
    expect(uncoveredRules([], ['E-App1', 'E-App2'], none)).toEqual(['E-App1', 'E-App2']);
  });
  it('lists a rule name once even if the block repeats it', () => {
    expect(uncoveredRules([], ['T-A', 'T-A', 'T-B'], none)).toEqual(['T-A', 'T-B']);
  });
});

describe('coverage with a repeated rule name', () => {
  it('counts the name once', () => {
    const d = sampleDoc();
    const t = typing(d);
    t.rules.push({ ...t.rules[2], id: 'dup' });
    const ind = checkDoc(d).inductions[0];
    expect(ind.expected).toHaveLength(6);
    expect(ind.covered).toHaveLength(6);
  });
});

describe('wording of an empty case', () => {
  it('names the case without its brackets', () => {
    const d = sampleDoc();
    progressCases(d).cases[3].body = [];
    expect(checkDoc(d).issues.find((i) => i.code === 'empty-case')!.message).toBe('The case T-If has nothing in it');
  });
  it('numbers a case that has no title', () => {
    const d = sampleDoc();
    const c = progressCases(d);
    c.cases.push({ id: 'x', title: '', body: [] });
    expect(checkDoc(d).issues.find((i) => i.code === 'empty-case')!.message).toBe('Case 5 has nothing in it');
  });
});
