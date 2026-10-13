// Finding text in the drawn preview. The drawing carries its text invisibly, one run at a time:
// a stretch of prose, or a single symbol of a formula.

import { literal } from '../model/search';

export interface Run {
  text: string;
  /** The run starts a new line, so a space separates it from the one before. */
  gap: boolean;
}

/** Part of a match: characters `start` to `end` of a run. */
export interface Segment { run: number; start: number; end: number }

/** Unicode's compatibility forms: the letters of the math alphabets become plain letters, a ligature its letters. */
const fold = (s: string) => s.normalize('NFKC');

/** Every place `query` occurs in the runs read one after another; a match may cover parts of several. */
export function findInRuns(runs: Run[], query: string, matchCase: boolean): Segment[][] {
  const q = fold(query);
  if (!q) return [];
  // the folded text, and for each of its characters the run and characters it came from (run -1: a line break)
  let text = '';
  const from: Segment[] = [];
  runs.forEach((r, run) => {
    if (r.gap && text && !/\s$/.test(text) && !/^\s/.test(r.text)) { text += ' '; from.push({ run: -1, start: 0, end: 0 }); }
    let at = 0;
    for (const ch of r.text) {
      const plain = fold(ch);
      for (let i = 0; i < plain.length; i++) from.push({ run, start: at, end: at + ch.length });
      text += plain;
      at += ch.length;
    }
  });
  const out: Segment[][] = [];
  for (const m of text.matchAll(literal(q, matchCase))) {
    const segs: Segment[] = [];
    for (let i = m.index; i < m.index + m[0].length; i++) {
      const c = from[i];
      if (c.run < 0) continue;
      const last = segs[segs.length - 1];
      if (last?.run === c.run) last.end = c.end;
      else segs.push({ ...c });
    }
    if (segs.length) out.push(segs);
  }
  return out;
}

// ---------- on the page ----------

export interface DrawnRun extends Run { box: DOMRect }
export interface Box { left: number; top: number; width: number; height: number }

/** The text runs of the drawing, in reading order, with where each is on screen. */
export function drawnRuns(root: Element): DrawnRun[] {
  const out: DrawnRun[] = [];
  for (const el of root.querySelectorAll('.tsel')) {
    const box = (el.parentElement ?? el).getBoundingClientRect();
    const prev = out[out.length - 1];
    // further down and back to the left: a new line (a subscript is further down, but to the right)
    out.push({ text: el.textContent ?? '', box, gap: !!prev && box.top > prev.box.top + 1 && box.left < prev.box.left });
  }
  return out;
}

let ruler: CanvasRenderingContext2D | null = null;
/** How far along a run its first `n` characters reach, from 0 to 1. The run's own font is not to hand; any serif is close. */
function along(text: string, n: number): number {
  if (n <= 0) return 0;
  if (n >= text.length) return 1;
  ruler ??= Object.assign(document.createElement('canvas').getContext('2d')!, { font: '16px serif' });
  const whole = ruler.measureText(text).width;
  return whole ? ruler.measureText(text.slice(0, n)).width / whole : n / text.length;
}

/** Where a segment is drawn, measured from `origin`. */
export function segmentBox(run: DrawnRun, s: Segment, origin: { x: number; y: number }): Box {
  const a = along(run.text, s.start), b = along(run.text, s.end);
  return { left: run.box.left - origin.x + run.box.width * a, top: run.box.top - origin.y, width: Math.max(2, run.box.width * (b - a)), height: run.box.height };
}
