// Typst math → LaTeX math (the app's math syntax). Covers the common subset used in
// type-system papers: symbols with modifiers, strings, attachments, calls like
// cases/underbrace/italic, alignment and line breaks.

type Tok =
  | { k: 'str'; v: string }
  | { k: 'ident'; v: string } // multi-letter identifier, possibly with .modifiers
  | { k: 'letter'; v: string }
  | { k: 'num'; v: string }
  | { k: 'op'; v: string } // punctuation / multi-char shorthand
  | { k: 'ws' };

const SHORTHANDS = ['::=', '|->', '...', '->', '<-', '=>', '<=', '>=', '!=', ':=', '==', '=:', '~~', '<<', '>>', '|-', '||'];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      while (i < src.length && /\s/.test(src[i])) i++;
      out.push({ k: 'ws' });
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { // line comment
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1, v = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { v += src[j + 1]; j += 2; continue; }
        v += src[j++];
      }
      out.push({ k: 'str', v });
      i = j + 1;
      continue;
    }
    if (c === '\\') {
      // `\` followed by whitespace/end is a line break; otherwise an escaped char.
      if (i + 1 >= src.length || /\s/.test(src[i + 1])) { out.push({ k: 'op', v: '\\' }); i++; continue; }
      out.push({ k: 'op', v: 'esc:' + src[i + 1] });
      i += 2;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9]/.test(src[j])) j++;
      // modifiers: .name directly attached
      while (src[j] === '.' && /[A-Za-z]/.test(src[j + 1] ?? '')) {
        j++;
        while (j < src.length && /[A-Za-z0-9]/.test(src[j])) j++;
      }
      const word = src.slice(i, j);
      if (word.length === 1) out.push({ k: 'letter', v: word });
      else if (/^[A-Za-z][0-9]+$/.test(word)) { out.push({ k: 'letter', v: word[0] }); out.push({ k: 'num', v: word.slice(1) }); }
      else out.push({ k: 'ident', v: word });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) { j++; while (j < src.length && /[0-9]/.test(src[j])) j++; }
      out.push({ k: 'num', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const sh = SHORTHANDS.find((s) => src.startsWith(s, i));
    if (sh) { out.push({ k: 'op', v: sh }); i += sh.length; continue; }
    out.push({ k: 'op', v: c });
    i++;
  }
  return out;
}

