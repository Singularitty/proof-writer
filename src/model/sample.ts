import type { Doc, ProofNode } from './types';
import { uid } from './util';

const n = (judgment: string, rule?: string, ...children: ProofNode[]): ProofNode => ({
  id: uid(), judgment, rule, children,
});

export function sampleDoc(): Doc {
  return {
    version: 1,
    title: 'Type Soundness for the Simply Typed λ-Calculus',
    author: '',
    settings: { paper: 'a4', fontSize: 11, numberTheorems: 'shared' },
    snippets: [
      { id: uid(), kind: 'math', name: 'ty', arity: 3, body: '#1 \\vdash #2 : #3', description: 'typing judgment' },
      { id: uid(), kind: 'math', name: 'step', arity: 2, body: '#1 \\longrightarrow #2', description: 'small step' },
      { id: uid(), kind: 'math', name: 'Bool', arity: 0, body: '\\mathsf{Bool}' },
      { id: uid(), kind: 'math', name: 'tru', arity: 0, body: '\\mathsf{true}' },
      { id: uid(), kind: 'math', name: 'fls', arity: 0, body: '\\mathsf{false}' },
      { id: uid(), kind: 'math', name: 'ite', arity: 3, body: '\\mathsf{if}\\ #1\\ \\mathsf{then}\\ #2\\ \\mathsf{else}\\ #3' },
      { id: uid(), kind: 'text', name: 'ind', arity: 0, body: 'By induction on the derivation of' },
    ],
    blocks: [
      { id: uid(), type: 'heading', level: 1, text: 'Syntax' },
      {
        id: uid(), type: 'grammar', title: '',
        rows: [
          { id: uid(), category: 'Types', metavar: '\\tau', alternatives: ['\\Bool', '\\tau_1 \\to \\tau_2'] },
          { id: uid(), category: 'Terms', metavar: 'e', alternatives: ['x', '\\lambda x{:}\\tau.\\, e', 'e_1\\ e_2', '\\tru', '\\fls', '\\ite{e_1}{e_2}{e_3}'] },
          { id: uid(), category: 'Values', metavar: 'v', alternatives: ['\\lambda x{:}\\tau.\\, e', '\\tru', '\\fls'] },
          { id: uid(), category: 'Contexts', metavar: '\\Gamma', alternatives: ['\\cdot', '\\Gamma, x{:}\\tau'] },
        ],
      },
      { id: uid(), type: 'heading', level: 1, text: 'Static semantics' },
      {
        id: uid(), type: 'rules', title: '', judgment: '\\ty{\\Gamma}{e}{\\tau}',
        rules: [
          { id: uid(), name: 'T-Var', premises: ['(x{:}\\tau) \\in \\Gamma'], conclusion: '\\ty{\\Gamma}{x}{\\tau}' },
          { id: uid(), name: 'T-Abs', premises: ['\\ty{\\Gamma, x{:}\\tau_1}{e}{\\tau_2}'], conclusion: '\\ty{\\Gamma}{\\lambda x{:}\\tau_1.\\, e}{\\tau_1 \\to \\tau_2}' },
          { id: uid(), name: 'T-App', premises: ['\\ty{\\Gamma}{e_1}{\\tau_1 \\to \\tau_2}', '\\ty{\\Gamma}{e_2}{\\tau_1}'], conclusion: '\\ty{\\Gamma}{e_1\\ e_2}{\\tau_2}' },
          { id: uid(), name: 'T-True', premises: [], conclusion: '\\ty{\\Gamma}{\\tru}{\\Bool}' },
          { id: uid(), name: 'T-False', premises: [], conclusion: '\\ty{\\Gamma}{\\fls}{\\Bool}' },
          { id: uid(), name: 'T-If', premises: ['\\ty{\\Gamma}{e_1}{\\Bool}', '\\ty{\\Gamma}{e_2}{\\tau}', '\\ty{\\Gamma}{e_3}{\\tau}'], conclusion: '\\ty{\\Gamma}{\\ite{e_1}{e_2}{e_3}}{\\tau}' },
        ],
      },
      {
        id: uid(), type: 'text',
        text: 'For example, the identity function on booleans applied to $\\tru$ is well typed:',
      },
      {
        id: uid(), type: 'derivation', caption: '',
        root: n('\\ty{\\cdot}{(\\lambda x{:}\\Bool.\\, x)\\ \\tru}{\\Bool}', 'T-App',
          n('\\ty{\\cdot}{\\lambda x{:}\\Bool.\\, x}{\\Bool \\to \\Bool}', 'T-Abs',
            n('\\ty{x{:}\\Bool}{x}{\\Bool}', 'T-Var',
              { id: uid(), judgment: '(x{:}\\Bool) \\in x{:}\\Bool', children: [], leaf: true })),
          n('\\ty{\\cdot}{\\tru}{\\Bool}', 'T-True')),
      },
      { id: uid(), type: 'heading', level: 1, text: 'Dynamic semantics' },
      {
        id: uid(), type: 'rules', title: '', judgment: '\\step{e}{e\'}',
        rules: [
          { id: uid(), name: 'E-App1', premises: ['\\step{e_1}{e_1\'}'], conclusion: '\\step{e_1\\ e_2}{e_1\'\\ e_2}' },
          { id: uid(), name: 'E-App2', premises: ['\\step{e_2}{e_2\'}'], conclusion: '\\step{v_1\\ e_2}{v_1\\ e_2\'}' },
          { id: uid(), name: 'E-Beta', premises: [], conclusion: '\\step{(\\lambda x{:}\\tau.\\, e)\\ v}{e[v/x]}' },
          { id: uid(), name: 'E-IfTrue', premises: [], conclusion: '\\step{\\ite{\\tru}{e_2}{e_3}}{e_2}' },
          { id: uid(), name: 'E-IfFalse', premises: [], conclusion: '\\step{\\ite{\\fls}{e_2}{e_3}}{e_3}' },
          { id: uid(), name: 'E-If', premises: ['\\step{e_1}{e_1\'}'], conclusion: '\\step{\\ite{e_1}{e_2}{e_3}}{\\ite{e_1\'}{e_2}{e_3}}' },
        ],
      },
      { id: uid(), type: 'heading', level: 1, text: 'Soundness' },
      {
        id: uid(), type: 'theorem', kind: 'lemma', title: 'Canonical forms', label: 'lem:canonical',
        statement: 'If $\\ty{\\cdot}{v}{\\tau}$ then\n- if $\\tau = \\Bool$ then $v = \\tru$ or $v = \\fls$;\n- if $\\tau = \\tau_1 \\to \\tau_2$ then $v = \\lambda x{:}\\tau_1.\\, e$ for some $x$ and $e$.',
        proof: [{ id: uid(), type: 'text', text: 'By inspection of the typing rules, since each form of value is typed by exactly one rule.' }],
      },
      {
        id: uid(), type: 'theorem', kind: 'theorem', title: 'Progress', label: 'thm:progress',
        statement: 'If $\\ty{\\cdot}{e}{\\tau}$ then either $e$ is a value or there is $e\'$ with $\\step{e}{e\'}$.',
        proof: [
          {
            id: uid(), type: 'cases', intro: '{{ind}} $\\ty{\\cdot}{e}{\\tau}$.',
            cases: [
              { id: uid(), title: '[[T-Var]]', body: [{ id: uid(), type: 'text', text: 'Impossible, since the context is empty.' }] },
              { id: uid(), title: '[[T-Abs]], [[T-True]], [[T-False]]', body: [{ id: uid(), type: 'text', text: '$e$ is a value.' }] },
              {
                id: uid(), title: '[[T-App]]',
                body: [{ id: uid(), type: 'text', text: 'Then $e = e_1\\ e_2$ with $\\ty{\\cdot}{e_1}{\\tau_1 \\to \\tau}$ and $\\ty{\\cdot}{e_2}{\\tau_1}$. By the induction hypothesis, $e_1$ is a value or steps. If it steps, apply [[E-App1]]. Otherwise, consider $e_2$: if it steps, apply [[E-App2]]; if it is a value, by [[lem:canonical]] $e_1 = \\lambda x{:}\\tau_1.\\, e\'$ and [[E-Beta]] applies.' }],
              },
              { id: uid(), title: '[[T-If]]', body: [{ id: uid(), type: 'text', text: 'Similar, using [[lem:canonical]] for the guard.' }] },
            ],
          },
        ],
      },
      {
        id: uid(), type: 'theorem', kind: 'theorem', title: 'Preservation', label: 'thm:preservation',
        statement: 'If $\\ty{\\Gamma}{e}{\\tau}$ and $\\step{e}{e\'}$ then $\\ty{\\Gamma}{e\'}{\\tau}$.',
        proof: [{ id: uid(), type: 'text', text: '{{ind}} $\\step{e}{e\'}$, using a substitution lemma for [[E-Beta]].' }],
      },
    ],
  };
}

export function emptyDoc(): Doc {
  return {
    version: 1,
    title: 'Untitled',
    author: '',
    settings: { paper: 'a4', fontSize: 11, numberTheorems: 'shared' },
    snippets: [],
    blocks: [{ id: uid(), type: 'heading', level: 1, text: 'Introduction' }],
  };
}
