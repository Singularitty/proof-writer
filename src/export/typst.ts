import type { Block, Doc, ProofNode, Rule } from '../model/types';
import { THEOREM_LABEL } from '../model/types';
import { expandMacros } from '../latex/macros';
import { escapeMarkup, texToTypst } from '../latex/toTypst';
import { makeCtx, sanitizeLabel, type ExportCtx } from './context';
import { expandTextSnippets, parseProse, type Inline } from './prose';

export const TYPST_PREAMBLE = String.raw`// ---- proof-writer support code ----
#let pw-rule(name: none, side: none, premises: (), conclusion) = context {
  let prem = if premises.len() == 0 { none } else {
    grid(columns: premises.len(), column-gutter: 1.6em, align: bottom, ..premises)
  }
  let pw = if prem == none { 0pt } else { measure(prem).width }
  let cw = measure(conclusion).width
  let w = calc.max(pw, cw) + 0.3em
  let label = {
    if name != none { text(size: 0.85em, smallcaps(name)) }
    if side != none { h(0.4em); side }
  }
  let lw = measure(label).width
  box(grid(
    columns: (w, lw),
    column-gutter: 0.3em,
    row-gutter: 0.22em,
    align(center + bottom, if prem == none { [] } else { prem }), [],
    line(length: w, stroke: 0.45pt),
    box(width: lw, height: 0pt, place(left + horizon, label)),
    align(center, conclusion), [],
  ))
}
#let pw-leaf(conclusion) = box(conclusion)
#let pw-elided(conclusion) = box(grid(align: center, row-gutter: 0.3em, $dots.v$, conclusion))
#let pw-rules(judgment: none, ..rules) = block(width: 100%, above: 1.2em, below: 1.2em, {
  if judgment != none { block(below: 0.8em, box(stroke: 0.45pt, inset: 4pt, judgment)) }
  set par(leading: 1.8em, justify: false)
  align(center, rules.pos().join(h(2.5em)))
})
#let pw-grammar(rows) = block(above: 1em, below: 1em, align(center, grid(
  columns: 4,
  column-gutter: 0.7em,
  row-gutter: 0.8em,
  align: (left, right, center, left),
  ..rows.map(r => (text(style: "italic", r.at(0)), r.at(1), $::=$, r.at(2).join($quad | quad$))).flatten()
)))
#let pw-thm(kind, supplement, title: none, body) = figure(
  kind: kind, supplement: supplement, caption: title, outlined: false, numbering: "1", body,
)
#let pw-thm-show(it) = block(width: 100%, above: 1.2em, below: 1.2em, breakable: true, align(left, {
  strong[#it.supplement #it.counter.display(it.numbering)]
  if it.caption != none [ (#it.caption.body)]
  [. ]
  it.body
}))
#show figure.where(kind: "thm"): pw-thm-show
#show figure.where(kind: "theorem"): pw-thm-show
#show figure.where(kind: "lemma"): pw-thm-show
#show figure.where(kind: "corollary"): pw-thm-show
#show figure.where(kind: "proposition"): pw-thm-show
#show figure.where(kind: "definition"): pw-thm-show
#show figure.where(kind: "conjecture"): pw-thm-show
#let pw-proof(body) = block(width: 100%, above: 0.8em, below: 1.2em, breakable: true, {
  emph[Proof.] + [ ] + body + h(1fr) + $square$
})
#let pw-case(title, body) = block(width: 100%, above: 0.8em, breakable: true, {
  [*Case* #title.]
  block(above: 0.5em, inset: (left: 1.2em), breakable: true, body)
})
// ---- end of support code ----
`;

export interface TypstExport {
  source: string;
  warnings: string[];
}

