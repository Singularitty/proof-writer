import { describe, it, expect } from 'vitest';
import { locate, pageTops, totalHeight } from '../src/preview/pages';

const A4 = [842, 842, 842];

describe('laying the pages out as separate sheets', () => {
  it('puts each sheet below the one before, with the gap between', () => {
    expect(pageTops(A4, 14)).toEqual([0, 856, 1712]);
    expect(totalHeight(A4, 14)).toBe(842 * 3 + 28);
  });
  it('copes with sheets of different heights and with no sheets', () => {
    expect(pageTops([100, 300, 50], 10)).toEqual([0, 110, 420]);
    expect(totalHeight([100, 300, 50], 10)).toBe(470);
    expect(pageTops([], 14)).toEqual([]);
    expect(totalHeight([], 14)).toBe(0);
  });
});

describe('finding the sheet under a point', () => {
  it('gives the page, counted from 1, and the height within it', () => {
    expect(locate(A4, 14, 100)).toEqual({ page: 1, y: 100 });
    expect(locate(A4, 14, 856)).toEqual({ page: 2, y: 0 });
    expect(locate(A4, 14, 1712 + 841)).toEqual({ page: 3, y: 841 });
  });
  it('is nothing in the gap between two sheets, above the first or below the last', () => {
    expect(locate(A4, 14, 850)).toBe(null);
    expect(locate(A4, 14, -1)).toBe(null);
    expect(locate(A4, 14, 842 * 3 + 28 + 1)).toBe(null);
  });
});