// Typst symbol name → LaTeX. Values starting with a letter-free string are emitted verbatim.
const SYM: Record<string, string> = {
  // Greek
  alpha: '\\alpha', beta: '\\beta', gamma: '\\gamma', delta: '\\delta', epsilon: '\\varepsilon', 'epsilon.alt': '\\epsilon',
  zeta: '\\zeta', eta: '\\eta', theta: '\\theta', 'theta.alt': '\\vartheta', iota: '\\iota', kappa: '\\kappa', lambda: '\\lambda',
  mu: '\\mu', nu: '\\nu', xi: '\\xi', omicron: 'o', pi: '\\pi', rho: '\\rho', sigma: '\\sigma', 'sigma.alt': '\\varsigma', tau: '\\tau',
  upsilon: '\\upsilon', phi: '\\varphi', 'phi.alt': '\\phi', chi: '\\chi', psi: '\\psi', omega: '\\omega',
  Alpha: '\\mathrm{A}', Beta: '\\mathrm{B}', Gamma: '\\Gamma', Delta: '\\Delta', Epsilon: '\\mathrm{E}', Zeta: '\\mathrm{Z}', Eta: '\\mathrm{H}',
  Theta: '\\Theta', Iota: '\\mathrm{I}', Kappa: '\\mathrm{K}', Lambda: '\\Lambda', Mu: '\\mathrm{M}', Nu: '\\mathrm{N}', Xi: '\\Xi',
  Pi: '\\Pi', Rho: '\\mathrm{P}', Sigma: '\\Sigma', Tau: '\\mathrm{T}', Upsilon: '\\Upsilon', Phi: '\\Phi', Chi: '\\mathrm{X}', Psi: '\\Psi', Omega: '\\Omega',
  ell: '\\ell',
  // arrows
  arrow: '\\rightarrow', 'arrow.r': '\\rightarrow', 'arrow.l': '\\leftarrow', 'arrow.t': '\\uparrow', 'arrow.b': '\\downarrow',
  'arrow.l.r': '\\leftrightarrow', 'arrow.r.long': '\\longrightarrow', 'arrow.l.long': '\\longleftarrow',
  'arrow.r.double': '\\Rightarrow', 'arrow.double': '\\Rightarrow', 'arrow.double.r': '\\Rightarrow',
  'arrow.l.double': '\\Leftarrow', 'arrow.double.l': '\\Leftarrow', 'arrow.l.r.double': '\\Leftrightarrow',
  'arrow.b.double': '\\Downarrow', 'arrow.double.b': '\\Downarrow', 'arrow.t.double': '\\Uparrow', 'arrow.double.t': '\\Uparrow',
  'arrow.r.double.long': '\\Longrightarrow', 'arrow.r.long.double': '\\Longrightarrow',
  'arrow.l.hook': '\\hookleftarrow', 'arrow.hook.l': '\\hookleftarrow', 'arrow.r.hook': '\\hookrightarrow', 'arrow.hook.r': '\\hookrightarrow',
  'arrow.r.bar': '\\mapsto', 'arrow.bar': '\\mapsto', mapsto: '\\mapsto', 'arrow.r.squiggly': '\\leadsto', 'arrow.squiggly': '\\leadsto',
  'arrow.r.harpoon': '\\rightharpoonup', 'harpoon.rt': '\\rightharpoonup',
  // relations and operators
  in: '\\in', 'in.not': '\\notin', 'in.rev': '\\ni', 'in.small': '\\in',
  subset: '\\subset', 'subset.eq': '\\subseteq', 'subset.neq': '\\subsetneq', supset: '\\supset', 'supset.eq': '\\supseteq',
  'subset.sq': '\\sqsubset', 'subset.eq.sq': '\\sqsubseteq', 'subset.sq.eq': '\\sqsubseteq', 'supset.sq': '\\sqsupset', 'supset.eq.sq': '\\sqsupseteq', 'supset.sq.eq': '\\sqsupseteq',
  tack: '\\vdash', 'tack.r': '\\vdash', 'tack.l': '\\dashv', 'tack.not': '\\nvdash', 'tack.r.not': '\\nvdash', 'tack.double': '\\vDash', 'tack.r.double': '\\vDash', 'tack.double.not': '\\nvDash', models: '\\models',
  'eq.not': '\\neq', eq: '=', 'eq.triple': '\\equiv', equiv: '\\equiv', 'eq.def': '\\triangleq', 'eq.delta': '\\triangleq', 'eq.colon': '\\coloneqq', approx: '\\approx', tilde: '\\sim', 'tilde.op': '\\sim', 'tilde.eq': '\\simeq', 'tilde.equiv': '\\cong',
  lt: '<', gt: '>', 'lt.eq': '\\leq', 'gt.eq': '\\geq', prec: '\\prec', succ: '\\succ', 'prec.eq': '\\preceq', 'succ.eq': '\\succeq',
  without: '\\setminus', times: '\\times', 'times.o': '\\otimes', 'times.big': '\\prod', 'plus.o': '\\oplus', 'plus.minus': '\\pm', 'minus.plus': '\\mp', minus: '-', plus: '+',
  'dot.op': '\\cdot', 'dot.c': '\\cdot', 'dot.o': '\\odot', 'circle.small': '\\circ', compose: '\\circ', ast: '*', 'ast.op': '\\ast', star: '\\star', 'star.op': '\\star', bullet: '\\bullet', div: '\\div',
  union: '\\cup', 'union.big': '\\bigcup', 'union.plus': '\\uplus', 'union.sq': '\\sqcup', sect: '\\cap', inter: '\\cap', 'sect.big': '\\bigcap', 'inter.big': '\\bigcap', 'sect.sq': '\\sqcap', 'inter.sq': '\\sqcap',
  and: '\\land', or: '\\lor', not: '\\neg', 'and.big': '\\bigwedge', 'or.big': '\\bigvee', forall: '\\forall', exists: '\\exists', 'exists.not': '\\nexists',
  emptyset: '\\emptyset', nothing: '\\varnothing', top: '\\top', bot: '\\bot', infinity: '\\infty', oo: '\\infty', partial: '\\partial', nabla: '\\nabla',
  square: '\\square', 'square.stroked': '\\square', qed: '\\square', diamond: '\\diamond', triangle: '\\triangle', checkmark: '\\checkmark',
  sum: '\\sum', product: '\\prod', integral: '\\int', 'bar.v': '|', 'bar.v.double': '\\|', divides: '\\mid', 'divides.not': '\\nmid', parallel: '\\parallel', perp: '\\perp',
  dots: '\\dots', 'dots.h': '\\ldots', 'dots.c': '\\cdots', 'dots.v': '\\vdots', 'dots.down': '\\ddots', 'dots.h.c': '\\cdots',
  'chevron.l': '\\langle', 'chevron.r': '\\rangle', 'angle.l': '\\langle', 'angle.r': '\\rangle',
  'chevron.l.double': '\\langle\\!\\langle', 'chevron.r.double': '\\rangle\\!\\rangle',
  'bracket.l.double': '\\llbracket', 'bracket.r.double': '\\rrbracket', 'bracket.l.stroked': '\\llbracket', 'bracket.r.stroked': '\\rrbracket',
  'floor.l': '\\lfloor', 'floor.r': '\\rfloor', 'ceil.l': '\\lceil', 'ceil.r': '\\rceil',
  'brace.l': '\\{', 'brace.r': '\\}', 'paren.l': '(', 'paren.r': ')', 'bracket.l': '[', 'bracket.r': ']',
  colon: ':', 'colon.eq': '\\coloneqq', 'colon.double.eq': '::=', semi: ';', comma: ',', prime: "'", hash: '\\#', percent: '\\%', backslash: '\\backslash',
  aleph: '\\aleph', NN: '\\mathbb{N}', ZZ: '\\mathbb{Z}', QQ: '\\mathbb{Q}', RR: '\\mathbb{R}', CC: '\\mathbb{C}', BB: '\\mathbb{B}',
  // spacing
  quad: '\\quad', wide: '\\qquad', space: '\\ ', 'space.nobreak': '~', med: '\\:', thin: '\\,', thick: '\\;', 'space.thin': '\\,', 'space.med': '\\:', 'space.quad': '\\quad',
  // functions written as operators
  sin: '\\sin', cos: '\\cos', tan: '\\tan', log: '\\log', ln: '\\ln', exp: '\\exp', lim: '\\lim', max: '\\max', min: '\\min', sup: '\\sup', inf: '\\inf', det: '\\det', dim: '\\dim', ker: '\\ker', gcd: '\\gcd', mod: '\\bmod',
};

