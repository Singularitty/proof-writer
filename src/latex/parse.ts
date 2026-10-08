// A small LaTeX *math* tokenizer and parser, covering the subset that shows up
// in programming-language papers (judgments, grammars, inference rules).

export type Tok =
  | { k: 'cmd'; v: string } // \name or \, etc. (v without backslash)
  | { k: 'char'; v: string }
  | { k: 'open' }
  | { k: 'close' }
  | { k: 'sup' }
  | { k: 'sub' }
  | { k: 'amp' }
  | { k: 'ws' }
  | { k: 'param'; n: number }; // #1 inside macro bodies

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const m = /^[A-Za-z]+/.exec(src.slice(i + 1));
      if (m) {
        out.push({ k: 'cmd', v: m[0] });
        i += 1 + m[0].length;
        // a control word swallows following spaces
        while (i < src.length && /\s/.test(src[i])) i++;
      } else if (i + 1 < src.length) {
        out.push({ k: 'cmd', v: src[i + 1] });
        i += 2;
      } else {
        out.push({ k: 'char', v: '\\' });
        i++;
      }
    } else if (c === '{') { out.push({ k: 'open' }); i++; }
    else if (c === '}') { out.push({ k: 'close' }); i++; }
    else if (c === '^') { out.push({ k: 'sup' }); i++; }
    else if (c === '_') { out.push({ k: 'sub' }); i++; }
    else if (c === '&') { out.push({ k: 'amp' }); i++; }
    else if (c === '#' && /[1-9]/.test(src[i + 1] ?? '')) { out.push({ k: 'param', n: +src[i + 1] }); i += 2; }
    else if (c === '%') { while (i < src.length && src[i] !== '\n') i++; }
    else if (/\s/.test(c)) {
      while (i < src.length && /\s/.test(src[i])) i++;
      out.push({ k: 'ws' });
    } else {
      // keep surrogate pairs together
      const cp = src.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      out.push({ k: 'char', v: ch });
      i += ch.length;
    }
  }
  return out;
}

export function untokenize(toks: Tok[]): string {
  let s = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    switch (t.k) {
      case 'cmd': {
        s += '\\' + t.v;
        const next = toks[i + 1];
        if (/^[A-Za-z]+$/.test(t.v) && next && ((next.k === 'char' && /[A-Za-z0-9]/.test(next.v)) || next.k === 'cmd')) s += ' ';
        break;
      }
      case 'char': s += t.v; break;
      case 'open': s += '{'; break;
      case 'close': s += '}'; break;
      case 'sup': s += '^'; break;
      case 'sub': s += '_'; break;
      case 'amp': s += '&'; break;
      case 'ws': s += ' '; break;
      case 'param': s += '#' + t.n; break;
    }
  }
  return s;
}

// ---------- AST ----------

export type Node =
  | { t: 'char'; v: string }
  | { t: 'cmd'; name: string; args: Node[][]; opt?: Node[] }
  | { t: 'text'; name: string; raw: string } // \text{...} and friends: raw text content
  | { t: 'group'; body: Node[] }
  | { t: 'attach'; base: Node | null; sup?: Node[]; sub?: Node[]; primes: number }
  | { t: 'env'; name: string; arg?: string; body: Node[] }
  | { t: 'amp' }
  | { t: 'newline' }
  | { t: 'ws' };

/** Number of mandatory arguments for known commands. */
export const ARITY: Record<string, number> = {
  frac: 2, dfrac: 2, tfrac: 2, cfrac: 2, binom: 2, sqrt: 1,
  overline: 1, underline: 1, hat: 1, widehat: 1, bar: 1, tilde: 1, widetilde: 1,
  vec: 1, dot: 1, ddot: 1, check: 1, breve: 1, acute: 1, grave: 1, mathring: 1,
  overrightarrow: 1, overleftarrow: 1, overbrace: 1, underbrace: 1,
  mathbf: 1, mathsf: 1, mathrm: 1, mathit: 1, mathtt: 1, mathcal: 1, mathbb: 1,
  mathfrak: 1, mathscr: 1, boldsymbol: 1, bm: 1, mathnormal: 1,
  operatorname: 1, overset: 2, underset: 2, stackrel: 2,
  mathrel: 1, mathbin: 1, mathop: 1, mathord: 1, mathpunct: 1, mathopen: 1, mathclose: 1,
  color: 1, textcolor: 2, hspace: 1, phantom: 1, hphantom: 1, vphantom: 1,
  boxed: 1, fbox: 1, cancel: 1, not: 0,
};

export const TEXT_CMDS = new Set([
  'text', 'textrm', 'textsf', 'texttt', 'textit', 'textbf', 'textsc', 'textup',
  'textnormal', 'mbox', 'emph',
]);

export class ParseError extends Error {}

