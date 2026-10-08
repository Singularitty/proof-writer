// Matching a rule's conclusion (a pattern whose single-letter / greek names
// are metavariables) against a concrete judgment, then instantiating premises.

import { tokenize, untokenize, type Tok } from './parse';
import { expandMacros, type MacroDef } from './macros';

type Item =
  | { k: 'mv'; name: string; toks: Tok[] }
  | { k: 'lit'; key: string; toks: Tok[] }
  | { k: 'group'; items: Item[]; toks: Tok[] }
  | { k: 'space'; toks: Tok[] };

const SPACING_CMDS = new Set([',', ';', ':', '!', ' ', '>', 'quad', 'qquad', 'enspace', 'thinspace']);
const NON_METAVAR_CMDS = new Set(['lambda', 'Lambda', 'mu', 'nu']);
const GREEK = new Set([
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'varpi', 'rho', 'varrho', 'sigma', 'varsigma',
  'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega', 'Gamma', 'Delta', 'Theta', 'Lambda',
  'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
]);
const LITERAL_ARG_CMDS = new Set([
  'mathsf', 'mathrm', 'mathtt', 'mathbf', 'mathit', 'mathcal', 'mathbb', 'mathfrak', 'text',
  'textsf', 'textrm', 'texttt', 'textbf', 'textit', 'textsc', 'operatorname', 'mbox',
]);

function readGroup(toks: Tok[], i: number): number {
  // toks[i] is 'open'; returns index after matching close
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    if (toks[j].k === 'open') depth++;
    if (toks[j].k === 'close') { depth--; if (depth === 0) return j + 1; }
  }
  return toks.length;
}

function readAttachments(toks: Tok[], i: number): number {
  for (;;) {
    const t = toks[i];
    if (!t) return i;
    if (t.k === 'char' && t.v === "'") { i++; continue; }
    if (t.k === 'sub' || t.k === 'sup') {
      i++;
      while (toks[i]?.k === 'ws') i++;
      if (toks[i]?.k === 'open') i = readGroup(toks, i);
      else i++;
      continue;
    }
    return i;
  }
}

function key(toks: Tok[]): string {
  return untokenize(toks.filter((t) => t.k !== 'ws'));
}

function items(toks: Tok[], flat = false): Item[] {
  const out: Item[] = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.k === 'ws' || (t.k === 'cmd' && SPACING_CMDS.has(t.v)) || (t.k === 'char' && t.v === '~')) {
      out.push({ k: 'space', toks: [t] });
      i++;
      continue;
    }
    if (t.k === 'open') {
      const j = readGroup(toks, i);
      const inner = toks.slice(i + 1, j - 1);
      const j2 = readAttachments(toks, j);
      if (j2 > j) {
        const all = toks.slice(i, j2);
        out.push({ k: 'lit', key: key(all), toks: all });
      } else if (flat) out.push(...items(inner, true));
      else out.push({ k: 'group', items: items(inner), toks: toks.slice(i, j) });
      i = j2;
      continue;
    }
    const isLetter = t.k === 'char' && /^[A-Za-z]$/.test(t.v);
    const isGreek = t.k === 'cmd' && GREEK.has(t.v) && !NON_METAVAR_CMDS.has(t.v);
    if (isLetter || isGreek) {
      const j = readAttachments(toks, i + 1);
      const all = toks.slice(i, j);
      out.push({ k: 'mv', name: key(all), toks: all });
      i = j;
      continue;
    }
    if (t.k === 'cmd' && LITERAL_ARG_CMDS.has(t.v)) {
      let j = i + 1;
      while (toks[j]?.k === 'ws') j++;
      j = toks[j]?.k === 'open' ? readGroup(toks, j) : j + 1;
      j = readAttachments(toks, j);
      const all = toks.slice(i, j);
      out.push({ k: 'lit', key: key(all), toks: all });
      i = j;
      continue;
    }
    const j = readAttachments(toks, i + 1);
    const all = toks.slice(i, j);
    out.push({ k: 'lit', key: key(all), toks: all });
    i = j;
  }
  return out;
}

