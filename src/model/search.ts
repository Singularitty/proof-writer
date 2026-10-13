// Finding and replacing text in the document's own fields: what was written, not how it is drawn.

import type { Block, Id, ProofNode } from './types';

export interface FindOptions { matchCase?: boolean }

export interface Hit {
  /** The innermost block holding the field. */
  block: Id;
  /** Which field, counting the document's fields in order. */
  field: number;
  /** The field's text when it was searched. */
  text: string;
  start: number;
  end: number;
}

type Visit = (block: Id, text: string, set: (v: string) => void) => void;

/** Visits every text field of the blocks in document order. `set` writes the field, so the blocks must be a draft to use it. */
export function walkFields(blocks: Block[], visit: Visit): void {
  for (const b of blocks) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = (o: any, k: string | number) => { if (typeof o[k] === 'string') visit(b.id, o[k], (v) => { o[k] = v; }); };
    const all = (list: string[]) => list.forEach((_, i) => f(list, i));
    const node = (n: ProofNode) => { f(n, 'judgment'); f(n, 'rule'); n.children.forEach(node); };
    switch (b.type) {
      case 'heading': case 'text': f(b, 'text'); break;
      case 'grammar':
        f(b, 'title');
        for (const r of b.rows) { f(r, 'category'); f(r, 'metavar'); all(r.alternatives); }
        break;
      case 'rules':
        f(b, 'title'); f(b, 'judgment');
        for (const r of b.rules) { f(r, 'name'); all(r.premises); f(r, 'conclusion'); f(r, 'side'); }
        break;
      case 'derivation': f(b, 'caption'); node(b.root); break;
      case 'theorem':
        f(b, 'title'); f(b, 'label'); f(b, 'statement');
        if (b.proof) walkFields(b.proof, visit);
        break;
      case 'cases':
        f(b, 'intro');
        for (const c of b.cases) { f(c, 'title'); walkFields(c.body, visit); }
        break;
      case 'raw': f(b, 'typst'); f(b, 'latex'); break;
    }
  }
}

/** A pattern matching `query` as written, with nothing in it read as a pattern. */
export function literal(query: string, matchCase?: boolean): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'gu' : 'giu');
}

/** Every place `query` occurs, in document order. */
export function findInDoc(blocks: Block[], query: string, opts: FindOptions = {}): Hit[] {
  if (!query) return [];
  const re = literal(query, opts.matchCase);
  const hits: Hit[] = [];
  let field = 0;
  walkFields(blocks, (block, text) => {
    for (const m of text.matchAll(re)) hits.push({ block, field, text, start: m.index, end: m.index + m[0].length });
    field++;
  });
  return hits;
}

/** Replaces one hit in a draft of the blocks it was found in. False if the field no longer reads as it did. */
export function replaceHit(blocks: Block[], hit: Hit, replacement: string): boolean {
  let field = 0;
  let done = false;
  walkFields(blocks, (_, text, set) => {
    if (field++ !== hit.field || text !== hit.text) return;
    set(text.slice(0, hit.start) + replacement + text.slice(hit.end));
    done = true;
  });
  return done;
}

/** Replaces every occurrence in a draft of the blocks, and says how many there were. */
export function replaceAll(blocks: Block[], query: string, replacement: string, opts: FindOptions = {}): number {
  if (!query) return 0;
  const re = literal(query, opts.matchCase);
  let n = 0;
  walkFields(blocks, (_, text, set) => {
    const next = text.replace(re, () => { n++; return replacement; });
    if (next !== text) set(next);
  });
  return n;
}

/** The theorems whose collapsed proof hides the block `id`, outermost first. */
export function collapsedAround(blocks: Block[], id: Id): Id[] {
  const path = (list: Block[]): Id[] | null => {
    for (const b of list) {
      if (b.id === id) return [];
      const inner = b.type === 'theorem' ? (b.proof ? [b.proof] : []) : b.type === 'cases' ? b.cases.map((c) => c.body) : [];
      for (const l of inner) {
        const p = path(l);
        if (p) return b.type === 'theorem' && b.collapsed && b.kind !== 'definition' ? [b.id, ...p] : p;
      }
    }
    return null;
  };
  return path(blocks) ?? [];
}