export function parse(src: string): Node[] {
  return new Parser(tokenize(src)).parseAll();
}

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}

  parseAll(): Node[] {
    const out = this.parseSeq(() => false);
    return out;
  }

  peek(): Tok | undefined { return this.toks[this.i]; }

  parseSeq(stop: (t: Tok) => boolean): Node[] {
    const out: Node[] = [];
    while (this.i < this.toks.length) {
      const t = this.toks[this.i];
      if (stop(t)) break;
      if (t.k === 'close') { this.i++; continue; } // stray brace: ignore
      if (t.k === 'sup' || t.k === 'sub' || (t.k === 'char' && t.v === "'")) {
        let base: Node | null = out.length ? out[out.length - 1] : null;
        if (base && (base.t === 'ws' || base.t === 'amp' || base.t === 'newline')) base = null;
        if (base) out.pop();
        out.push(this.parseAttach(base));
        continue;
      }
      const n = this.parseAtom(stop);
      if (n) out.push(n);
    }
    return out;
  }

  parseAttach(base: Node | null): Node {
    let node: Extract<Node, { t: 'attach' }> =
      base && base.t === 'attach' ? base : { t: 'attach', base, primes: 0 };
    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.k === 'char' && t.v === "'") { node.primes++; this.i++; continue; }
      if (t.k === 'sup' || t.k === 'sub') {
        this.i++;
        const arg = this.parseArg();
        if (t.k === 'sup') {
          if (node.sup) node = { t: 'attach', base: node, primes: 0, sup: arg };
          else node.sup = arg;
        } else {
          if (node.sub) node = { t: 'attach', base: node, primes: 0, sub: arg };
          else node.sub = arg;
        }
        continue;
      }
      break;
    }
    return node;
  }

  /** A single argument: a braced group, or the next single token. */
  parseArg(): Node[] {
    while (this.peek()?.k === 'ws') this.i++;
    const t = this.peek();
    if (!t) return [];
    if (t.k === 'open') {
      this.i++;
      const body = this.parseSeq((x) => x.k === 'close');
      this.i++; // consume close
      return body;
    }
    const n = this.parseAtom(() => false);
    return n ? [n] : [];
  }

  parseOpt(): Node[] | undefined {
    let j = this.i;
    while (this.toks[j]?.k === 'ws') j++;
    const t = this.toks[j];
    if (t && t.k === 'char' && t.v === '[') {
      this.i = j + 1;
      const body = this.parseSeq((x) => x.k === 'char' && x.v === ']');
      this.i++;
      return body;
    }
    return undefined;
  }

  rawGroup(): string {
    while (this.peek()?.k === 'ws') this.i++;
    const t = this.peek();
    if (!t) return '';
    if (t.k !== 'open') {
      this.i++;
      return untokenize([t]);
    }
    this.i++;
    let depth = 1;
    const start = this.i;
    while (this.i < this.toks.length) {
      const x = this.toks[this.i];
      if (x.k === 'open') depth++;
      if (x.k === 'close') { depth--; if (depth === 0) break; }
      this.i++;
    }
    const s = untokenize(this.toks.slice(start, this.i));
    this.i++;
    return s;
  }

  parseAtom(stop: (t: Tok) => boolean): Node | null {
    const t = this.toks[this.i++];
    switch (t.k) {
      case 'ws': return { t: 'ws' };
      case 'amp': return { t: 'amp' };
      case 'char': return { t: 'char', v: t.v };
      case 'param': return { t: 'char', v: '#' + t.n };
      case 'open': {
        const body = this.parseSeq((x) => x.k === 'close');
        this.i++;
        return { t: 'group', body };
      }
      case 'close': return null;
      case 'sup': case 'sub': return null;
      case 'cmd': {
        const name = t.v;
        if (name === '\\') { this.parseOpt(); return { t: 'newline' }; }
        if (name === 'begin') {
          const env = this.rawGroup();
          let arg: string | undefined;
          if (['array', 'tabular'].includes(env)) arg = this.rawGroup();
          const body = this.parseSeq(
            (x) => x.k === 'cmd' && x.v === 'end',
          );
          if (this.peek()) { this.i++; this.rawGroup(); }
          return { t: 'env', name: env, arg, body };
        }
        if (name === 'end') { this.rawGroup(); return null; }
        if (name === 'left' || name === 'right' || /^[Bb]igg?[lr]?$/.test(name) || name === 'middle') {
          // drop sizing; keep the delimiter itself
          while (this.peek()?.k === 'ws') this.i++;
          const d = this.peek();
          if (d && d.k === 'char' && d.v === '.') { this.i++; return null; }
          return null;
        }
        if (TEXT_CMDS.has(name)) return { t: 'text', name, raw: this.rawGroup() };
        if (name === 'sqrt') {
          const opt = this.parseOpt();
          return { t: 'cmd', name, opt, args: [this.parseArg()] };
        }
        const n = ARITY[name] ?? 0;
        const args: Node[][] = [];
        for (let k = 0; k < n; k++) args.push(this.parseArg());
        void stop;
        return { t: 'cmd', name, args };
      }
    }
  }
}