export function exportTypst(doc: Doc): TypstExport {
  const ctx = makeCtx(doc);
  const out: string[] = [];
  const s = doc.settings;
  out.push(`#set document(title: ${str(doc.title)}${doc.author ? `, author: ${str(doc.author)}` : ''})`);
  out.push(`#set page(paper: ${str(s.paper)}, margin: 2.5cm, numbering: "1")`);
  out.push(`#set text(font: "New Computer Modern", size: ${s.fontSize}pt)`);
  out.push(`#show math.equation: set text(font: "New Computer Modern Math")`);
  out.push(`#set par(justify: true)`);
  out.push(`#set heading(numbering: "1.1")`);
  out.push('');
  out.push(TYPST_PREAMBLE);
  if (doc.title) {
    out.push(`#align(center)[#text(size: 1.6em, weight: "bold")[${escapeMarkup(doc.title)}]${doc.author ? ` \\ #v(0.3em) ${escapeMarkup(doc.author)}` : ''}]`);
    out.push('#v(1em)');
    out.push('');
  }
  out.push(blocks(doc.blocks, ctx));
  return { source: out.join('\n'), warnings: ctx.warnings };
}

function str(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function mathTypst(src: string, ctx: ExportCtx): string {
  const expanded = expandMacros(src, ctx.macros);
  const r = texToTypst(expanded);
  ctx.warnings.push(...r.warnings.map((w) => `${w} in "${src}"`));
  return r.code;
}

/** `$...$` content block for a LaTeX math string. */
function m(src: string, ctx: ExportCtx): string {
  const code = mathTypst(src, ctx);
  return code ? `$${code}$` : '[]';
}

function blocks(bs: Block[], ctx: ExportCtx): string {
  return bs.map((b) => block(b, ctx)).filter(Boolean).join('\n\n');
}

function block(b: Block, ctx: ExportCtx): string {
  switch (b.type) {
    case 'heading':
      return '='.repeat(b.level) + ' ' + inlineText(b.text, ctx);
    case 'text':
      return prose(b.text, ctx);
    case 'grammar': {
      const rows = b.rows.map(
        (r) => `  ([${escapeMarkup(r.category)}], ${m(r.metavar, ctx)}, (${r.alternatives.map((a) => m(a, ctx)).join(', ')}${r.alternatives.length === 1 ? ',' : ''})),`,
      );
      const title = b.title ? `*${escapeMarkup(b.title)}*\n` : '';
      return `${title}#pw-grammar((\n${rows.join('\n')}\n))`;
    }
    case 'rules': {
      const title = b.title ? `*${escapeMarkup(b.title)}*\n` : '';
      const j = b.judgment ? `judgment: ${m(b.judgment, ctx)},\n  ` : '';
      return `${title}#pw-rules(\n  ${j}${b.rules.map((r) => rule(r, ctx)).join(',\n  ')}${b.rules.length ? ',' : ''}\n)`;
    }
    case 'derivation': {
      const cap = b.caption ? `\n#align(center, text(size: 0.9em)[${inlineText(b.caption, ctx)}])` : '';
      return `#align(center, block(above: 1.2em, below: 1.2em, ${tree(b.root, ctx, 1)}))${cap}`;
    }
    case 'theorem': {
      const sup = THEOREM_LABEL[b.kind];
      const kind = ctx.doc.settings.numberTheorems === 'shared' ? 'thm' : b.kind;
      const title = b.title ? `, title: [${inlineText(b.title, ctx)}]` : '';
      const stmt = prose(b.statement, ctx);
      const body = b.kind === 'definition' ? stmt : `#emph[${stmt}]`;
      const label = b.label ? ` <${sanitizeLabel(b.label)}>` : '';
      let s = `#pw-thm(${str(kind)}, [${sup}]${title})[\n${body}\n]${label}`;
      if (b.proof && b.proof.length) s += `\n#pw-proof[\n${blocks(b.proof, ctx)}\n]`;
      return s;
    }
    case 'cases': {
      const intro = b.intro ? prose(b.intro, ctx) + '\n' : '';
      return intro + b.cases.map((c) => `#pw-case[${inlineText(c.title, ctx)}][\n${blocks(c.body, ctx)}\n]`).join('\n');
    }
    case 'raw':
      return b.typst;
  }
}

export function rule(r: Rule, ctx: ExportCtx): string {
  const args: string[] = [];
  if (r.name) args.push(`name: [${escapeMarkup(r.name)}]`);
  if (r.side) args.push(`side: ${m(r.side, ctx)}`);
  const prem = r.premises.filter((p) => p.trim());
  args.push(`premises: (${prem.map((p) => m(p, ctx)).join(', ')}${prem.length === 1 ? ',' : ''})`);
  args.push(m(r.conclusion, ctx));
  return `pw-rule(${args.join(', ')})`;
}

function tree(n: ProofNode, ctx: ExportCtx, depth: number): string {
  const concl = m(n.judgment, ctx);
  if (n.elided) return `pw-elided(${concl})`;
  if ((n.leaf || !n.rule) && n.children.length === 0) return `pw-leaf(${concl})`;
  const pad = '  '.repeat(depth);
  const args: string[] = [];
  if (n.rule) args.push(`name: [${escapeMarkup(n.rule)}]`);
  const kids = n.children.map((c) => tree(c, ctx, depth + 1));
  args.push(`premises: (${kids.length ? `\n${pad}  ` + kids.join(`,\n${pad}  `) + (kids.length === 1 ? ',' : '') + `\n${pad}` : ''})`);
  args.push(concl);
  return `pw-rule(${args.join(', ')})`;
}

// ---------- prose ----------

function prose(src: string, ctx: ExportCtx): string {
  const pb = parseProse(expandTextSnippets(src, ctx.textSnippets));
  return pb
    .map((b) => {
      switch (b.k) {
        case 'p': return inl(b.c, ctx);
        case 'ul': return b.items.map((it) => '- ' + inl(it, ctx)).join('\n');
        case 'ol': return b.items.map((it) => '+ ' + inl(it, ctx)).join('\n');
        case 'dmath': return `$ ${mathTypst(b.v, ctx)} $`;
      }
    })
    .join('\n\n');
}

function inlineText(src: string, ctx: ExportCtx): string {
  const pb = parseProse(expandTextSnippets(src, ctx.textSnippets));
  return pb.map((b) => (b.k === 'p' ? inl(b.c, ctx) : b.k === 'dmath' ? `$${mathTypst(b.v, ctx)}$` : '')).join(' ');
}

function inl(xs: Inline[], ctx: ExportCtx): string {
  return xs
    .map((x) => {
      switch (x.k) {
        case 'text': return escapeMarkup(x.v).replace(/^([-+=])/, '\\$1');
        case 'math': return m(x.v, ctx);
        case 'b': return `#strong[${inl(x.c, ctx)}]`;
        case 'i': return `#emph[${inl(x.c, ctx)}]`;
        case 'code': return '`' + x.v.replace(/`/g, '') + '`';
        case 'ref': {
          const lbl = sanitizeLabel(x.v);
          if (ctx.labels.has(lbl)) return `#ref(<${lbl}>)`;
          if (ctx.ruleNames.has(x.v)) return `#smallcaps[${escapeMarkup(x.v)}]`;
          ctx.warnings.push(`Unknown reference [[${x.v}]]`);
          return `#text(fill: red)[\\[\\[${escapeMarkup(x.v)}\\]\\]]`;
        }
      }
    })
    .join('');
}
