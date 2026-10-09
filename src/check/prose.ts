import { expandTextSnippets, parseInline, parseProse, type Inline } from '../export/prose';

export interface ProseParts {
  /** Targets of `[[...]]` references, in order. */
  refs: string[];
  /** Inline and display math, in order. */
  math: string[];
  /** The plain text between them. */
  text: string;
}

function collect(xs: Inline[], out: ProseParts) {
  for (const x of xs) {
    if (x.k === 'ref') out.refs.push(x.v);
    else if (x.k === 'math') out.math.push(x.v);
    else if (x.k === 'text') out.text += x.v;
    else if (x.k === 'b' || x.k === 'i') collect(x.c, out);
  }
}

/** References, math and text of a prose field (paragraphs and lists). */
export function proseParts(src: string, snippets: Map<string, string>): ProseParts {
  const out: ProseParts = { refs: [], math: [], text: '' };
  for (const b of parseProse(expandTextSnippets(src, snippets))) {
    if (b.k === 'dmath') out.math.push(b.v);
    else if (b.k === 'p') collect(b.c, out);
    else for (const item of b.items) collect(item, out);
  }
  return out;
}

/** The same for a single-line field such as a case title. */
export function inlineParts(src: string, snippets: Map<string, string>): ProseParts {
  const out: ProseParts = { refs: [], math: [], text: '' };
  collect(parseInline(expandTextSnippets(src, snippets)), out);
  return out;
}