const OPEN = new Set(['(', '[']);
const CLOSE = new Set([')', ']']);
function balanced(xs: Item[]): boolean {
  let d = 0;
  for (const x of xs) {
    if (x.k !== 'lit') continue;
    if (OPEN.has(x.key) || x.key === '\\langle') d++;
    if (CLOSE.has(x.key) || x.key === '\\rangle') { d--; if (d < 0) return false; }
  }
  return d === 0;
}

export type Bindings = Map<string, Item[]>;

function itemsKey(xs: Item[]): string {
  return strip(xs).map((x) => (x.k === 'group' ? '{' + itemsKey(x.items) + '}' : x.k === 'mv' ? x.name : x.k === 'lit' ? x.key : '')).join(' ');
}

function dropSpace(xs: Item[]): Item[] {
  let i = 0;
  while (i < xs.length && xs[i].k === 'space') i++;
  return i ? xs.slice(i) : xs;
}

/** Prefix of T holding exactly n non-space items (or null). */
function takeN(T: Item[], n: number): number | null {
  let c = 0;
  for (let i = 0; i < T.length; i++) {
    if (T[i].k !== 'space') c++;
    if (c === n) return i + 1;
  }
  return n === 0 ? 0 : null;
}

interface MState { b: Bindings; u: Map<string, string> }
interface MCtx { unknowns: Set<string>; budget: number }

function bindingsToStrings(st: MState): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of st.b) m.set(k, itemsToSource(v));
  return m;
}

function matchList(P0: Item[], T0: Item[], st: MState, cx: MCtx): MState | null {
  if (--cx.budget < 0) return null;
  const P = strip(P0);
  const T = dropSpace(T0);
  if (P.length === 0) return T.length === 0 ? st : null;
  const [p, ...ps] = P;
  const t = T[0];
  // an open unknown in the target that is already solved: compare against its value
  if (t && t.k === 'mv' && st.u.has(t.name)) {
    const val = items(tokenize(st.u.get(t.name)!));
    return matchList(P, [...val, ...T.slice(1)], st, cx);
  }
  const tIsUnknown = !!t && t.k === 'mv' && cx.unknowns.has(t.name);
  if (p.k === 'mv') {
    const bound = st.b.get(p.name);
    if (bound) {
      const end = takeN(T, strip(bound).length);
      if (end !== null && itemsKey(T.slice(0, end)) === itemsKey(bound)) return matchList(ps, T.slice(end), st, cx);
      // unification: the target has an unknown where the pattern has a known value
      if (tIsUnknown) {
        const u = new Map(st.u);
        u.set((t as { name: string }).name, itemsToSource(bound));
        return matchList(ps, T.slice(1), { b: st.b, u }, cx);
      }
      // unification: the pattern variable was bound to an unknown, which the target now determines
      const sb = strip(bound);
      if (sb.length === 1 && sb[0].k === 'mv' && cx.unknowns.has(sb[0].name) && !st.u.has(sb[0].name)) {
        const uname = sb[0].name;
        for (let e = 1; e <= T.length; e++) {
          if (T[e - 1].k === 'space') continue;
          const val = T.slice(0, e);
          if (!balanced(val)) continue;
          const u = new Map(st.u);
          u.set(uname, itemsToSource(val));
          const nb = new Map(st.b);
          nb.set(p.name, val);
          const r = matchList(ps, T.slice(e), { b: nb, u }, cx);
          if (r) return r;
        }
      }
      return null;
    }
    for (let end = 1; end <= T.length; end++) {
      if (T[end - 1].k === 'space') continue;
      const val = T.slice(0, end);
      if (!balanced(val)) continue;
      const nb = new Map(st.b);
      nb.set(p.name, val);
      const r = matchList(ps, T.slice(end), { b: nb, u: st.u }, cx);
      if (r) return r;
    }
    return null;
  }
  if (T.length === 0) return null;
  if (p.k === 'group') {
    if (t.k === 'group') {
      const r = matchList(p.items, t.items, st, cx);
      if (r) return matchList(ps, T.slice(1), r, cx);
      // {(e)} against {e}
      const inner = strip(t.items);
      if (inner.length >= 2 && inner[0].k === 'lit' && inner[0].key === '(' && matchingParen(inner, 0) === inner.length - 1) {
        const r2 = matchList(p.items, inner.slice(1, -1), st, cx);
        if (r2) return matchList(ps, T.slice(1), r2, cx);
      }
      if (!tIsUnknown) return null;
    } else if (!tIsUnknown) {
      const r = matchList(p.items, [t], st, cx);
      return r ? matchList(ps, T.slice(1), r, cx) : null;
    }
  }
  if (p.k === 'lit' && t.k === 'lit' && p.key === t.key) return matchList(ps, T.slice(1), st, cx);
  // the target has an unknown where the pattern has structure: solve the unknown with
  // a prefix of the (instantiated) pattern
  if (tIsUnknown) {
    const name = (t as { name: string }).name;
    for (let k = 1; k <= P.length; k++) {
      const seg = P.slice(0, k);
      if (seg.some((x) => x.k === 'mv' && !st.b.has(x.name))) break;
      if (!balanced(seg)) continue;
      const u = new Map(st.u);
      u.set(name, instantiateItems(seg, bindingsToStrings(st)));
      const r = matchList(P.slice(k), T.slice(1), { b: st.b, u }, cx);
      if (r) return r;
    }
    return null;
  }
  // redundant parentheses in the target: (e) may stand for e
  if (t.k === 'lit' && t.key === '(' && !(p.k === 'lit' && p.key === '(')) {
    const close = matchingParen(T, 0);
    if (close > 0) return matchList(P, [...T.slice(1, close), ...T.slice(close + 1)], st, cx);
  }
  return null;
}

