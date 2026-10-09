// The renderer returns every page in one drawing. This takes it apart: what the
// pages share (styles, glyph outlines) and each page on its own, so the preview
// can show separate sheets and redraw only the pages an edit changed.

export interface PreviewPage {
  width: number;
  height: number;
  /** The page's drawing, placed at the top of its own sheet. */
  body: string;
}

export interface PreviewDoc {
  /** Styles and definitions every page refers to. */
  head: string;
  pages: PreviewPage[];
}

const PAGE = /<g class="typst-page" transform="translate\(0, [\d.]+\)"([^>]*?) data-page-width="([\d.]+)" data-page-height="([\d.]+)">/g;

export function splitPages(svg: string): PreviewDoc {
  const starts = [...svg.matchAll(PAGE)];
  if (!starts.length) return { head: '', pages: [] };
  const last = starts[starts.length - 1].index!;
  // after the last page come the renderer's script and the closing tag
  const script = svg.indexOf('<script', last);
  const end = script >= 0 ? script : svg.lastIndexOf('</svg>');
  const pages = starts.map((m, i): PreviewPage => {
    const from = m.index! + m[0].length;
    const to = i + 1 < starts.length ? starts[i + 1].index! : end;
    return {
      width: +m[2],
      height: +m[3],
      body: `<g class="typst-page" transform="translate(0, 0)"${m[1]} data-page-width="${m[2]}" data-page-height="${m[3]}">` + svg.slice(from, to),
    };
  });
  return { head: svg.slice(svg.indexOf('>') + 1, starts[0].index!), pages };
}
