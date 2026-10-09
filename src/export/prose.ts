// Prose format used in text fields (a small Markdown dialect):
//   $math$ (LaTeX), $$display math$$, **bold**, *italic*, `code`,
//   [[label]] references a lemma/theorem label or a rule name,
//   {{name}} expands a text snippet, lines starting with "- " or "1. " form lists,
//   blank lines separate paragraphs.

export type Inline =
  | { k: 'text'; v: string }
  | { k: 'math'; v: string }
  | { k: 'b'; c: Inline[] }
  | { k: 'i'; c: Inline[] }
  | { k: 'code'; v: string }
  | { k: 'ref'; v: string };

export type PBlock =
  | { k: 'p'; c: Inline[] }
  | { k: 'ul'; items: Inline[][] }
  | { k: 'ol'; items: Inline[][] }
  | { k: 'dmath'; v: string };

/** Expands `{{name}}`. A snippet that reaches itself, directly or through others, is left as written at that point. */
export function expandTextSnippets(src: string, snippets: Map<string, string>, open: ReadonlySet<string> = new Set()): string {
  if (!src.includes('{{')) return src;
  return src.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (m, name: string) => {
    const body = snippets.get(name);
    if (body === undefined || open.has(name)) return m;
    return expandTextSnippets(body, snippets, new Set(open).add(name));
  });
}

export function parseProse(src: string): PBlock[] {
  const blocks: PBlock[] = [];
  // pull out display math first so it may span lines
  const chunks = src.split(/(\$\$[\s\S]*?\$\$)/);
  for (const chunk of chunks) {
    if (chunk.startsWith('$$') && chunk.endsWith('$$') && chunk.length >= 4) {
      blocks.push({ k: 'dmath', v: chunk.slice(2, -2).trim() });
      continue;
    }
    const lines = chunk.split('\n');
    let para: string[] = [];
    let list: { k: 'ul' | 'ol'; items: string[] } | null = null;
    const flushPara = () => {
      const t = para.join(' ').trim();
      if (t) blocks.push({ k: 'p', c: parseInline(t) });
      para = [];
    };
    const flushList = () => {
      if (list) blocks.push({ k: list.k, items: list.items.map(parseInline) });
      list = null;
    };
    for (const line of lines) {
      const ul = /^\s*[-•]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        const k = ul ? 'ul' : 'ol';
        if (!list || list.k !== k) { flushList(); list = { k, items: [] }; }
        list.items.push((ul ?? ol)![1]);
      } else if (line.trim() === '') {
        flushPara();
        flushList();
      } else if (list && /^\s{2,}/.test(line)) {
        list.items[list.items.length - 1] += ' ' + line.trim();
      } else {
        flushList();
        para.push(line.trim());
      }
    }
    flushPara();
    flushList();
  }
  return blocks;
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => { if (buf) out.push({ k: 'text', v: buf }); buf = ''; };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && '$*`[\\'.includes(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (c === '$') {
      const j = findClose(s, i + 1, '$');
      if (j > i) { flush(); out.push({ k: 'math', v: s.slice(i + 1, j) }); i = j + 1; continue; }
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i) { flush(); out.push({ k: 'code', v: s.slice(i + 1, j) }); i = j + 1; continue; }
    }
    if (s.startsWith('[[', i)) {
      const j = s.indexOf(']]', i + 2);
      if (j > i) { flush(); out.push({ k: 'ref', v: s.slice(i + 2, j).trim() }); i = j + 2; continue; }
    }
    if (s.startsWith('**', i)) {
      const j = s.indexOf('**', i + 2);
      if (j > i + 2) { flush(); out.push({ k: 'b', c: parseInline(s.slice(i + 2, j)) }); i = j + 2; continue; }
    }
    if (c === '*' || c === '_') {
      const prevOk = i === 0 || /[\s([{"'-]/.test(s[i - 1]);
      const j = s.indexOf(c, i + 1);
      if (prevOk && j > i + 1 && !/\s/.test(s[i + 1]) && (j + 1 >= s.length || /[\s.,;:!?)\]}"'-]/.test(s[j + 1]))) {
        flush(); out.push({ k: 'i', c: parseInline(s.slice(i + 1, j)) }); i = j + 1; continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Find the closing delimiter, skipping backslash escapes. */
function findClose(s: string, from: number, d: string): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === d) return i;
  }
  return -1;
}
