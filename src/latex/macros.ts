import { tokenize, untokenize, type Tok } from './parse';

export interface MacroDef {
  name: string; // without backslash
  arity: number;
  body: string; // LaTeX, may use #1..#9
}

function readArg(toks: Tok[], i: number): [Tok[], number] {
  while (toks[i]?.k === 'ws') i++;
  const t = toks[i];
  if (!t) return [[], i];
  if (t.k !== 'open') return [[t], i + 1];
  let depth = 1;
  const start = i + 1;
  i++;
  while (i < toks.length) {
    if (toks[i].k === 'open') depth++;
    if (toks[i].k === 'close') { depth--; if (depth === 0) break; }
    i++;
  }
  return [toks.slice(start, i), i + 1];
}

export function expandTokens(toks: Tok[], macros: Map<string, MacroDef>, depth = 0): Tok[] {
  if (depth > 32 || macros.size === 0) return toks;
  const out: Tok[] = [];
  let changed = false;
  for (let i = 0; i < toks.length; ) {
    const t = toks[i];
    if (t.k === 'cmd' && macros.has(t.v)) {
      const m = macros.get(t.v)!;
      i++;
      const args: Tok[][] = [];
      for (let k = 0; k < m.arity; k++) {
        const [a, j] = readArg(toks, i);
        args.push(a);
        i = j;
      }
      // brace the body so that e.g. sub/superscripts attach to the whole expansion
      out.push({ k: 'open' });
      for (const b of tokenize(m.body)) {
        if (b.k === 'param') out.push({ k: 'open' }, ...(args[b.n - 1] ?? []), { k: 'close' });
        else out.push(b);
      }
      out.push({ k: 'close' });
      changed = true;
      continue;
    }
    out.push(t);
    i++;
  }
  return changed ? expandTokens(out, macros, depth + 1) : out;
}

export function expandMacros(src: string, macros: MacroDef[] | Map<string, MacroDef>): string {
  const map = macros instanceof Map ? macros : new Map(macros.map((m) => [m.name, m]));
  if (map.size === 0) return src;
  return untokenize(expandTokens(tokenize(src), map));
}

/** Macros in the shape KaTeX expects. */
export function katexMacros(macros: MacroDef[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const m of macros) if (m.name) o['\\' + m.name] = m.body;
  return o;
}
