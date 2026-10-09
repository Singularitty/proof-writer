import { describe, it, expect } from 'vitest';
import { exportTypst } from '../src/export/typst';
import { blockAt, type Anchor } from '../src/preview/anchors';
import { sampleDoc } from '../src/model/sample';
import type { Block } from '../src/model/types';

describe('source anchors in the preview source', () => {
  it('are left out of the exported Typst', () => {
    expect(exportTypst(sampleDoc()).source).not.toContain('pw-src');
  });
  it('mark every block, nested ones included, when asked for', () => {
    const d = sampleDoc();
    const src = exportTypst(d, { anchors: true }).source;
    const ids: string[] = [];
    const walk = (bs: Block[]) => bs.forEach((b) => {
      ids.push(b.id);
      if (b.type === 'theorem' && b.proof) walk(b.proof);
      if (b.type === 'cases') b.cases.forEach((c) => walk(c.body));
    });
    walk(d.blocks);
    for (const id of ids) expect(src).toContain(`id: "${id}"`);
    expect(src.match(/<pw-src>/g)!.length).toBe(ids.length);
  });
});

describe('finding the block under a click', () => {
  const anchors: Anchor[] = [
    { id: 'a', page: 1, y: 100 },
    { id: 'b', page: 1, y: 300 },
    { id: 'c', page: 2, y: 80 },
  ];
  it('is the last block that starts at or above the click', () => {
    expect(blockAt(anchors, 1, 150)).toBe('a');
    expect(blockAt(anchors, 1, 300)).toBe('b');
    expect(blockAt(anchors, 1, 700)).toBe('b');
  });
  it('carries over from the page before when a block continues onto the next', () => {
    expect(blockAt(anchors, 2, 40)).toBe('b');
    expect(blockAt(anchors, 2, 90)).toBe('c');
    expect(blockAt(anchors, 3, 10)).toBe('c');
  });
  it('is nothing above the first block', () => {
    expect(blockAt(anchors, 1, 20)).toBe(null);
    expect(blockAt([], 1, 20)).toBe(null);
  });
  it('does not depend on the order the anchors arrive in', () => {
    expect(blockAt([...anchors].reverse(), 1, 150)).toBe('a');
  });
  it('forgives a click a little above the start of a block', () => {
    expect(blockAt(anchors, 1, 298)).toBe('b');
    expect(blockAt(anchors, 1, 290)).toBe('a');
  });
});
