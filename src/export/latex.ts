import type { Block, Doc, ProofNode, Rule, TheoremKind } from '../model/types';
import { THEOREM_LABEL } from '../model/types';
import { makeCtx, sanitizeLabel, type ExportCtx } from './context';
import { expandTextSnippets, parseProse, type Inline } from './prose';

export interface LatexExport {
  source: string;
  warnings: string[];
}

const KINDS: TheoremKind[] = ['theorem', 'lemma', 'corollary', 'proposition', 'definition', 'conjecture'];

export function exportLatex(doc: Doc): LatexExport {
  const ctx = makeCtx(doc);
  const s = doc.settings;
  const out: string[] = [];
  out.push(`\\documentclass[${s.fontSize}pt,${s.paper === 'a4' ? 'a4paper' : 'letterpaper'}]{article}`);
  out.push('\\usepackage[margin=2.5cm]{geometry}');
  out.push('\\usepackage{amsmath,amssymb,amsthm}');
  out.push('\\usepackage{stmaryrd}');
  out.push('\\usepackage{mathpartir}');
  out.push('\\usepackage{hyperref}');
  out.push('\\usepackage[capitalise,nameinlink]{cleveref}');
  out.push('');
  out.push('\\theoremstyle{plain}');
  if (s.numberTheorems === 'shared') {
    out.push('\\newtheorem{theorem}{Theorem}');
    for (const k of KINDS) if (k !== 'theorem' && k !== 'definition') out.push(`\\newtheorem{${k}}[theorem]{${THEOREM_LABEL[k]}}`);
    out.push('\\theoremstyle{definition}');
    out.push('\\newtheorem{definition}[theorem]{Definition}');
  } else {
    for (const k of KINDS) if (k !== 'definition') out.push(`\\newtheorem{${k}}{${THEOREM_LABEL[k]}}`);
    out.push('\\theoremstyle{definition}');
    out.push('\\newtheorem{definition}{Definition}');
  }
  out.push('');
  const macros = doc.snippets.filter((x) => x.kind === 'math' && x.name);
  if (macros.length) {
    out.push('% snippets');
    for (const mac of macros) {
      const arity = mac.arity > 0 ? `[${mac.arity}]` : '';
      out.push(`\\providecommand{\\${mac.name}}{}\\renewcommand{\\${mac.name}}${arity}{${mac.body}}`);
    }
    out.push('');
  }
  if (doc.title) out.push(`\\title{${text(doc.title)}}`);
  if (doc.author) out.push(`\\author{${text(doc.author)}}`);
  out.push('\\date{}');
  out.push('');
  out.push('\\begin{document}');
  if (doc.title) out.push('\\maketitle');
  out.push('');
  out.push(blocks(doc.blocks, ctx));
  out.push('');
  out.push('\\end{document}');
  return { source: out.join('\n'), warnings: ctx.warnings };
}

const GREEK = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho varsigma sigma tau upsilon phi chi psi omega'.split(' ');
const UNICODE_TEXT: Record<string, string> = {
  '→': '\\ensuremath{\\to}', '←': '\\ensuremath{\\leftarrow}', '⇒': '\\ensuremath{\\Rightarrow}', '⊢': '\\ensuremath{\\vdash}',
  '∀': '\\ensuremath{\\forall}', '∃': '\\ensuremath{\\exists}', '∈': '\\ensuremath{\\in}', '≤': '\\ensuremath{\\leq}',
  '≥': '\\ensuremath{\\geq}', '≠': '\\ensuremath{\\neq}', '⟦': '\\ensuremath{\\llbracket}', '⟧': '\\ensuremath{\\rrbracket}',
  '…': '\\ldots{}', '–': '--', '—': '---',
};
GREEK.forEach((g, i) => {
  if (g === 'omicron') return;
  UNICODE_TEXT[String.fromCodePoint(0x3b1 + i)] = `\\ensuremath{\\${g}}`;
  const cap = g[0].toUpperCase() + g.slice(1);
  if (['Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega'].includes(cap)) UNICODE_TEXT[String.fromCodePoint(0x391 + i)] = `\\ensuremath{\\${cap}}`;
});

/** Escape plain text for LaTeX text mode. */
export function text(s: string): string {
  return s.replace(/[\\{}$&#^_%~\u0370-\u03ff→←⇒⊢∀∃∈≤≥≠⟦⟧…–—]/g, (c) => {
    if (c in UNICODE_TEXT) return UNICODE_TEXT[c];
    switch (c) {
      case '\\': return '\\textbackslash{}';
      case '~': return '\\textasciitilde{}';
      case '^': return '\\textasciicircum{}';
      default: return c.charCodeAt(0) > 127 ? c : '\\' + c;
    }
  });
}

function blocks(bs: Block[], ctx: ExportCtx): string {
  return bs.map((b) => block(b, ctx)).filter(Boolean).join('\n\n');
}

