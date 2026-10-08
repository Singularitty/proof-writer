// Typst import: converts the zkTAL fixture and checks every formula is valid for
// KaTeX and for the Typst converter, and that the result exports and compiles.
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import katex from 'katex';
import { importTypst } from '../src/import/typst';
import { typstMathToTex } from '../src/import/typstMath';
import { texToTypst } from '../src/latex/toTypst';
import { walkBlocks } from '../src/export/context';
import { exportTypst } from '../src/export/typst';
import type { Block } from '../src/model/types';

const sample = readFileSync(resolve(__dirname, 'fixtures/sample.typ'), 'utf8');
// A real proof sketch kept out of the repository; tested when present locally.
const privatePath = resolve(__dirname, 'fixtures/private/zktal.typ');
const zktal = existsSync(privatePath) ? readFileSync(privatePath, 'utf8') : null;

function mathOf(blocks: Block[]): string[] {
  const out: string[] = [];
  walkBlocks(blocks, (b) => {
    if (b.type === 'text') for (const m of b.text.matchAll(/\$\$([\s\S]+?)\$\$|\$([^$]+)\$/g)) out.push(m[1] ?? m[2]);
    if (b.type === 'grammar') for (const r of b.rows) out.push(r.metavar, ...r.alternatives);
    if (b.type === 'rules') { if (b.judgment) out.push(b.judgment); for (const r of b.rules) out.push(...r.premises, r.conclusion); }
  });
  return out;
}

describe('Typst math → LaTeX', () => {
  const cases: [string, string][] = [
    ['"Word"_32 = {0, dots, 2^32 - 1}', String.raw`\mathrm{Word}_{32} = \{ 0, \dots, 2^{32} - 1 \}`],
    ['"fetch"(P, lambda, i) = "Mov" r, op', String.raw`\mathrm{fetch} (P, \lambda, i) = \mathrm{Mov} \  r, \mathit{op}`],
    ['R tack op arrow.b.double v', String.raw`R \vdash \mathit{op} \Downarrow v`],
    ['N = |C|', 'N = |C|'],
    ['italic("pc") = (lambda, i)', String.raw`\mathit{pc} = (\lambda, i)`],
    ['L tack ell_1 subset.eq.sq ell_2', String.raw`L \vdash \ell_{1} \sqsubseteq \ell_{2}`],
  ];
  for (const [t, tex] of cases) it(t, () => expect(typstMathToTex(t).tex).toBe(tex));
});

describe('Typst document import', () => {
  const { doc, warnings } = importTypst(sample);

  it('maps the structure', () => {
    expect(doc.title).toBe('A Small Register Machine');
    expect(warnings).toEqual([]);
    const types = doc.blocks.map((b) => b.type);
    expect(types).toEqual(['heading', 'heading', 'grammar', 'text', 'grammar', 'text', 'raw', 'heading', 'heading', 'rules', 'text', 'raw', 'heading', 'theorem']);
    const h1 = doc.blocks.filter((b) => b.type === 'heading' && b.level === 1).map((b) => (b as { text: string }).text);
    expect(h1).toEqual(['Syntax', 'Semantics', 'Soundness']);
    const grammar = doc.blocks.flatMap((b) => (b.type === 'grammar' ? b.rows : []));
    expect(grammar[0]).toMatchObject({ category: 'Runtime values', metavar: 'v', alternatives: ['n', '\\lambda', '\\mathrm{ptr} (q)'] });
    expect(grammar[1].alternatives).toHaveLength(3);
    const rules = doc.blocks.find((b) => b.type === 'rules');
    expect(rules && rules.type === 'rules' && rules.judgment).toBe(String.raw`R \vdash \mathit{op} \Downarrow v`);
    expect(rules && rules.type === 'rules' && rules.rules.map((r) => [r.name, r.premises.length])).toEqual([['E-Lit', 0], ['E-Reg', 1]]);
    const thm = doc.blocks.find((b) => b.type === 'theorem');
    expect(thm && thm.type === 'theorem' && [thm.kind, thm.title]).toEqual(['lemma', 'Determinism']);
  });

  for (const [name, src] of [['sample', sample], ['zktal (local only)', zktal]] as const) {
    it.skipIf(!src)(`${name}: all math is valid for KaTeX and the Typst converter`, () => {
      const { doc } = importTypst(src!);
      for (const m of mathOf(doc.blocks)) {
        expect(() => katex.renderToString(m, { throwOnError: true, strict: false }), m).not.toThrow();
        expect(texToTypst(m).warnings, m).toEqual([]);
      }
    });
    it.skipIf(!src || spawnSync('python3', ['-c', 'import typst']).status !== 0)(`${name}: compiles to PDF`, () => {
      const { doc } = importTypst(src!);
      const dir = mkdtempSync(join(tmpdir(), 'pw-imp-'));
      writeFileSync(join(dir, 'main.typ'), exportTypst(doc).source);
      execFileSync('python3', ['-c', 'import typst,sys; typst.compile(sys.argv[1], output=sys.argv[2], font_paths=[sys.argv[3]], ignore_system_fonts=True)',
        join(dir, 'main.typ'), join(dir, 'out.pdf'), resolve(__dirname, '../public/fonts')], { stdio: 'pipe' });
      expect(existsSync(join(dir, 'out.pdf'))).toBe(true);
    });
  }
});