function instantiateItems(xs: Item[], b: Map<string, string>): string {
  return untokenize(substitute(xs, b)).trim();
}

function matchingParen(T: Item[], i: number): number {
  let d = 0;
  for (let j = i; j < T.length; j++) {
    const x = T[j];
    if (x.k !== 'lit') continue;
    if (x.key === '(') d++;
    if (x.key === ')') { d--; if (d === 0) return j; }
  }
  return -1;
}

const strip = (xs: Item[]) => xs.filter((x) => x.k !== 'space');

function itemsToSource(xs: Item[]): string {
  return untokenize(xs.flatMap((x) => x.toks)).trim();
}

function substitute(xs: Item[], b: Map<string, string>): Tok[] {
  const out: Tok[] = [];
  for (const x of xs) {
    if (x.k === 'mv' && b.has(x.name)) out.push(...tokenize(b.get(x.name)!));
    else if (x.k === 'group') out.push({ k: 'open' }, ...substitute(x.items, b), { k: 'close' });
    else out.push(...x.toks);
  }
  return out;
}

export interface MatchResult {
  /** Pattern metavariable -> LaTeX. */
  bindings: Map<string, string>;
  /** Unknowns of the target that the match determined. */
  solved: Map<string, string>;
  /** True when the match only succeeded after expanding snippet macros. */
  expanded: boolean;
}

/** Try to match `pattern` against `target`. `unknowns` are names in the target that may be solved. */
export function matchJudgment(pattern: string, target: string, macros?: MacroDef[], unknowns: Iterable<string> = []): MatchResult | null {
  const unk = new Set(unknowns);
  const attempt = (p: string, t: string, flat = false) => {
    const r = matchList(items(tokenize(p), flat), items(tokenize(t), flat), { b: new Map(), u: new Map() }, { unknowns: unk, budget: 20000 });
    if (!r) return null;
    // solved unknowns may refer to each other; settle them
    const solved = new Map(r.u);
    for (let i = 0; i < 4; i++) for (const [k, v] of solved) solved.set(k, instantiate(v, solved));
    const bindings = new Map<string, string>();
    for (const [k, v] of r.b) bindings.set(k, instantiate(itemsToSource(v), solved));
    return { bindings, solved };
  };
  const r = attempt(pattern, target);
  if (r) return { ...r, expanded: false };
  if (!macros?.length) return null;
  const r2 = attempt(expandMacros(pattern, macros), expandMacros(target, macros), true);
  return r2 ? { ...r2, expanded: true } : null;
}

export function instantiate(src: string, b: Map<string, string>): string {
  return untokenize(substitute(items(tokenize(src)), b)).trim();
}

/** The metavariables occurring in a LaTeX string. */
export function metavars(src: string): string[] {
  const out = new Set<string>();
  const walk = (xs: Item[]) => {
    for (const x of xs) {
      if (x.k === 'mv') out.add(x.name);
      if (x.k === 'group') walk(x.items);
    }
  };
  walk(items(tokenize(src)));
  return [...out];
}
