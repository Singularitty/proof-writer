import { describe, it, expect } from 'vitest';
import { splitPages } from '../src/preview/pages';

const page = (y: number, body = '<path d="M0 0"/>') => `<g class="typst-page" transform="translate(0, ${y})" data-tid="p${y}" data-page-width="596" data-page-height="842">${body}</g>`;
const svg = (pages: string[]) =>
  `<svg style="overflow: visible;" class="typst-doc" viewBox="0 0 596.000 ${842 * pages.length}.000" width="596.000" xmlns="http://www.w3.org/2000/svg"><style>.a{}</style><defs class="glyph"><path id="g1"/></defs>${pages.join('')}<script>1</script></svg>`;

describe('splitting the preview into pages', () => {
  it('gives each page its size and its own drawing, moved to the top of its sheet', () => {
    const out = splitPages(svg([page(0), page(842, '<use href="#g1"/>')]));
    expect(out.pages).toHaveLength(2);
    expect(out.pages[1]).toMatchObject({ width: 596, height: 842 });
    expect(out.pages[1].body).toBe('<g class="typst-page" transform="translate(0, 0)" data-tid="p842" data-page-width="596" data-page-height="842"><use href="#g1"/></g>');
  });
  it('keeps the styles and glyph definitions the pages share, once', () => {
    const out = splitPages(svg([page(0), page(842)]));
    expect(out.head).toBe('<style>.a{}</style><defs class="glyph"><path id="g1"/></defs>');
  });
  it('leaves the script out', () => {
    const out = splitPages(svg([page(0)]));
    expect(out.head + out.pages.map((p) => p.body).join('')).not.toContain('<script');
  });
  it('returns the same text for a page that did not change, so it need not be drawn again', () => {
    const a = splitPages(svg([page(0), page(842, '<text>one</text>')]));
    const b = splitPages(svg([page(0), page(842, '<text>two</text>')]));
    expect(b.pages[0].body).toBe(a.pages[0].body);
    expect(b.pages[1].body).not.toBe(a.pages[1].body);
  });
  it('has no pages for text it does not recognise', () => {
    expect(splitPages('<svg><g/></svg>')).toEqual({ head: '', pages: [] });
    expect(splitPages('')).toEqual({ head: '', pages: [] });
  });
});
