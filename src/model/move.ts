import type { Block } from './types';

/** The list holding the block: the document's own, a proof's, or a case's. */
function listOf(blocks: Block[], id: string): Block[] | null {
  for (const b of blocks) {
    if (b.id === id) return blocks;
    if (b.type === 'theorem' && b.proof) {
      const r = listOf(b.proof, id);
      if (r) return r;
    }
    if (b.type === 'cases') {
      for (const c of b.cases) {
        const r = listOf(c.body, id);
        if (r) return r;
      }
    }
  }
  return null;
}

/**
 * Moves the block `id` to just before or after `target`, into whichever list
 * holds the target. Returns false, changing nothing, when that is impossible
 * (a block cannot go inside itself, and headings stay at the top level) or
 * when the block is already there. `blocks` is changed in place.
 */
export function moveBlock(blocks: Block[], id: string, target: string, place: 'before' | 'after'): boolean {
  if (id === target) return false;
  const from = listOf(blocks, id);
  const to = listOf(blocks, target);
  if (!from || !to) return false;
  const i = from.findIndex((b) => b.id === id);
  const block = from[i];
  if (listOf([block], target) && to !== from) return false;
  if (block.type === 'heading' && to !== blocks) return false;
  const t = to.findIndex((b) => b.id === target);
  if (from === to && (place === 'before' ? t === i + 1 : t === i - 1)) return false;
  from.splice(i, 1);
  to.splice(to.findIndex((b) => b.id === target) + (place === 'after' ? 1 : 0), 0, block);
  return true;
}