const SHORT: Record<string, string> = {
  '::=': '::=', '|->': '\\mapsto', '...': '\\ldots', '->': '\\to', '<-': '\\leftarrow', '=>': '\\Rightarrow', '<=': '\\leq', '>=': '\\geq',
  '!=': '\\neq', ':=': '\\coloneqq', '==': '==', '=:': '\\eqqcolon', '~~': '\\approx', '<<': '\\ll', '>>': '\\gg', '|-': '\\vdash', '||': '\\|',
  '{': '\\{', '}': '\\}', '#': '\\#', '%': '\\%', '$': '\\$', '~': '\\sim', '*': '*', '&': '&',
};

const SPACES = new Set(['\\quad', '\\qquad', '\\ ', '~', '\\:', '\\,', '\\;']);
const FONT_FNS: Record<string, string> = {
  italic: '\\mathit', upright: '\\mathrm', bold: '\\mathbf', sans: '\\mathsf', mono: '\\mathtt', cal: '\\mathcal', bb: '\\mathbb', frak: '\\mathfrak', serif: '\\mathrm',
};
const ACCENTS: Record<string, string> = {
  hat: '\\hat', tilde: '\\tilde', bar: '\\bar', overline: '\\overline', underline: '\\underline', dot: '\\dot', 'dot.double': '\\ddot', ddot: '\\ddot',
  vec: '\\vec', arrow: '\\vec', breve: '\\breve', acute: '\\acute', grave: '\\grave', caron: '\\check', check: '\\check', cancel: '\\cancel', sqrt: '\\sqrt',
  overbracket: '\\overbrace', underbracket: '\\underbrace', widehat: '\\widehat', 'hat.wide': '\\widehat',
};

