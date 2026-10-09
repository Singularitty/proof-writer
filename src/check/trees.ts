import type { Block, ProofNode, Rule } from '../model/types';
import { matchJudgment } from '../latex/match';
import type { MacroDef } from '../latex/macros';
import { countOpen } from '../model/tree';
import type { Issue } from './index';

type Derivation = Block & { type: 'derivation' };

export function checkTree(d: Derivation, rules: Rule[], macros: MacroDef[], issues: Issue[]) {
  const unknowns = d.unknowns ?? [];
  const open = countOpen(d.root);
  if (open) issues.push({ severity: 'warning', code: 'open-leaf', block: d.id, message: `${open} open ${open === 1 ? 'leaf' : 'leaves'} in the proof tree` });
  if (unknowns.length) issues.push({ severity: 'warning', code: 'unknowns', block: d.id, message: `Unsolved unknowns: ${unknowns.join(', ')}` });

  let elided = 0;
  const walk = (n: ProofNode) => {
    if (n.elided) elided++;
    checkStep(n);
    n.children.forEach(walk);
  };
  const drift = (n: ProofNode, message: string) => issues.push({ severity: 'warning', code: 'rule-drift', block: d.id, at: n.id, message });

  const checkStep = (n: ProofNode) => {
    let rule: Rule | undefined;
    if (n.ruleRef) {
      rule = rules.find((r) => r.id === n.ruleRef);
      if (!rule) {
        issues.push({ severity: 'error', code: 'rule-missing', block: d.id, at: n.id, message: `The rule ${n.rule || 'applied here'} no longer exists` });
        return;
      }
    } else if (n.rule) rule = rules.find((r) => r.name === n.rule);
    if (!rule || !n.judgment.trim()) return;
    if (!matchJudgment(rule.conclusion, n.judgment, macros, unknowns)) return void drift(n, `The judgment no longer matches the conclusion of ${rule.name}`);
    if (!n.children.length) return;
    // A tree may or may not show the side condition as a premise. Premises are
    // only counted: papers abbreviate them (an empty context left out, say), so
    // comparing their shape reports steps that are fine.
    const premises = rule.premises.filter((p) => p.trim()).length;
    const allowed = rule.side?.trim() ? [premises, premises + 1] : [premises];
    if (!allowed.includes(n.children.length)) drift(n, `${rule.name} has ${premises} ${premises === 1 ? 'premise' : 'premises'}, this step has ${n.children.length}`);
  };

  walk(d.root);
  if (elided) issues.push({ severity: 'info', code: 'elided', block: d.id, message: `${elided} elided ${elided === 1 ? 'derivation' : 'derivations'}` });
}
