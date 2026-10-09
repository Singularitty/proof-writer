// Consistency checks over a document: references, case coverage, unfinished
// statements and proof trees that have drifted from their rules. Pure functions
// with no DOM, so the app, the command line and the tests share one copy.

import type { Block, Doc, Id, Rule, TheoremKind } from '../model/types';
import { makeCtx, sanitizeLabel } from '../export/context';
import { docMacros } from '../model/tree';
import { checkCases, hasContent, type CoverageCtx } from './coverage';
import { checkTree } from './trees';
import { inlineParts, proseParts } from './prose';

export type Severity = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'dangling-ref' | 'duplicate-label' | 'duplicate-rule' | 'cycle' | 'unused'
  | 'no-proof'
  | 'missing-case' | 'duplicate-case' | 'empty-case' | 'foreign-case'
  | 'open-leaf' | 'elided' | 'unknowns' | 'rule-missing' | 'rule-drift';

export interface Issue {
  severity: Severity;
  code: IssueCode;
  /** The block the issue is in. */
  block: Id;
  /** The case or proof-tree node inside that block, if the issue is about one. */
  at?: Id;
  message: string;
}

export interface StatementStatus {
  id: Id;
  kind: TheoremKind;
  label: string;
  title: string;
  hasProof: boolean;
  /** Labels of the statements this one's proof cites. */
  cites: string[];
  /** Labels of the statements whose proofs cite this one. */
  citedBy: string[];
}

export interface InductionStatus {
  /** Id of the case analysis block. */
  id: Id;
  /** Id of the statement whose proof holds it, if any. */
  statement?: Id;
  /** The rules block it ranges over: recorded in the document, matched by the checker, or unknown. */
  over: { block: Id; source: 'recorded' | 'matched' } | null;
  /** Rule names, in the order the rules block lists them. */
  expected: string[];
  covered: string[];
  missing: string[];
}

export interface Report {
  statements: StatementStatus[];
  inductions: InductionStatus[];
  issues: Issue[];
}

const NEEDS_PROOF = new Set<TheoremKind>(['theorem', 'lemma', 'corollary', 'proposition']);

type Statement = Block & { type: 'theorem' };

export function checkDoc(doc: Doc): Report {
  const cx = makeCtx(doc);
  const macros = docMacros(doc);
  const issues: Issue[] = [];
  const inductions: InductionStatus[] = [];
  const statements: StatementStatus[] = [];

  const rulesBlocks: CoverageCtx['rulesBlocks'] = [];
  const rules: Rule[] = [];
  const collect = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.type === 'rules') { rulesBlocks.push(b); rules.push(...b.rules); }
      if (b.type === 'theorem' && b.proof) collect(b.proof);
      if (b.type === 'cases') for (const c of b.cases) collect(c.body);
    }
  };
  collect(doc.blocks);
  const coverage: CoverageCtx = { rulesBlocks, ruleNames: cx.ruleNames, macros, snippets: cx.textSnippets };

  const ruleSeen = new Set<string>();
  for (const b of rulesBlocks) for (const r of b.rules) {
    if (!r.name) continue;
    if (ruleSeen.has(r.name)) issues.push({ severity: 'warning', code: 'duplicate-rule', block: b.id, message: `The rule name ${r.name} is used more than once` });
    ruleSeen.add(r.name);
  }

  const labelSeen = new Map<string, Id>();
  const cites = new Map<Id, string[]>();
  const referenced = new Set<string>();

  const refs = (b: Block, owner: Statement | undefined, found: string[]) => {
    for (const v of found) {
      const label = sanitizeLabel(v);
      if (cx.labels.has(label)) {
        referenced.add(label);
        if (owner) {
          const list = cites.get(owner.id)!;
          if (!list.includes(label)) list.push(label);
        }
      } else if (!cx.ruleNames.has(v)) {
        issues.push({ severity: 'error', code: 'dangling-ref', block: b.id, message: `[[${v}]] does not name a statement or a rule` });
      }
    }
  };

  // `owner` is the statement whose proof the blocks are part of
  const visit = (blocks: Block[], owner: Statement | undefined) => {
    for (const b of blocks) {
      if (b.type === 'text' || b.type === 'heading') refs(b, owner, proseParts(b.text, cx.textSnippets).refs);
      else if (b.type === 'derivation') checkTree(b, rules, macros, issues);
      else if (b.type === 'cases') {
        refs(b, owner, proseParts(b.intro, cx.textSnippets).refs);
        for (const c of b.cases) refs(b, owner, inlineParts(c.title, cx.textSnippets).refs);
        inductions.push(checkCases(b, owner?.id, coverage, issues));
        for (const c of b.cases) visit(c.body, owner);
      } else if (b.type === 'theorem') {
        const label = sanitizeLabel(b.label);
        if (label) {
          if (labelSeen.has(label)) issues.push({ severity: 'error', code: 'duplicate-label', block: b.id, message: `The label ${label} is already used` });
          else labelSeen.set(label, b.id);
        }
        // a statement may refer to others, but only its proof depends on them
        refs(b, undefined, proseParts(b.statement, cx.textSnippets).refs);
        cites.set(b.id, []);
        const hasProof = hasContent(b.proof);
        if (!hasProof && NEEDS_PROOF.has(b.kind)) issues.push({ severity: 'warning', code: 'no-proof', block: b.id, message: `${b.title || label || 'This statement'} has no proof` });
        statements.push({ id: b.id, kind: b.kind, label, title: b.title, hasProof, cites: cites.get(b.id)!, citedBy: [] });
        if (b.proof) visit(b.proof, b);
      }
    }
  };
  visit(doc.blocks, undefined);

  const byLabel = new Map<string, StatementStatus>();
  for (const s of statements) if (s.label && !byLabel.has(s.label)) byLabel.set(s.label, s);
  for (const s of statements) for (const l of s.cites) {
    const target = byLabel.get(l);
    if (target && s.label && !target.citedBy.includes(s.label)) target.citedBy.push(s.label);
  }

  // circular dependencies, each reported once
  const reported = new Set<string>();
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];
  const dfs = (label: string) => {
    state.set(label, 'open');
    path.push(label);
    for (const next of byLabel.get(label)?.cites ?? []) {
      if (state.get(next) === 'open') {
        const cycle = path.slice(path.indexOf(next));
        const key = [...cycle].sort().join(' ');
        if (!reported.has(key)) {
          reported.add(key);
          issues.push({ severity: 'error', code: 'cycle', block: byLabel.get(next)!.id, message: `Circular dependency: ${[...cycle, next].join(' → ')}` });
        }
      } else if (!state.has(next) && byLabel.has(next)) dfs(next);
    }
    path.pop();
    state.set(label, 'done');
  };
  for (const l of byLabel.keys()) if (!state.has(l)) dfs(l);

  for (const s of statements) {
    if (s.kind === 'lemma' && s.label && !referenced.has(s.label)) issues.push({ severity: 'info', code: 'unused', block: s.id, message: `Nothing refers to ${s.label}` });
  }

  return { statements, inductions, issues };
}