export interface MathResult { tex: string; warnings: string[] }

type Atom = { tex: string; cls: 'ord' | 'rel' | 'space' | 'open' | 'close' | 'punct' | 'break' | 'align'; text?: boolean; tight?: boolean };

class Conv {
  i = 0;
  warnings: string[] = [];
  constructor(private t: Tok[]) {}

  peek(o = 0) { return this.t[this.i + o]; }

  /** Parses a sequence until one of the stop ops at depth 0. */
  seq(stops: string[] = []): Atom[] {
    const out: Atom[] = [];
    let sawSpace = false;
    while (this.i < this.t.length) {
      const tk = this.peek();
      if (tk.k === 'op' && stops.includes(tk.v)) break;
      if (tk.k === 'ws') { this.i++; sawSpace = true; continue; }
      const a = this.attachable();
      if (!a) continue;
      // Typst puts a space between a text string and an ordinary atom written apart ("Mov" r),
      // but not between single letters.
      const prev = out[out.length - 1];
      if (sawSpace && prev && (prev.text || a.text) && (prev.cls === 'ord' || prev.cls === 'close') && (a.cls === 'ord' || a.cls === 'open')) {
        out.push({ tex: '\\ ', cls: 'space' });
      }
      // Keep |x| tight (no space after an opening or before a closing bar).
      if (prev && !sawSpace && (a.tex === '|' || prev.tex === '|')) prev.tight = true;
      out.push(a);
      sawSpace = false;
    }
    return out;
  }

  attachable(): Atom | null {
    const base = this.primary();
    if (!base) return null;
    let sub = '', sup = '', primes = '';
    for (;;) {
      const tk = this.peek();
      if (tk?.k === 'op' && tk.v === "'") { primes += "'"; this.i++; continue; }
      if (tk?.k === 'op' && (tk.v === '_' || tk.v === '^')) {
        this.i++;
        const arg = this.attachArg();
        if (tk.v === '_') sub = arg; else sup = arg;
        continue;
      }
      break;
    }
    if (!sub && !sup && !primes) return base;
    let tex = base.tex + primes;
    if (sub) tex += `_{${sub}}`;
    if (sup) tex += `^{${sup}}`;
    return { tex, cls: base.cls === 'rel' ? 'rel' : 'ord', text: base.text };
  }

  attachArg(): string {
    const tk = this.peek();
    if (!tk) return '';
    if (tk.k === 'op' && tk.v === '(') {
      this.i++;
      const inner = join(this.seq([')']));
      this.i++; // )
      return inner;
    }
    if (tk.k === 'num') { this.i++; return tk.v; }
    const a = this.primary();
    return a ? a.tex : '';
  }

