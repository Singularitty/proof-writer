import type { Block, Doc, TheoremKind } from '../model/types';
import type { MacroDef } from '../latex/macros';

export interface ExportCtx {
  doc: Doc;
  macros: Map<string, MacroDef>;
  textSnippets: Map<string, string>;
  /** theorem label -> kind */
  labels: Map<string, TheoremKind>;
  ruleNames: Set<string>;
  warnings: string[];
}

export function sanitizeLabel(s: string): string {
  return s.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_:.-]/g, '');
}

export function walkBlocks(blocks: Block[], f: (b: Block) => void) {
  for (const b of blocks) {
    f(b);
    if (b.type === 'theorem' && b.proof) walkBlocks(b.proof, f);
    if (b.type === 'cases') for (const c of b.cases) walkBlocks(c.body, f);
  }
}

export function makeCtx(doc: Doc): ExportCtx {
  const macros = new Map<string, MacroDef>();
  const textSnippets = new Map<string, string>();
  for (const s of doc.snippets) {
    if (!s.name) continue;
    if (s.kind === 'math') macros.set(s.name, { name: s.name, arity: s.arity, body: s.body });
    else textSnippets.set(s.name, s.body);
  }
  const labels = new Map<string, TheoremKind>();
  const ruleNames = new Set<string>();
  walkBlocks(doc.blocks, (b) => {
    if (b.type === 'theorem' && b.label) labels.set(sanitizeLabel(b.label), b.kind);
    if (b.type === 'rules') for (const r of b.rules) if (r.name) ruleNames.add(r.name);
  });
  return { doc, macros, textSnippets, labels, ruleNames, warnings: [] };
}
