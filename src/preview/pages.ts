// The preview is one drawing with every page in it. These place the pages as
// separate sheets with a gap between them, and find the sheet under a point.
// All heights are in the drawing's own units (points).

/** Space between sheets. */
export const PAGE_GAP = 14;

/** Where each sheet starts. */
export function pageTops(heights: number[], gap: number): number[] {
  const tops: number[] = [];
  let y = 0;
  for (const h of heights) {
    tops.push(y);
    y += h + gap;
  }
  return tops;
}

export function totalHeight(heights: number[], gap: number): number {
  return heights.reduce((a, h) => a + h, 0) + Math.max(0, heights.length - 1) * gap;
}

/** The page (from 1) at height `y` of the drawing and the height within that page; null between or outside the sheets. */
export function locate(heights: number[], gap: number, y: number): { page: number; y: number } | null {
  const tops = pageTops(heights, gap);
  for (let i = 0; i < heights.length; i++) {
    if (y >= tops[i] && y <= tops[i] + heights[i]) return { page: i + 1, y: y - tops[i] };
  }
  return null;
}
