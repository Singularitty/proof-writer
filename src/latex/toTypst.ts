import { parse, type Node } from './parse';
import SYMBOLS from './symbols.json';

const SYM: Record<string, string> = SYMBOLS as Record<string, string>;
const VALID_NAMES = new Set(Object.values(SYM));

/** Overrides and additions on top of the generated symbol table. */
const OVERRIDE: Record<string, string> = {
  mid: 'divides',
  llbracket: 'bracket.stroked.l',
  rrbracket: 'bracket.stroked.r',
  lBrack: 'bracket.stroked.l',
  rBrack: 'bracket.stroked.r',
  langle: 'chevron.l',
  rangle: 'chevron.r',
  emptyset: 'emptyset',
  varnothing: 'nothing',
  vdash: 'tack.r',
  dashv: 'tack.l',
  vDash: 'tack.r.double',
  models: 'tack.r.double',
  Vdash: 'forces',
  to: 'arrow.r',
  gets: 'arrow.l',
  mapsto: 'arrow.r.bar',
  longmapsto: 'arrow.r.long.bar',
  rightarrow: 'arrow.r',
  longrightarrow: 'arrow.r.long',
  Rightarrow: 'arrow.r.double',
  Longrightarrow: 'arrow.r.double.long',
  leadsto: 'arrow.r.squiggly',
  rightsquigarrow: 'arrow.r.squiggly',
  Downarrow: 'arrow.b.double',
  Uparrow: 'arrow.t.double',
  hookrightarrow: 'arrow.r.hook',
  rightharpoonup: 'harpoon.rt',
  coloneqq: 'colon.eq',
  Coloneqq: 'colon.double.eq',
  defeq: 'eq.def',
  triangleq: 'eq.delta',
  doteq: 'eq.dot',
  top: 'top',
  bot: 'bot',
  ell: 'ell',
  cdot: 'dot.c',
  cdots: 'dots.h.c',
  ldots: 'dots.h',
  dots: 'dots.h',
  vdots: 'dots.v',
  ddots: 'dots.down',
  circ: 'circle.small',
  bullet: 'bullet',
  star: 'star.op',
  lambda: 'lambda',
  Lambda: 'Lambda',
  // spacing
  ',': 'thin',
  ':': 'med',
  '>': 'med',
  ';': 'thick',
  ' ': 'space',
  '!': '',
  quad: 'quad',
  qquad: 'wide',
  // escaped characters
  '{': '{',
  '}': '}',
  '|': 'bar.v.double',
  '#': '\\#',
  '$': '\\$',
  '%': '%',
  '&': '\\&',
  '_': '\\_',
  lbrace: '{',
  rbrace: '}',
  lvert: 'bar.v',
  rvert: 'bar.v',
  vert: 'bar.v',
  Vert: 'bar.v.double',
  lVert: 'bar.v.double',
  rVert: 'bar.v.double',
  backslash: 'backslash',
  setminus: 'without',
  ast: 'ast.op',
  prime: 'prime',
  dagger: 'dagger',
  ddagger: 'dagger.double',
  displaystyle: '',
  textstyle: '',
  scriptstyle: '',
  limits: '',
  nolimits: '',
  relax: '',
  nonumber: '',
  notag: '',
};

const FONT_FN: Record<string, string> = {
  mathbf: 'bold', boldsymbol: 'bold', bm: 'bold', mathsf: 'sans', mathrm: 'upright',
  mathit: 'italic', mathtt: 'mono', mathcal: 'cal', mathscr: 'scr', mathbb: 'bb',
  mathfrak: 'frak', mathnormal: '',
};

const UPRIGHT_FONTS = new Set(['upright', 'sans', 'mono', 'bold']);

