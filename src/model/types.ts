// The structured document model. It is the single source of truth; Typst and
// LaTeX are generated from it. All math fields hold LaTeX math (without $).

export type Id = string;

export interface Snippet {
  id: Id;
  /** Math snippets become LaTeX macros (`\name`); text snippets expand `{{name}}` in prose. */
  kind: 'math' | 'text';
  name: string;
  arity: number;
  body: string;
  description?: string;
}

export interface Rule {
  id: Id;
  name: string; // e.g. T-App
  premises: string[]; // LaTeX math
  conclusion: string;
  side?: string; // side condition (LaTeX math), shown next to the rule
}

export interface ProofNode {
  id: Id;
  judgment: string; // LaTeX math
  /** Name shown to the right of the inference line. */
  rule?: string;
  /** Id of a defined rule that was applied, if any. */
  ruleRef?: Id;
  children: ProofNode[];
  /** Draw the node without an inference line above it (an open leaf / assumption). */
  leaf?: boolean;
  /** Render as a "⋮" elided derivation above the judgment. */
  elided?: boolean;
}

export interface GrammarProduction {
  id: Id;
  category: string; // e.g. "Types"
  metavar: string; // LaTeX math, e.g. \tau
  alternatives: string[]; // LaTeX math each
}

export type TheoremKind = 'theorem' | 'lemma' | 'corollary' | 'proposition' | 'definition' | 'conjecture';

export interface CaseItem {
  id: Id;
  title: string; // prose, e.g. "Case [[T-App]]"
  body: Block[];
}

export type Block =
  | { id: Id; type: 'heading'; level: 1 | 2 | 3; text: string }
  | { id: Id; type: 'text'; text: string }
  | { id: Id; type: 'grammar'; title: string; rows: GrammarProduction[] }
  | { id: Id; type: 'rules'; title: string; judgment?: string; rules: Rule[] }
  | { id: Id; type: 'derivation'; caption?: string; root: ProofNode; /** Open unification variables introduced by rule applications. */ unknowns?: string[] }
  | {
      id: Id;
      type: 'theorem';
      kind: TheoremKind;
      title: string;
      label: string;
      statement: string; // prose
      proof?: Block[];
      collapsed?: boolean;
    }
  | { id: Id; type: 'cases'; intro: string; cases: CaseItem[] }
  | { id: Id; type: 'raw'; typst: string; latex: string };

export type BlockType = Block['type'];

export interface Doc {
  version: 1;
  title: string;
  author: string;
  snippets: Snippet[];
  blocks: Block[];
  settings: {
    paper: 'a4' | 'us-letter';
    fontSize: number; // pt
    numberTheorems: 'shared' | 'per-kind';
  };
}

export const THEOREM_LABEL: Record<TheoremKind, string> = {
  theorem: 'Theorem',
  lemma: 'Lemma',
  corollary: 'Corollary',
  proposition: 'Proposition',
  definition: 'Definition',
  conjecture: 'Conjecture',
};
