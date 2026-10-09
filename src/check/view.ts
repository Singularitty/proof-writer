// The report arranged for display: issues grouped under the statement they
// belong to and worded by where they are, for the tracker tab and for
// `npm run check`.

import type { Block, Doc, Id, TheoremKind } from '../model/types';
import { THEOREM_LABEL } from '../model/types';
import type { Issue, Report } from './index';

export interface TrackerIssue extends Issue {
  /** Where the issue is, in words: "case T-App", "proof", "Syntax: rules". */
  where: string;
  /** The block to scroll to. */
  jump: Id;
}

export interface TrackerInduction {
  /** Id of the case analysis block. */
  id: Id;
  intro: string;
  /** The rules block it ranges over, and whether the document records that or the checker matched it. */
  over: Id | null;
  source: 'recorded' | 'matched' | null;
  covered: number;
  expected: number;
  missing: string[];
}

export interface TrackerGroup {
  /** Id of the statement, or null for the group of everything outside statements. */
  id: Id | null;
  kind: TheoremKind | null;
  title: string;
  label: string;
  status: 'error' | 'warning' | 'ok';
  hasProof: boolean;
  cites: string[];
  inductions: TrackerInduction[];
  issues: TrackerIssue[];
}

export interface TrackerView {
  errors: number;
  warnings: number;
  groups: TrackerGroup[];
  rulesBlocks: { id: Id; name: string }[];
}

const KIND_WORDS: Record<Block['type'], string> = {
  heading: 'heading', text: 'text', grammar: 'grammar', rules: 'rules', derivation: 'proof tree',
  theorem: 'statement', cases: 'case analysis', raw: 'raw block',
};

interface Place { block: Block; owner: Id | null; caseTitle: string | null; section: string }

const plainTitle = (s: string) => s.replace(/\[\[(.*?)\]\]/g, '$1').replace(/^\s*case\s+/i, '').trim();

export function trackerView(doc: Doc, report: Report): TrackerView {
  const places = new Map<Id, Place>();
  const caseTitles = new Map<Id, string>();
  const rulesBlocks: TrackerView['rulesBlocks'] = [];
  let section = '';
  const walk = (blocks: Block[], owner: Id | null, caseTitle: string | null, top: boolean) => {
    for (const b of blocks) {
      if (top && b.type === 'heading') section = b.text.trim();
      places.set(b.id, { block: b, owner, caseTitle, section });
      if (b.type === 'rules') {
        const names = b.rules.map((r) => r.name).filter(Boolean);
        rulesBlocks.push({ id: b.id, name: b.title.trim() || (names.length > 2 ? `${names[0]} … ${names[names.length - 1]}` : names.join(', ')) || 'Rules' });
      }
      if (b.type === 'theorem' && b.proof) walk(b.proof, b.id, null, false);
      if (b.type === 'cases') for (const c of b.cases) {
        caseTitles.set(c.id, plainTitle(c.title));
        walk(c.body, owner, plainTitle(c.title), false);
      }
    }
  };
  walk(doc.blocks, null, null, true);

  const loose: TrackerGroup = { id: null, kind: null, title: 'Outside statements', label: '', status: 'ok', hasProof: true, cites: [], inductions: [], issues: [] };
  const groups = new Map<Id, TrackerGroup>();
  for (const s of report.statements) {
    groups.set(s.id, { id: s.id, kind: s.kind, title: s.title || s.label || THEOREM_LABEL[s.kind], label: s.label, status: 'ok', hasProof: s.hasProof, cites: s.cites, inductions: [], issues: [] });
  }

  for (const ind of report.inductions) {
    const block = places.get(ind.id)!.block as Block & { type: 'cases' };
    const g = (ind.statement && groups.get(ind.statement)) || loose;
    g.inductions.push({ id: ind.id, intro: block.intro, over: ind.over?.block ?? null, source: ind.over?.source ?? null, covered: ind.covered.length, expected: ind.expected.length, missing: ind.missing });
  }

  let errors = 0;
  let warnings = 0;
  for (const issue of report.issues) {
    const p = places.get(issue.block);
    if (!p) continue;
    const isStatement = p.block.type === 'theorem' && groups.has(p.block.id);
    const g = (isStatement ? groups.get(p.block.id) : p.owner ? groups.get(p.owner) : undefined) ?? loose;
    const atCase = issue.at ? caseTitles.get(issue.at) : undefined;
    let where: string;
    if (atCase !== undefined) where = `case ${atCase}`;
    else if (p.block.type === 'cases') where = 'case analysis';
    else if (p.caseTitle !== null) where = `case ${p.caseTitle}`;
    else if (isStatement) where = 'statement';
    else if (g !== loose) where = p.block.type === 'derivation' ? 'proof tree' : g.kind === 'definition' ? 'definition' : 'proof';
    else where = p.section ? `${p.section}: ${KIND_WORDS[p.block.type]}` : KIND_WORDS[p.block.type];
    g.issues.push({ ...issue, where, jump: issue.block });
    if (issue.severity === 'error') { errors++; g.status = 'error'; }
    if (issue.severity === 'warning') { warnings++; if (g.status === 'ok') g.status = 'warning'; }
  }

  const out = [...groups.values()];
  if (loose.issues.length || loose.inductions.length) out.push(loose);
  return { errors, warnings, groups: out, rulesBlocks };
}
