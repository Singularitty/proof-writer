import { describe, it, expect } from 'vitest';
import { texToTypst } from '../src/latex/toTypst';

const t = (s: string) => texToTypst(s).code;

// Typst sets a script on a relation above or below it; LaTeX sets it beside.
describe('scripts on relations', () => {
  it('keeps a subscript on a relation beside it', () => {
    expect(t(String.raw`\Gamma' \sqsubseteq_{\mathrm{reg}} \Gamma`)).toContain('scripts(subset.eq.sq)_');
  });
  it('keeps a superscript on an arrow beside it', () => {
    expect(t(String.raw`e \rightarrow^{*} v`)).toContain('scripts(arrow.r)^');
    expect(t(String.raw`r \hookleftarrow^{\ell} op`)).toContain('scripts(arrow.l.hook)^');
  });
  it('does the same for = and <', () => {
    expect(t(String.raw`a =_{\alpha} b`)).toContain('scripts(=)_');
    expect(t(String.raw`a <_{1} b`)).toContain('scripts(<)_');
  });
  it('leaves letters, Greek and big operators alone', () => {
    expect(t(String.raw`\tau_1`)).not.toContain('scripts');
    expect(t(String.raw`x_i^2`)).not.toContain('scripts');
    expect(t(String.raw`\sum_{i} x`)).not.toContain('scripts');
    expect(t(String.raw`\infty_1 \int_a`)).not.toContain('scripts');
  });
});