function block(b: Block, ctx: ExportCtx): string {
  switch (b.type) {
    case 'heading': {
      const cmd = ['section', 'subsection', 'subsubsection'][b.level - 1];
      return `\\${cmd}{${inlineText(b.text, ctx)}}`;
    }
    case 'text':
      return prose(b.text, ctx);
    case 'grammar': {
      const title = b.title ? `\\paragraph{${text(b.title)}}\n` : '';
      const rows = b.rows.map(
        (r) => `  \\text{${text(r.category)}} & ${r.metavar} & ::= & ${r.alternatives.join(' \\mid ')} \\\\`,
      );
      return `${title}\\[\n\\begin{array}{lrcl}\n${rows.join('\n')}\n\\end{array}\n\\]`;
    }
    case 'rules': {
      const title = b.title ? `\\paragraph{${text(b.title)}}\n` : '';
      const j = b.judgment ? `\\fbox{$${b.judgment}$}\n` : '';
      return `${title}${j}\\begin{mathpar}\n${b.rules.map((r) => rule(r)).join('\n\\and\n')}\n\\end{mathpar}`;
    }
    case 'derivation': {
      const cap = b.caption ? `\n\\begin{center}\\small ${inlineText(b.caption, ctx)}\\end{center}` : '';
      return `\\begin{mathpar}\n${tree(b.root, 0)}\n\\end{mathpar}${cap}`;
    }
    case 'theorem': {
      const title = b.title ? `[${inlineText(b.title, ctx)}]` : '';
      const label = b.label ? `\\label{${sanitizeLabel(b.label)}}` : '';
      let s = `\\begin{${b.kind}}${title}${label}\n${prose(b.statement, ctx)}\n\\end{${b.kind}}`;
      if (b.proof && b.proof.length) s += `\n\\begin{proof}\n${blocks(b.proof, ctx)}\n\\end{proof}`;
      return s;
    }
    case 'cases': {
      const intro = b.intro ? prose(b.intro, ctx) + '\n' : '';
      if (!b.cases.length) return intro;
      return intro + `\\begin{description}\n${b.cases
        .map((c) => `\\item[Case ${inlineText(c.title, ctx)}.]\n${blocks(c.body, ctx)}`)
        .join('\n')}\n\\end{description}`;
    }
    case 'raw':
      return b.latex;
  }
}

function ruleName(name?: string): string {
  return name ? `[right=${braceIfNeeded(text(name))}]` : '';
}

function braceIfNeeded(s: string): string {
  return /[,=\]]/.test(s) ? `{${s}}` : s;
}

export function rule(r: Rule): string {
  const prem = r.premises.filter((p) => p.trim());
  const core = `\\inferrule*${ruleName(r.name)}\n  {${prem.length ? prem.join(' \\\\ ') : '~'}}\n  {${r.conclusion}}`;
  return r.side ? `${core}\n  \\quad ${r.side}` : core;
}

function tree(n: ProofNode, depth: number): string {
  const pad = '  '.repeat(depth);
  if (n.elided) return `\\begin{array}{c}\\vdots \\\\ ${n.judgment}\\end{array}`;
  if ((n.leaf || !n.rule) && n.children.length === 0) return n.judgment;
  const kids = n.children.map((c) => tree(c, depth + 1));
  const prem = kids.length ? `\n${pad}  ` + kids.join(` \\\\\n${pad}  `) + `\n${pad}` : '~';
  return `\\inferrule*${ruleName(n.rule)}\n${pad}{${prem}}\n${pad}{${n.judgment}}`;
}

// ---------- prose ----------

function prose(src: string, ctx: ExportCtx): string {
  const pb = parseProse(expandTextSnippets(src, ctx.textSnippets));
  return pb
    .map((b) => {
      switch (b.k) {
        case 'p': return inl(b.c, ctx);
        case 'ul': return `\\begin{itemize}\n${b.items.map((it) => '  \\item ' + inl(it, ctx)).join('\n')}\n\\end{itemize}`;
        case 'ol': return `\\begin{enumerate}\n${b.items.map((it) => '  \\item ' + inl(it, ctx)).join('\n')}\n\\end{enumerate}`;
        case 'dmath': return `\\[\n${b.v}\n\\]`;
      }
    })
    .join('\n\n');
}

function inlineText(src: string, ctx: ExportCtx): string {
  const pb = parseProse(expandTextSnippets(src, ctx.textSnippets));
  return pb.map((b) => (b.k === 'p' ? inl(b.c, ctx) : b.k === 'dmath' ? `$${b.v}$` : '')).join(' ');
}

function inl(xs: Inline[], ctx: ExportCtx): string {
  return xs
    .map((x) => {
      switch (x.k) {
        case 'text': return text(x.v);
        case 'math': return `$${x.v}$`;
        case 'b': return `\\textbf{${inl(x.c, ctx)}}`;
        case 'i': return `\\emph{${inl(x.c, ctx)}}`;
        case 'code': return `\\texttt{${text(x.v)}}`;
        case 'ref': {
          const lbl = sanitizeLabel(x.v);
          if (ctx.labels.has(lbl)) return `\\Cref{${lbl}}`;
          if (ctx.ruleNames.has(x.v)) return `\\textsc{${text(x.v)}}`;
          return `\\textbf{??${text(x.v)}}`;
        }
      }
    })
    .join('');
}