const ACCENT: Record<string, string> = {
  hat: 'hat', widehat: 'hat', bar: 'macron', overline: 'overline', underline: 'underline',
  tilde: 'tilde', widetilde: 'tilde', vec: 'arrow', overrightarrow: 'arrow',
  overleftarrow: 'arrow.l', dot: 'dot', ddot: 'dot.double', check: 'caron', breve: 'breve',
  acute: 'acute', grave: 'grave', mathring: 'circle', overbrace: 'overbrace',
  underbrace: 'underbrace', boxed: 'boxed', fbox: 'boxed', cancel: 'cancel',
};

const CLASS: Record<string, string> = {
  mathrel: 'relation', mathbin: 'binary', mathop: 'large', mathord: 'normal',
  mathpunct: 'punctuation', mathopen: 'opening', mathclose: 'closing',
};

export interface ConvertResult {
  code: string;
  warnings: string[];
}

function strLit(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

const CHAR_ESC: Record<string, string> = {
  '/': '\\/', '"': '\\"', '#': '\\#', '$': '\\$', '@': '\\@', '\\': 'backslash',
  '~': 'space.nobreak', '*': '*', '`': '\\`',
};

export function texToTypst(src: string): ConvertResult {
  const warnings: string[] = [];
  let nodes: Node[];
  try {
    nodes = parse(src);
  } catch (e) {
    return { code: strLit(src), warnings: [String(e)] };
  }
  const code = new Conv(warnings).seq(nodes, false);
  return { code: code.trim(), warnings };
}

class Conv {
  constructor(private warnings: string[]) {}

  /** Convert a sequence of nodes. `inCall` means the result is a function argument. */
  seq(nodes: Node[], inCall: boolean): string {
    const parts: string[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.t === 'ws') continue;
      // ::=  and :=
      if (n.t === 'char' && n.v === ':') {
        const a = nodes[i + 1], b = nodes[i + 2];
        if (a?.t === 'char' && a.v === ':' && b?.t === 'char' && b.v === '=') { parts.push('::='); i += 2; continue; }
        if (a?.t === 'char' && a.v === '=') { parts.push(':='); i += 1; continue; }
      }
      // digit runs (with a decimal point between digits)
      if (n.t === 'char' && /[0-9]/.test(n.v)) {
        let s = n.v;
        while (i + 1 < nodes.length) {
          const m = nodes[i + 1];
          if (m.t === 'char' && /[0-9]/.test(m.v)) { s += m.v; i++; continue; }
          const m2 = nodes[i + 2];
          if (m.t === 'char' && m.v === '.' && m2?.t === 'char' && /[0-9]/.test(m2.v)) { s += '.' + m2.v; i += 2; continue; }
          break;
        }
        parts.push(s);
        continue;
      }
      if (n.t === 'cmd' && n.name === 'not') {
        let j = i + 1;
        while (nodes[j]?.t === 'ws') j++;
        const nx = nodes[j];
        if (nx) {
          i = j;
          if (nx.t === 'char' && nx.v === '=') { parts.push('!='); continue; }
          const inner = this.node(nx, false);
          if (VALID_NAMES.has(inner + '.not')) { parts.push(inner + '.not'); continue; }
          parts.push(`cancel(${escapeForCall(inner)})`);
          continue;
        }
      }
      const s = this.node(n, inCall);
      if (s !== '') parts.push(s);
    }
    let out = parts.join(' ');
    if (inCall) out = escapeForCall(out);
    return out;
  }

  /** Something usable as a sub/superscript or attachment base. */
  atomic(nodes: Node[]): string {
    const flat = nodes.filter((n) => n.t !== 'ws');
    if (flat.length === 1 && flat[0].t === 'group') return this.atomic(flat[0].body);
    const s = this.seq(flat, false);
    if (s === '') return '""';
    if (isAtomic(s)) return s;
    return '(' + s + ')';
  }

  node(n: Node, inCall: boolean): string {
    switch (n.t) {
      case 'ws': return '';
      case 'amp': return '&';
      case 'newline': return '\\';
      case 'char': {
        if (/[A-Za-z]/.test(n.v)) return n.v;
        if (n.v in CHAR_ESC) return CHAR_ESC[n.v];
        if (n.v === ',' && inCall) return '\\,';
        return n.v;
      }
      case 'group': {
        // {:} and friends: a lone relation/operator in braces is an ordinary symbol in TeX
        const flat = n.body.filter((x) => x.t !== 'ws');
        if (flat.length === 1 && flat[0].t === 'char' && /^[:=<>,;|+\-*]$/.test(flat[0].v)) {
          const c = flat[0].v;
          return `class("normal", ${c === ',' || c === ';' ? '\\' + c : c})`;
        }
        return this.seq(n.body, false);
      }
      case 'text': {
        const raw = n.raw.replace(/\\([{}$&#%_ ])/g, '$1').replace(/~/g, ' ');
        const lit = strLit(raw);
        switch (n.name) {
          case 'textbf': return `bold(${lit})`;
          case 'textit': case 'emph': return `italic(${lit})`;
          case 'texttt': return `mono(${lit})`;
          case 'textsf': return `sans(${lit})`;
          case 'textsc': return `#smallcaps[${escapeMarkup(raw)}]`;
          default: return lit;
        }
      }
      case 'attach': {
        let base: string;
        let complex = false;
        if (!n.base) base = '""';
        else if (n.base.t === 'group') {
          const inner = this.seq(n.base.body, false);
          if (inner === '') base = '""';
          else if (isAtomic(inner)) base = inner;
          else { base = escapeForCall(inner); complex = true; }
        } else base = this.node(n.base, false) || '""';
        if (complex) {
          const opts: string[] = [];
          if (n.sup) opts.push('t: ' + this.atomic(n.sup));
          else if (n.primes) opts.push('t: ' + Array(n.primes).fill('prime').join(' '));
          if (n.sub) opts.push('b: ' + this.atomic(n.sub));
          return `attach(${base}, ${opts.join(', ')})`;
        }
        let s = base + "'".repeat(n.primes);
        if (n.sub) s += '_' + this.atomic(n.sub);
        if (n.sup) s += '^' + this.atomic(n.sup);
        return s;
      }
      case 'env': return this.env(n);
      case 'cmd': return this.cmd(n);
    }
  }

  arg(nodes: Node[]): string {
    return this.seq(nodes, true);
  }

  cmd(n: Extract<Node, { t: 'cmd' }>): string {
    const name = n.name;
    const a = n.args;
    if (name in FONT_FN) {
      const fn = FONT_FN[name];
      const flat = (a[0] ?? []).filter((x) => x.t !== 'ws');
      const plain = flat.length > 0 && flat.every((x) => x.t === 'char' && /[A-Za-z0-9]/.test(x.v));
      if (fn === '') return this.arg(a[0] ?? []);
      if (plain && UPRIGHT_FONTS.has(fn)) {
        // a word: spell it as letters so that Typst does not add operator spacing
        const letters = flat.map((x) => (x as { v: string }).v).join(' ');
        return fn === 'upright' ? `upright(${letters})` : `upright(${fn}(${letters}))`;
      }
      if (plain && fn === 'italic') return `italic(${flat.map((x) => (x as { v: string }).v).join(' ')})`;
      return `${fn}(${this.arg(a[0] ?? [])})`;
    }
    if (name in ACCENT) return `${ACCENT[name]}(${this.arg(a[0] ?? [])})`;
    if (name in CLASS) return `class(${strLit(CLASS[name])}, ${this.arg(a[0] ?? [])})`;
    switch (name) {
      case 'frac': case 'dfrac': case 'tfrac': case 'cfrac':
        return `frac(${this.arg(a[0])}, ${this.arg(a[1])})`;
      case 'binom': return `binom(${this.arg(a[0])}, ${this.arg(a[1])})`;
      case 'sqrt':
        return n.opt ? `root(${this.arg(n.opt)}, ${this.arg(a[0])})` : `sqrt(${this.arg(a[0])})`;
      case 'operatorname': {
        const flat = a[0].filter((x) => x.t !== 'ws');
        const word = flat.every((x) => x.t === 'char') ? flat.map((x) => (x as { v: string }).v).join('') : null;
        return word ? `op(${strLit(word)})` : `op(${this.arg(a[0])})`;
      }
      case 'overset': case 'stackrel':
        return `limits(${this.arg(a[1])})^${this.atomic(a[0])}`;
      case 'underset':
        return `limits(${this.arg(a[1])})_${this.atomic(a[0])}`;
      case 'color': return '';
      case 'textcolor': return this.seq(a[1], false);
      case 'hspace': return 'thin';
      case 'phantom': case 'hphantom': return `#hide[$${this.seq(a[0], false)}$]`;
      case 'vphantom': return '';
    }
    const ov = OVERRIDE[name];
    if (ov !== undefined) return ov;
    const sym = SYM[name];
    if (sym !== undefined) return sym;
    this.warnings.push(`Unknown command \\${name}`);
    return `#text(fill: red)[\\\\${name}]`;
  }

  env(n: Extract<Node, { t: 'env' }>): string {
    const rows = splitRows(n.body);
    const cell = (c: Node[]) => this.seq(c, true) || '""';
    switch (n.name) {
      case 'cases': case 'dcases':
        return `cases(${rows.map((r) => r.map((c) => this.seq(c, true)).join(' & ')).join(', ')})`;
      case 'matrix': case 'pmatrix': case 'bmatrix': case 'vmatrix': case 'array': {
        const delim = { matrix: 'delim: #none', array: 'delim: #none', pmatrix: '', bmatrix: 'delim: "["', vmatrix: 'delim: "|"' }[n.name];
        const body = rows.map((r) => r.map(cell).join(', ')).join('; ');
        return `mat(${delim ? delim + ', ' : ''}${body})`;
      }
      default: // aligned, align, gathered, split, ...
        return rows.map((r) => r.map((c) => this.seq(c, false)).join(' & ')).join(' \\ ');
    }
  }
}

function splitRows(body: Node[]): Node[][][] {
  const rows: Node[][][] = [[[]]];
  for (const n of body) {
    if (n.t === 'newline') rows.push([[]]);
    else if (n.t === 'amp') rows[rows.length - 1].push([]);
    else rows[rows.length - 1][rows[rows.length - 1].length - 1].push(n);
  }
  const last = rows[rows.length - 1];
  if (last.length === 1 && last[0].every((x) => x.t === 'ws')) rows.pop();
  return rows;
}

function isAtomic(s: string): boolean {
  return /^([A-Za-z][A-Za-z.]*|[0-9]+(\.[0-9]+)?|"[^"]*"|.)$/u.test(s) || /^[A-Za-z][A-Za-z0-9.]*\([^()]*\)$/.test(s) && balancedCall(s);
}

function balancedCall(s: string): boolean {
  const k = s.indexOf('(');
  return k > 0 && s.endsWith(')');
}

/** Inside a function call commas/semicolons separate arguments, and unbalanced parens break parsing. */
function escapeForCall(s: string): string {
  let out = '';
  let depth = 0;
  let inStr = false;
  // first pass: find unmatched parens
  const unmatched = new Set<number>();
  const stack: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '(') stack.push(i);
    else if (c === ')') { if (stack.length) stack.pop(); else unmatched.add(i); }
  }
  stack.forEach((i) => unmatched.add(i));
  inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { out += c + (s[i + 1] ?? ''); i++; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (inStr) { out += c; continue; }
    if (unmatched.has(i)) { out += '\\' + c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && (c === ',' || c === ';')) { out += '\\' + c; continue; }
    out += c;
  }
  return out;
}

/** Escape text for Typst markup mode. */
export function escapeMarkup(s: string): string {
  return s.replace(/[\\*_#$@<>\[\]`~\/;]/g, (c) => '\\' + c);
}