  /** Arguments of a call: split at top-level commas (and `;` for rows). */
  callArgs(): Atom[][] {
    this.i++; // (
    const args: Atom[][] = [];
    for (;;) {
      const a = this.seq([',', ')', ';']);
      args.push(a);
      const tk = this.peek();
      if (!tk) break;
      this.i++;
      if (tk.k === 'op' && tk.v === ')') break;
    }
    // trailing comma
    if (args.length > 1 && args[args.length - 1].length === 0) args.pop();
    return args;
  }

  primary(): Atom | null {
    const tk = this.peek();
    if (!tk) return null;
    this.i++;
    switch (tk.k) {
      case 'str': return { tex: textCmd(tk.v), cls: 'ord', text: tk.v.length > 1 && !/^\s/.test(tk.v) };
      case 'letter': return { tex: tk.v, cls: 'ord' };
      case 'num': return { tex: tk.v, cls: 'ord' };
      case 'ws': return null;
      case 'ident': return this.ident(tk.v);
      case 'op': {
        const v = tk.v;
        if (v === '(' || v === '[') {
          const close = v === '(' ? ')' : ']';
          const inner = join(this.seq([close]));
          if (this.peek()) this.i++;
          return { tex: v + inner + close, cls: 'ord' };
        }
        if (v === '\\') return { tex: '\\\\', cls: 'break' };
        if (v === '&') return { tex: '&', cls: 'align' };
        if (v.startsWith('esc:')) {
          const c = v.slice(4);
          return { tex: '{}#$%&_'.includes(c) ? '\\' + c : c, cls: 'ord' };
        }
        if (v === ',' || v === ';') return { tex: v, cls: 'punct' };
        if (v === ')' || v === ']') return { tex: v, cls: 'close' };
        return { tex: SHORT[v] ?? v, cls: 'rel' };
      }
    }
  }

  ident(name: string): Atom {
    const next = this.peek();
    const isCall = next?.k === 'op' && next.v === '(';
    if (isCall) {
      if (FONT_FNS[name]) {
        const [a] = this.callArgs();
        const inner = a ? join(a) : '';
        // italic("write") → \mathit{write}
        const m = /^\\mathrm\{([^{}]*)\}$|^\\text\{([^{}]*)\}$/.exec(inner);
        return { tex: `${FONT_FNS[name]}{${m ? (m[1] ?? m[2]) : inner}}`, cls: 'ord', text: !!m };
      }
      if (ACCENTS[name]) {
        const [a] = this.callArgs();
        return { tex: `${ACCENTS[name]}{${a ? join(a) : ''}}`, cls: 'ord' };
      }
      switch (name) {
        case 'cases': {
          const rows = this.callArgs().map(join);
          return { tex: `\\begin{cases} ${rows.join(' \\\\ ')} \\end{cases}`, cls: 'ord' };
        }
        case 'underbrace': case 'overbrace': {
          const [a, b] = this.callArgs();
          const cmd = '\\' + name + `{${join(a ?? [])}}`;
          return { tex: b ? cmd + (name === 'underbrace' ? '_' : '^') + `{${join(b)}}` : cmd, cls: 'ord' };
        }
        case 'frac': { const [a, b] = this.callArgs(); return { tex: `\\frac{${join(a ?? [])}}{${join(b ?? [])}}`, cls: 'ord' }; }
        case 'binom': { const [a, b] = this.callArgs(); return { tex: `\\binom{${join(a ?? [])}}{${join(b ?? [])}}`, cls: 'ord' }; }
        case 'abs': { const [a] = this.callArgs(); return { tex: `|${join(a ?? [])}|`, cls: 'ord' }; }
        case 'norm': { const [a] = this.callArgs(); return { tex: `\\|${join(a ?? [])}\\|`, cls: 'ord' }; }
        case 'floor': { const [a] = this.callArgs(); return { tex: `\\lfloor ${join(a ?? [])} \\rfloor`, cls: 'ord' }; }
        case 'ceil': { const [a] = this.callArgs(); return { tex: `\\lceil ${join(a ?? [])} \\rceil`, cls: 'ord' }; }
        case 'lr': case 'display': case 'inline': case 'script': case 'limits': case 'scripts': { const [a] = this.callArgs(); return { tex: join(a ?? []), cls: 'ord' }; }
        case 'op': {
          const [a] = this.callArgs();
          const inner = join(a ?? []).replace(/^\\(?:mathrm|text)\{([^{}]*)\}$/, '$1');
          return { tex: `\\operatorname{${inner}}`, cls: 'ord' };
        }
        case 'text': {
          const [a] = this.callArgs();
          return { tex: join(a ?? []), cls: 'ord' };
        }
        case 'vec': case 'mat': {
          const args = this.callArgs();
          return { tex: `\\begin{pmatrix} ${args.map(join).join(' \\\\ ')} \\end{pmatrix}`, cls: 'ord' };
        }
      }
      // A symbol followed by parentheses is just the symbol applied (Typst prints it that way).
      if (SYM[name]) return { tex: SYM[name], cls: symClass(SYM[name]) };
      this.warnings.push(`Unknown Typst function ${name}(…), kept as text`);
      return { tex: `\\mathrm{${name}}`, cls: 'ord' };
    }
    if (SYM[name] !== undefined) return { tex: SYM[name], cls: symClass(SYM[name]) };
    // An unknown multi-letter identifier: keep it as an italic name.
    const base = name.split('.')[0];
    if (name.includes('.')) this.warnings.push(`Unknown Typst symbol ${name}`);
    return { tex: `\\mathit{${base}}`, cls: 'ord' };
  }
}

