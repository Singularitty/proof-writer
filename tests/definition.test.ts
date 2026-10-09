import { describe, it, expect } from 'vitest';
import { exportTypst } from '../src/export/typst';
import { exportLatex } from '../src/export/latex';
import { checkDoc } from '../src/check';
import { trackerView } from '../src/check/view';
import { sampleDoc } from '../src/model/sample';
import type { Block, Doc } from '../src/model/types';

/** The sample with a definition that holds a rules block and a sentence. */
function withDefinition(extraText = 'Both conditions must hold.'): Doc {
  const d = sampleDoc();
  const def: Block = {
    id: 'def', type: 'theorem', kind: 'definition', title: 'Ownership', label: 'def:own', statement: 'A register owns a region when:',
    proof: [
      { id: 'defrules', type: 'rules', title: '', judgment: '', rules: [{ id: 'r1', name: 'Own-Alive', premises: ['a'], conclusion: 'b' }] },
      { id: 'deftext', type: 'text', text: extraText },
    ],
  };
  d.blocks.push(def);
  return d;
}

describe('a definition with content inside it', () => {
  it('is exported to Typst with the content inside the definition and no proof', () => {
    const src = exportTypst(withDefinition()).source;
    const start = src.indexOf('A register owns a region when:');
    const end = src.indexOf('<def:own>');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const inside = src.slice(start, end);
    expect(inside).toContain('Own-Alive');
    expect(inside).toContain('Both conditions must hold.');
    expect(inside).not.toContain('pw-proof');
    expect(src.slice(end, end + 40)).not.toContain('pw-proof');
  });
  it('is exported to LaTeX inside the definition environment and no proof', () => {
    const src = exportLatex(withDefinition()).source;
    const start = src.indexOf('A register owns a region when:');
    const end = src.indexOf('\\end{definition}', start);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).toContain('Own-Alive');
    expect(src.slice(start, end)).toContain('Both conditions must hold.');
    expect(src.slice(start, end + 60)).not.toContain('\\begin{proof}');
  });
  it('still gives a theorem its proof', () => {
    expect(exportTypst(sampleDoc()).source).toContain('pw-proof');
    expect(exportLatex(sampleDoc()).source).toContain('\\begin{proof}');
  });
  it('is checked like any other content, and its problems are worded as being in the definition', () => {
    const d = withDefinition('See [[nope]].');
    const r = checkDoc(d);
    const g = trackerView(d, r).groups.find((x) => x.id === 'def')!;
    expect(g.issues).toEqual([expect.objectContaining({ code: 'dangling-ref', where: 'definition' })]);
    expect(r.issues.some((i) => i.code === 'no-proof' && i.block === 'def')).toBe(false);
  });
});
