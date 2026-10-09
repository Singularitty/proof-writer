// Where each block starts in the compiled preview, and the block a click lands in.

export interface Anchor {
  /** Id of the block. */
  id: string;
  /** Page it starts on, from 1. */
  page: number;
  /** Distance from the top of that page, in points. */
  y: number;
}

/** A click this far above a block's start still counts as on it; an anchor sits at the top of the block's first line. */
const SLACK = 3;

/** The block whose content is at height `y` on `page`: the last one starting at or above that point. */
export function blockAt(anchors: Anchor[], page: number, y: number): string | null {
  let best: Anchor | null = null;
  for (const a of anchors) {
    if (a.page > page || (a.page === page && a.y - SLACK > y)) continue;
    if (!best || a.page > best.page || (a.page === best.page && a.y >= best.y)) best = a;
  }
  return best?.id ?? null;
}

/** Where a block's output is: the page, where it starts, and where the next block (or the page) ends it. */
export function anchorSpan(anchors: Anchor[], id: string, pageHeight: number): { page: number; y: number; end: number } | null {
  const a = anchors.find((x) => x.id === id);
  if (!a) return null;
  let end = pageHeight;
  for (const b of anchors) if (b.page === a.page && b.y > a.y && b.y < end) end = b.y;
  return { page: a.page, y: a.y, end };
}