function symClass(tex: string): Atom['cls'] {
  if (SPACES.has(tex)) return 'space';
  if (/^\\(langle|lfloor|lceil|llbracket|\{)/.test(tex)) return 'open';
  if (/^\\(rangle|rfloor|rceil|rrbracket|\})/.test(tex)) return 'close';
  if (/^\\(mathrm\{[A-Z]\}|alpha|beta|gamma|delta|varepsilon|epsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|varsigma|tau|upsilon|varphi|phi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega|ell|emptyset|varnothing|top|bot|infty|dots|ldots|cdots|square|mathbb)/.test(tex) || /^[A-Za-z]$/.test(tex)) return 'ord';
  return 'rel';
}

function textCmd(s: string): string {
  if (s === '') return '{}';
  if (/^[A-Za-z][A-Za-z0-9]*$/.test(s)) return `\\mathrm{${s}}`;
  return `\\text{${s.replace(/[\\{}$&#%_^~]/g, (c) => (c === '\\' ? '\\textbackslash{}' : c === '~' ? '\\textasciitilde{}' : c === '^' ? '\\textasciicircum{}' : '\\' + c))}}`;
}

function join(atoms: Atom[]): string {
  // Spaces are insignificant in LaTeX math, so atoms are simply space-separated
  // (which also keeps control words from running into the next letter).
  let s = '';
  let prevTight = false;
  for (const a of atoms) {
    if (s && a.cls !== 'punct' && !prevTight) s += ' ';
    s += a.tex;
    prevTight = !!a.tight;
  }
  return s.trim();
}

/** Converts one Typst math body (without the surrounding $) to LaTeX math. */
export function typstMathToTex(src: string): MathResult {
  const c = new Conv(tokenize(src));
  const atoms = c.seq();
  let tex = join(atoms);
  if (atoms.some((a) => a.cls === 'break' || a.cls === 'align')) {
    tex = `\\begin{aligned} ${tex} \\end{aligned}`;
  }
  return { tex, warnings: c.warnings };
}

/** Splits Typst math at top-level occurrences of `sep` (outside (), [], {} and strings). */
export function splitTopLevel(src: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0, inStr = false, start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '\\') { i++; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && src.startsWith(sep, i)) {
      // `|` must not be part of `|->` or `||`
      if (sep === '|' && (src[i + 1] === '-' || src[i + 1] === '|' || src[i - 1] === '|')) continue;
      parts.push(src.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}
