import { describe, it, expect } from 'vitest';
import { moveBlock } from '../src/model/move';
import type { Block } from '../src/model/types';

const text = (id: string): Block => ({ id, type: 'text', text: id });
const heading = (id: string): Block => ({ id, type: 'heading', level: 1, text: id });
const thm = (id: string, proof: Block[]): Block => ({ id, type: 'theorem', kind: 'lemma', title: '', label: '', statement: '', proof });
const cases = (id: string, bodies: Block[][]): Block => ({ id, type: 'cases', intro: '', cases: bodies.map((body, i) => ({ id: `${id}-c${i}`, title: '', body })) });
const ids = (bs: Block[]) => bs.map((b) => b.id);

function doc() {
  return [heading('h'), text('a'), text('b'), thm('t', [text('p1'), cases('k', [[text('c1')], [text('c2'), text('c3')]]), text('p2')]), text('z')];
}
const proofOf = (bs: Block[]) => (bs.find((b) => b.id === 't') as Block & { type: 'theorem' }).proof!;
const caseBody = (bs: Block[], i: number) => (proofOf(bs).find((b) => b.id === 'k') as Block & { type: 'cases' }).cases[i].body;

describe('moving a block by dragging', () => {
  it('reorders within a list, before or after the target', () => {
    const d = doc();
    expect(moveBlock(d, 'z', 'a', 'before')).toBe(true);
    expect(ids(d)).toEqual(['h', 'z', 'a', 'b', 't']);
    expect(moveBlock(d, 'h', 't', 'after')).toBe(true);
    expect(ids(d)).toEqual(['z', 'a', 'b', 't', 'h']);
  });
  it('does nothing when the block is dropped where it already is', () => {
    const d = doc();
    expect(moveBlock(d, 'a', 'b', 'before')).toBe(false);
    expect(moveBlock(d, 'b', 'a', 'after')).toBe(false);
    expect(moveBlock(d, 'a', 'a', 'after')).toBe(false);
    expect(ids(d)).toEqual(['h', 'a', 'b', 't', 'z']);
  });
  it('moves a block into a proof and into a case', () => {
    const d = doc();
    expect(moveBlock(d, 'a', 'p1', 'after')).toBe(true);
    expect(ids(d)).toEqual(['h', 'b', 't', 'z']);
    expect(ids(proofOf(d))).toEqual(['p1', 'a', 'k', 'p2']);
    expect(moveBlock(d, 'z', 'c2', 'before')).toBe(true);
    expect(ids(caseBody(d, 1))).toEqual(['z', 'c2', 'c3']);
  });
  it('moves a block out of a case to the top level', () => {
    const d = doc();
    expect(moveBlock(d, 'c3', 'h', 'after')).toBe(true);
    expect(ids(d)).toEqual(['h', 'c3', 'a', 'b', 't', 'z']);
    expect(ids(caseBody(d, 1))).toEqual(['c2']);
  });
  it('refuses to move a block into itself', () => {
    const d = doc();
    expect(moveBlock(d, 't', 'p2', 'after')).toBe(false);
    expect(moveBlock(d, 't', 'c1', 'before')).toBe(false);
    expect(moveBlock(d, 'k', 'c3', 'after')).toBe(false);
    expect(ids(d)).toEqual(['h', 'a', 'b', 't', 'z']);
  });
  it('keeps headings at the top level', () => {
    const d = doc();
    expect(moveBlock(d, 'h', 'p1', 'before')).toBe(false);
    expect(ids(d)).toEqual(['h', 'a', 'b', 't', 'z']);
  });
  it('refuses a block or target that is not there', () => {
    const d = doc();
    expect(moveBlock(d, 'nope', 'a', 'before')).toBe(false);
    expect(moveBlock(d, 'a', 'nope', 'before')).toBe(false);
  });
});
