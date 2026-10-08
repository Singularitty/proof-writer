import { describe, it, expect } from 'vitest';
import { matchJudgment, instantiate } from '../src/latex/match';

const macros = [{ name: 'ty', arity: 3, body: '#1 \\vdash #2 : #3' }];

describe('rule matching', () => {
  it('matches app with macros', () => {
    const r = matchJudgment('\\ty{\\Gamma}{e_1\\ e_2}{\\tau_2}', '\\ty{\\cdot}{(\\lambda x{:}\\mathsf{Bool}.\\, x)\\ \\mathsf{true}}{\\mathsf{Bool}}')!;
    expect(r.expanded).toBe(false);
    expect(Object.fromEntries(r.bindings)).toEqual({ '\\Gamma': '\\cdot', 'e_1': '(\\lambda x{:}\\mathsf{Bool}.\\, x)', 'e_2': '\\mathsf{true}', '\\tau_2': '\\mathsf{Bool}' });
    expect(instantiate('\\ty{\\Gamma}{e_1}{\\tau_1 \\to \\tau_2}', r.bindings)).toBe('\\ty{\\cdot}{(\\lambda x{:}\\mathsf{Bool}.\\, x)}{\\tau_1 \\to \\mathsf{Bool}}');
  });
  it('matches without macros', () => {
    const r = matchJudgment('\\Gamma \\vdash \\lambda x{:}\\tau_1.\\, e : \\tau_1 \\to \\tau_2', '\\cdot \\vdash \\lambda y{:}\\mathsf{Int}. y + 1 : \\mathsf{Int} \\to \\mathsf{Int}')!;
    expect(r.bindings.get('x')).toBe('y');
    expect(r.bindings.get('e')).toBe('y + 1');
    expect(instantiate('\\Gamma, x{:}\\tau_1 \\vdash e : \\tau_2', r.bindings)).toBe('\\cdot, y{:}\\mathsf{Int} \\vdash y + 1 : \\mathsf{Int}');
  });
  it('falls back to macro expansion', () => {
    const r = matchJudgment('\\ty{\\Gamma}{x}{\\tau}', '\\Delta \\vdash z : \\mathsf{Int}', macros)!;
    expect(r.expanded).toBe(true);
    expect(r.bindings.get('x')).toBe('z');
  });
  it('rejects non-matching', () => {
    expect(matchJudgment('\\Gamma \\vdash \\mathsf{true} : \\mathsf{Bool}', '\\Gamma \\vdash \\mathsf{false} : \\mathsf{Bool}')).toBeNull();
  });
  it('enforces consistent repeated metavariables', () => {
    expect(matchJudgment('e \\equiv e', 'a \\equiv b')).toBeNull();
    expect(matchJudgment('e \\equiv e', 'a b \\equiv a b')!.bindings.get('e')).toBe('a b');
  });
});

describe('parentheses', () => {
  it('ignores redundant parens in the target', () => {
    const r = matchJudgment('\\ty{\\Gamma}{\\lambda x{:}\\tau_1.\\, e}{\\tau_1 \\to \\tau_2}', '\\ty{\\cdot}{(\\lambda x{:}\\mathsf{Bool}.\\, x)}{\\mathsf{Bool} \\to \\mathsf{Bool}}')!;
    expect(r.bindings.get('e')).toBe('x');
    const r2 = matchJudgment('\\Gamma \\vdash \\lambda x.\\, e : \\tau', '\\cdot \\vdash (\\lambda y.\\, y) : \\sigma')!;
    expect(r2.bindings.get('e')).toBe('y');
  });
  it('keeps parens when the pattern has them', () => {
    const r = matchJudgment('(x{:}\\tau) \\in \\Gamma', '(y{:}\\mathsf{Int}) \\in \\Gamma')!;
    expect(r.bindings.get('x')).toBe('y');
  });
});

describe('unknowns', () => {
  it('solves an unknown from a repeated pattern variable', () => {
    const r = matchJudgment('\\ty{\\Gamma}{\\lambda x{:}\\tau_1.\\, e}{\\tau_1 \\to \\tau_2}', '\\ty{\\cdot}{(\\lambda x{:}\\mathsf{Bool}.\\, x)}{\\sigma \\to \\mathsf{Bool}}', [], ['\\sigma'])!;
    expect(r.solved.get('\\sigma')).toBe('\\mathsf{Bool}');
    expect(r.bindings.get('\\tau_1')).toBe('\\mathsf{Bool}');
  });
  it('solves an unknown against pattern structure', () => {
    const r = matchJudgment('\\ty{\\Gamma}{\\mathsf{true}}{\\mathsf{Bool}}', '\\ty{\\cdot}{\\mathsf{true}}{\\sigma}', [], ['\\sigma'])!;
    expect(r.solved.get('\\sigma')).toBe('\\mathsf{Bool}');
  });
  it('solves an unknown bound first by the pattern', () => {
    const r = matchJudgment('\\Gamma \\vdash x : \\tau \\quad \\tau = \\tau', '\\cdot \\vdash y : \\sigma \\quad \\sigma = \\mathsf{Int}', [], ['\\sigma'])!;
    expect(r.solved.get('\\sigma')).toBe('\\mathsf{Int}');
  });
});
