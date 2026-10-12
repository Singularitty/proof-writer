// The document as an agent reads it: Markdown with the math left in LaTeX and
// the id of every block, rule, grammar row and case shown, since those ids
// are how a job says which part of the document it means.

import type { Block, Doc, ProofNode } from '../model/types';
import { THEOREM_LABEL } from '../model/types';

function tree(n: ProofNode, depth: number, out: string[]) {
  const rule = n.rule ? ` [${n.rule}]` : n.leaf ? ' [assumption]' : n.elided ? ' [derivation elided]' : '';
  out.push(`${'  '.repeat(depth)}- $${n.judgment}$${rule}`);
  for (const c of n.children) tree(c, depth + 1, out);
}

export function docMarkdown(doc: Doc): string {
  const out: string[] = [`# ${doc.title || 'Untitled'}`, ''];
  const math = doc.snippets.filter((s) => s.kind === 'math' && s.name);
  const text = doc.snippets.filter((s) => s.kind === 'text' && s.name);
  if (math.length) {
    out.push('## Math macros', '', 'Math below is LaTeX and uses these macros.', '');
    for (const s of math) out.push(`- \`\\${s.name}\` (${s.arity} argument${s.arity === 1 ? '' : 's'}): \`${s.body}\`${s.description ? ` (${s.description})` : ''}`);
    out.push('');
  }
  if (text.length) {
    out.push('## Text snippets', '', 'Written `{{name}}` in prose.', '');
    for (const s of text) out.push(`- \`{{${s.name}}}\`: ${s.body}`);
    out.push('');
  }

  const counters = new Map<string, number>();
  const number = (kind: keyof typeof THEOREM_LABEL) => {
    const key = doc.settings.numberTheorems === 'shared' ? 'thm' : kind;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return `${THEOREM_LABEL[kind]} ${n}`;
  };

  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      switch (b.type) {
        case 'heading': out.push(`${'#'.repeat(b.level + 1)} ${b.text}`, ''); break;
        case 'text': out.push(`(text block \`${b.id}\`)`, '', b.text, ''); break;
        case 'grammar':
          out.push(`**Grammar${b.title ? `: ${b.title}` : ''}** (block \`${b.id}\`)`, '');
          for (const r of b.rows) out.push(`- ${r.category || '(no category)'}, row \`${r.id}\`: $${r.metavar}$ ::= ${r.alternatives.map((a) => `$${a}$`).join(' | ')}`);
          out.push('');
          break;
        case 'rules':
          out.push(`**Rules${b.title ? `: ${b.title}` : ''}** (block \`${b.id}\`)${b.judgment ? `, judgment form $${b.judgment}$` : ''}`, '');
          for (const r of b.rules) {
            out.push(`- Rule ${r.name || '(unnamed)'} (rule \`${r.id}\`)`);
            r.premises.forEach((p, i) => out.push(`  - premise ${i}: $${p}$`));
            out.push(`  - conclusion: $${r.conclusion}$`);
            if (r.side) out.push(`  - side condition: $${r.side}$`);
          }
          out.push('');
          break;
        case 'derivation': {
          out.push(`**Proof tree** (block \`${b.id}\`)${b.caption ? `: ${b.caption}` : ''}`, '');
          tree(b.root, 0, out);
          out.push('');
          break;
        }
        case 'theorem': {
          const name = number(b.kind);
          out.push(`**${name}${b.title ? ` (${b.title})` : ''}** (block \`${b.id}\`${b.label ? `, label \`${b.label}\`` : ''})`, '', b.statement, '');
          if (b.proof?.length) {
            out.push(b.kind === 'definition' ? '*Part of this definition:*' : '*Proof.*', '');
            walk(b.proof);
            out.push(b.kind === 'definition' ? `*End of ${name}.*` : `*End of the proof of ${name}.*`, '');
          }
          break;
        }
        case 'cases':
          out.push(`(case analysis \`${b.id}\`) ${b.intro}`, '');
          for (const c of b.cases) {
            out.push(`*${c.title || 'Case'}* (case \`${c.id}\`)`, '');
            walk(c.body);
          }
          out.push(`(end of case analysis \`${b.id}\`)`, '');
          break;
        case 'raw': out.push(`(raw Typst/LaTeX block \`${b.id}\`, not shown)`, ''); break;
      }
    }
  };
  walk(doc.blocks);
  return out.join('\n');
}
