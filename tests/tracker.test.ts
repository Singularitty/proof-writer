import { describe, it, expect } from 'vitest';
import { checkDoc } from '../src/check';
import { trackerView } from '../src/check/view';
import { externalChange } from '../src/util/external';
import { sampleDoc } from '../src/model/sample';
import type { Block, Doc } from '../src/model/types';

const view = (d: Doc) => trackerView(d, checkDoc(d));
const progress = (d: Doc) => d.blocks.find((b) => b.type === 'theorem' && b.label === 'thm:progress') as Block & { type: 'theorem' };
const casesOf = (d: Doc) => progress(d).proof![0] as Block & { type: 'cases' };

describe('tracker view', () => {
  it('lists every statement in document order, clean ones included', () => {
    const v = view(sampleDoc());
    expect(v.groups.map((g) => [g.title, g.status])).toEqual([['Canonical forms', 'ok'], ['Progress', 'ok'], ['Preservation', 'ok']]);
    expect(v.errors).toBe(0);
    expect(v.warnings).toBe(0);
  });
  it('attaches a case analysis to its statement with the rules block it ranges over', () => {
    const d = sampleDoc();
    const g = view(d).groups[1];
    expect(g.inductions).toHaveLength(1);
    expect(g.inductions[0]).toMatchObject({ id: casesOf(d).id, covered: 6, expected: 6, missing: [], source: 'matched' });
    expect(view(d).rulesBlocks.find((b) => b.id === g.inductions[0].over)!.name).toContain('T-Var');
  });
  it('words an issue inside a case by the case it is in', () => {
    const d = sampleDoc();
    const body = casesOf(d).cases[2].body[0] as Block & { type: 'text' };
    body.text += ' See [[lem:subst]].';
    const g = view(d).groups[1];
    expect(g.status).toBe('error');
    expect(g.issues).toEqual([expect.objectContaining({ code: 'dangling-ref', where: 'case T-App', jump: body.id })]);
    expect(view(d).errors).toBe(1);
  });
  it('puts a missing case under its statement and jumps to the case analysis', () => {
    const d = sampleDoc();
    casesOf(d).cases.pop();
    const g = view(d).groups[1];
    expect(g.issues).toEqual([expect.objectContaining({ code: 'missing-case', where: 'case analysis', jump: casesOf(d).id })]);
    expect(g.inductions[0]).toMatchObject({ covered: 5, expected: 6, missing: ['T-If'] });
  });
  it('jumps to the case for an issue about a case', () => {
    const d = sampleDoc();
    casesOf(d).cases[3].body = [];
    const g = view(d).groups[1];
    expect(g.status).toBe('warning');
    expect(g.issues).toEqual([expect.objectContaining({ code: 'empty-case', where: 'case T-If', jump: casesOf(d).id })]);
  });
  it('collects issues outside any statement in a last group, worded by section', () => {
    const d = sampleDoc();
    const t = d.blocks.find((b) => b.type === 'text') as Block & { type: 'text' };
    t.text += ' [[nope]]';
    const v = view(d);
    const last = v.groups[v.groups.length - 1];
    expect(last).toMatchObject({ id: null, title: 'Outside statements', status: 'error' });
    expect(last.issues).toEqual([expect.objectContaining({ where: 'Static semantics: text', jump: t.id })]);
  });
  it('does not let informational issues change a status', () => {
    const d = sampleDoc();
    casesOf(d).cases[2].body = [{ id: 'x', type: 'text', text: 'Routine.' }];
    casesOf(d).cases[3].body = [{ id: 'y', type: 'text', text: 'Routine.' }];
    const v = view(d);
    expect(v.groups[0].issues.map((i) => i.code)).toEqual(['unused']);
    expect(v.groups[0].status).toBe('ok');
  });
});

describe('a document changing on disk', () => {
  it('is ignored when the file holds what was last saved or opened', () => {
    expect(externalChange({ disk: 'a', saved: 'a', dirty: true })).toBe('ignore');
  });
  it('reloads when there are no unsaved edits', () => {
    expect(externalChange({ disk: 'b', saved: 'a', dirty: false })).toBe('reload');
  });
  it('asks when there are unsaved edits', () => {
    expect(externalChange({ disk: 'b', saved: 'a', dirty: true })).toBe('ask');
  });
});
