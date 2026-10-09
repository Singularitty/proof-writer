// The renderer returns every page in one drawing, stacked with nothing between
// them. This spreads the pages apart and gives each its own sheet of paper, so
// the preview shows where the page breaks fall.

const PAGE = /<g class="typst-page" transform="translate\(0, ([\d.]+)\)"([^>]*?) data-page-width="([\d.]+)" data-page-height="([\d.]+)">/g;

export function separatePages(svg: string, gap: number): string {
  let n = 0;
  const out = svg.replace(PAGE, (_m, y: string, rest: string, w: string, h: string) => {
    const top = +y + n++ * gap;
    return `<rect class="pw-paper" x="0" y="${top}" width="${w}" height="${h}"/><g class="typst-page" transform="translate(0, ${top})"${rest} data-page-width="${w}" data-page-height="${h}">`;
  });
  if (n === 0) return svg;
  const extra = (n - 1) * gap;
  const grow = (v: string) => String(+v + extra);
  // only the opening <svg> tag carries the drawing's own height
  const end = out.indexOf('>');
  const head = out
    .slice(0, end)
    .replace(/viewBox="([\d.]+ [\d.]+ [\d.]+) ([\d.]+)"/, (_m, a: string, h: string) => `viewBox="${a} ${grow(h)}"`)
    .replace(/ (height|data-height)="([\d.]+)"/g, (_m, k: string, h: string) => ` ${k}="${grow(h)}"`);
  return head + out.slice(end);
}
