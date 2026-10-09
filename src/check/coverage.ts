import type { Block, Id } from '../model/types';
import { matchJudgment } from '../latex/match';
import type { MacroDef } from '../latex/macros';
import { inlineParts, proseParts } from './prose';
import type { InductionStatus, Issue } from './index';

type RulesBlock = Block & { type: 'rules' };
type CasesBlock = Block & { type: 'cases' };

export interface CoverageCtx {
  rulesBlocks: RulesBlock[];
  ruleNames: Set<string>;
  macros: MacroDef[];
  snippets: Map<string, string>;
}

/** The block's rule names, each once. */
const names = (b: RulesBlock) => [...new Set(b.rules.map((r) => r.name).filter(Boolean))];

/** True when a block list holds anything other than blank text. */
export function hasContent(blocks: Block[] | undefined): boolean {
  return !!blocks?.some((b) => b.type !== 'text' || b.text.trim() !== '');
}

/** A case title as read aloud: no reference brackets, no leading "Case". */
const plain = (title: string) => title.replace(/\[\[(.*?)\]\]/g, '$1').replace(/^\s*case\s+/i, '').trim();

function mentions(text: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_-])${esc}($|[^A-Za-z0-9_-])`).test(text);
}

/** Whether a case title names the rule, as `[[T-App]]` or as plain `T-App`. */
function covers(title: ReturnType<typeof inlineParts>, rule: string): boolean {
  return title.refs.includes(rule) || mentions(title.text, rule);
}

/** The rules, each once and in order, that none of the case titles names. */
export function uncoveredRules(titles: string[], rules: string[], snippets: Map<string, string>): string[] {
  const parts = titles.map((t) => inlineParts(t, snippets));
  return [...new Set(rules.filter(Boolean))].filter((r) => !parts.some((p) => covers(p, r)));
}

/** Which rules block a case analysis ranges over. */
function findOver(c: CasesBlock, citedRules: string[], cx: CoverageCtx): InductionStatus['over'] {
  if (c.over?.kind === 'rules' && cx.rulesBlocks.some((b) => b.id === c.over!.block)) return { block: c.over.block, source: 'recorded' };
  // the judgment named in the intro, against each block's judgment form
  const math = proseParts(c.intro, cx.snippets).math;
  const byJudgment = cx.rulesBlocks.filter((b) => b.judgment?.trim() && math.some((m) => matchJudgment(b.judgment!, m, cx.macros)));
  if (byJudgment.length === 1) return { block: byJudgment[0].id, source: 'matched' };
  // otherwise the block holding every rule the case titles cite
  const pool = byJudgment.length ? byJudgment : cx.rulesBlocks;
  const byTitles = citedRules.length ? pool.filter((b) => citedRules.every((r) => names(b).includes(r))) : [];
  return byTitles.length === 1 ? { block: byTitles[0].id, source: 'matched' } : null;
}

export function checkCases(c: CasesBlock, statement: Id | undefined, cx: CoverageCtx, issues: Issue[]): InductionStatus {
  const titles = c.cases.map((k) => inlineParts(k.title, cx.snippets));
  const citedRules = [...new Set(titles.flatMap((t) => t.refs).filter((r) => cx.ruleNames.has(r)))];
  const over = findOver(c, citedRules, cx);
  const expected = over ? names(cx.rulesBlocks.find((b) => b.id === over.block)!) : [];

  const seen = new Set<string>();
  c.cases.forEach((k, i) => {
    const t = titles[i];
    const here = expected.filter((r) => covers(t, r));
    const again = here.filter((r) => seen.has(r));
    if (again.length) issues.push({ severity: 'warning', code: 'duplicate-case', block: c.id, at: k.id, message: `${again.join(', ')} already has a case` });
    here.forEach((r) => seen.add(r));
    const foreign = over ? t.refs.filter((r) => cx.ruleNames.has(r) && !expected.includes(r)) : [];
    if (foreign.length) issues.push({ severity: 'warning', code: 'foreign-case', block: c.id, at: k.id, message: `${foreign.join(', ')} is not a rule of the judgment this analysis ranges over` });
    if (!hasContent(k.body)) issues.push({ severity: 'warning', code: 'empty-case', block: c.id, at: k.id, message: plain(k.title) ? `The case ${plain(k.title)} has nothing in it` : `Case ${i + 1} has nothing in it` });
  });

  const covered = expected.filter((r) => seen.has(r));
  const missing = expected.filter((r) => !seen.has(r));
  if (missing.length) issues.push({ severity: 'error', code: 'missing-case', block: c.id, message: `No case for ${missing.join(', ')}` });
  return { id: c.id, statement, over, expected, covered, missing };
}
