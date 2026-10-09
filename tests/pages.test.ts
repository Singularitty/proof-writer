import { describe, it, expect } from 'vitest';
import { separatePages } from '../src/preview/pages';

const page = (y: number) => `<g class="typst-page" transform="translate(0, ${y})" data-tid="p${y}" data-page-width="596" data-page-height="842"><path d="M0 0"/></g>`;
const svg = (pages: number[]) =>
  `<svg style="overflow: visible;" class="typst-doc" viewBox="0 0 596.000 ${842 * pages.length}.000" width="596.000" height="${842 * pages.length}.000" data-width="596.000" data-height="${842 * pages.length}.000" xmlns="http://www.w3.org/2000/svg"><style>.a{}</style>${pages.map(page).join('')}<script>1</script></svg>`;

describe('separating the pages of the preview', () => {
  it('moves each page down by the gaps before it and grows the drawing to fit', () => {
    const out = separatePages(svg([0, 842, 1684]), 20);
    expect([...out.matchAll(/<g class="typst-page" transform="translate\(0, ([\d.]+)\)"/g)].map((m) => +m[1])).toEqual([0, 862, 1724]);
    expect(out).toContain('viewBox="0 0 596.000 2566"');
    expect(out).toContain(' height="2566"');
  });
  it('puts a sheet of paper behind every page, where the page now is', () => {
    const out = separatePages(svg([0, 842]), 20);
    expect([...out.matchAll(/<rect class="pw-paper" x="0" y="([\d.]+)" width="596" height="842"\/><g class="typst-page"/g)].map((m) => +m[1])).toEqual([0, 862]);
  });
  it('leaves the page contents as they were', () => {
    const out = separatePages(svg([0, 842]), 20);
    expect(out.match(/<path d="M0 0"\/>/g)).toHaveLength(2);
    expect(out).toContain('<script>1</script></svg>');
  });
  it('gives a single page its paper and no extra height', () => {
    const out = separatePages(svg([0]), 20);
    expect(out).toContain('viewBox="0 0 596.000 842"');
    expect(out.match(/pw-paper/g)).toHaveLength(1);
  });
  it('returns text it does not recognise unchanged', () => {
    expect(separatePages('<svg><g/></svg>', 20)).toBe('<svg><g/></svg>');
  });
});
