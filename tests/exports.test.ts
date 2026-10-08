// Compiles the sample document's exports with real toolchains when they are installed
// (Python `typst` package and `pdflatex`); skipped otherwise.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { sampleDoc } from '../src/model/sample';
import { exportTypst } from '../src/export/typst';
import { exportLatex } from '../src/export/latex';
import { texToTypst } from '../src/latex/toTypst';

const hasPyTypst = spawnSync('python3', ['-c', 'import typst']).status === 0;
const hasLatex = spawnSync('pdflatex', ['--version']).status === 0;
const fonts = resolve(__dirname, '../public/fonts');

function typstCompile(dir: string, file: string) {
  execFileSync('python3', ['-c', `import typst,sys; typst.compile(sys.argv[1], output=sys.argv[2], font_paths=[sys.argv[3]], ignore_system_fonts=True)`, join(dir, file), join(dir, 'out.pdf'), fonts], { stdio: 'pipe' });
}

describe.skipIf(!hasPyTypst)('Typst export', () => {
  it('compiles the sample document', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pw-'));
    const t = exportTypst(sampleDoc());
    expect(t.warnings).toEqual([]);
    writeFileSync(join(dir, 'main.typ'), t.source);
    typstCompile(dir, 'main.typ');
    expect(existsSync(join(dir, 'out.pdf'))).toBe(true);
  });

  it('converts a corpus of PL notation into valid Typst', () => {
    const corpus = [
      String.raw`\Gamma \vdash e_1\ e_2 : \tau_2`, String.raw`\Gamma, x{:}\tau_1 \vdash e : \tau_2`,
      String.raw`\mathsf{Int} \mid \mathsf{Bool} \mid \tau_1 \to \tau_2`, String.raw`e ::= x \mid \lambda x.\, e \mid e\ e`,
      String.raw`\langle e, \sigma \rangle \longrightarrow \langle e', \sigma' \rangle`, String.raw`e[v/x]`,
      String.raw`\text{if } x \notin \mathrm{dom}(\Gamma)`, String.raw`\overline{x_i}^{i \in 1..n}`,
      String.raw`\llbracket \tau \rrbracket_{\rho}`, String.raw`{e_1 e_2}^{*}`, String.raw`\frac{a, b}{c}`,
      String.raw`\not\in \not= \not\vdash`, String.raw`e \Downarrow v \quad e \rightarrow^* e'`,
      String.raw`\textbf{true}\ \textsc{T-App}`, String.raw`\begin{cases} a & x > 0 \\ b & \text{otherwise}\end{cases}`,
      String.raw`\mathcal{D} :: \Gamma \vdash e : \tau`, String.raw`\left( x \right)`, String.raw`3.14 + 12`,
      String.raw`\operatorname{fv}(e)`, String.raw`\overline{(a}`, String.raw`x^{(n)}_{i,j}`, String.raw`f'' \vec{v} \hat{\tau}`,
      String.raw`\{ x \mapsto v \}`, String.raw`\forall \alpha.\, \tau \leq \sigma`, String.raw`\Gamma \vDash \phi \Rightarrow \psi`,
      String.raw`\mathbb{N} \times \mathbb{B}`, String.raw`\sqrt[3]{x}`, String.raw`\overset{\mathrm{def}}{=}`,
      String.raw`\begin{aligned} a &= b \\ &= c \end{aligned}`, String.raw`\mathit{prog}\ \mathtt{let}\ x = e`,
      String.raw`#1 \vdash #2`, String.raw`a / b \# c`, String.raw`\{\!\{ x \}\!\}`, String.raw`\lambda x{:}\mathsf{Bool}.\, x`,
    ];
    const dir = mkdtempSync(join(tmpdir(), 'pw-'));
    const src = corpus.map((c) => `$${texToTypst(c).code}$\n`).join('\n');
    writeFileSync(join(dir, 'c.typ'), src);
    typstCompile(dir, 'c.typ');
  });
});

describe.skipIf(!hasLatex)('LaTeX export', () => {
  it('compiles the sample document with pdflatex', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pw-'));
    writeFileSync(join(dir, 'main.tex'), exportLatex(sampleDoc()).source);
    const r = spawnSync('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'], { cwd: dir, encoding: 'utf8' });
    expect(r.stdout.split('\n').filter((l) => l.startsWith('!'))).toEqual([]);
    expect(existsSync(join(dir, 'main.pdf'))).toBe(true);
  });
});
