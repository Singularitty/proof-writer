import type { Doc, ProofNode, Rule } from './types';
import { uid } from './util';
import { walkBlocks } from '../export/context';
import { instantiate, matchJudgment, metavars } from '../latex/match';
import { expandMacros, type MacroDef } from '../latex/macros';

export function newNode(judgment = ''): ProofNode {
  return { id: uid(), judgment, children: [] };
}

export function findNode(root: ProofNode, id: string): { node: ProofNode; parent: ProofNode | null; index: number } | null {
  if (root.id === id) return { node: root, parent: null, index: -1 };
  const stack: ProofNode[] = [root];
  while (stack.length) {
    const p = stack.pop()!;
    for (let i = 0; i < p.children.length; i++) {
      const c = p.children[i];
      if (c.id === id) return { node: c, parent: p, index: i };
      stack.push(c);
    }
  }
  return null;
}

export function allRules(doc: Doc): { rule: Rule; group: string }[] {
  const out: { rule: Rule; group: string }[] = [];
  walkBlocks(doc.blocks, (b) => {
    if (b.type === 'rules') for (const r of b.rules) out.push({ rule: r, group: b.title || b.judgment || 'Rules' });
  });
  return out;
}

export function docMacros(doc: Doc): MacroDef[] {
  return doc.snippets.filter((s) => s.kind === 'math' && s.name).map((s) => ({ name: s.name, arity: s.arity, body: s.body }));
}

export interface RuleApplication {
  judgment: string;
  premises: string[];
  matched: boolean;
  /** Unknowns of the tree determined by this application. */
  solved: Map<string, string>;
  /** New unknowns introduced (premise variables not fixed by the conclusion). */
  fresh: string[];
}

export function treeMetavars(root: ProofNode): Set<string> {
  const out = new Set<string>();
  const walk = (n: ProofNode) => { metavars(n.judgment).forEach((m) => out.add(m)); n.children.forEach(walk); };
  walk(root);
  return out;
}

function freshName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  const m = /^(\\?[A-Za-z]+)/.exec(name);
  const base = m ? m[1] : name;
  for (let i = 1; i < 100; i++) {
    const cand = `${base}_{${i}}`;
    const cand2 = `${base}_${i}`;
    if (i < 10 && !used.has(cand2)) return cand2;
    if (i >= 10 && !used.has(cand)) return cand;
  }
  return name + "'";
}

/** Compute what applying `rule` to a node with judgment `judgment` yields. */
export function applyRule(rule: Rule, judgment: string, macros: MacroDef[], unknowns: string[] = [], used: Set<string> = new Set()): RuleApplication {
  const prem = [...rule.premises.filter((p) => p.trim()), ...(rule.side?.trim() ? [rule.side] : [])];
  const target = judgment.trim() ? judgment : rule.conclusion;
  const m = judgment.trim() ? matchJudgment(rule.conclusion, judgment, macros, unknowns) : { bindings: new Map<string, string>(), solved: new Map<string, string>(), expanded: false };
  if (!m) return { judgment, premises: prem, matched: false, solved: new Map(), fresh: [] };
  // premise variables that the conclusion does not determine become fresh unknowns
  const bindings = new Map(m.bindings);
  const fresh: string[] = [];
  const taken = new Set([...used, ...metavars(target)]);
  if (judgment.trim()) {
    for (const p of prem) {
      for (const v of metavars(m.expanded ? expandMacros(p, macros) : p)) {
        if (bindings.has(v)) continue;
        const f = freshName(v, taken);
        taken.add(f);
        bindings.set(v, f);
        fresh.push(f);
      }
    }
  }
  const inst = (p: string) => instantiate(m.expanded ? expandMacros(p, macros) : p, bindings);
  return { judgment: target, premises: prem.map(inst), matched: true, solved: m.solved, fresh };
}

/** Substitute unknowns everywhere in a tree (mutates). */
export function substituteTree(root: ProofNode, sub: Map<string, string>) {
  if (!sub.size) return;
  const walk = (n: ProofNode) => {
    if (metavars(n.judgment).some((v) => sub.has(v))) n.judgment = instantiate(n.judgment, sub);
    n.children.forEach(walk);
  };
  walk(root);
}

export function countOpen(n: ProofNode): number {
  if (n.children.length === 0) return n.rule || n.leaf || n.elided ? 0 : 1;
  return n.children.reduce((a, c) => a + countOpen(c), 0);
}
