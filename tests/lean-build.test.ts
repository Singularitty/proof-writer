import { describe, it, expect } from 'vitest';
import { markers, parseBuild, scan } from '../src/lean/build';

describe('reading lake build output', () => {
  it('reads diagnostics in the current format, with messages that run over lines', () => {
    const out = [
      '✖ [2/4] Building PW.Defs',
      'trace: .> LEAN_PATH=... lean ././././PW/Defs.lean',
      "error: ././././PW/Defs.lean:12:4: unknown identifier 'Ctx'",
      'error: ././././PW/Defs.lean:20:2: type mismatch',
      '  h',
      'has type',
      '  Nat',
      "warning: ././././PW/LemA.lean:7:8: declaration uses 'sorry'",
      'error: Lean exited with code 1',
      'Some required builds logged failures:',
      '- PW.Defs',
      'error: build failed',
    ].join('\n');
    expect(parseBuild(out)).toEqual([
      { file: 'PW/Defs.lean', line: 12, column: 4, severity: 'error', message: "unknown identifier 'Ctx'" },
      { file: 'PW/Defs.lean', line: 20, column: 2, severity: 'error', message: 'type mismatch\n  h\nhas type\n  Nat' },
      { file: 'PW/LemA.lean', line: 7, column: 8, severity: 'warning', message: "declaration uses 'sorry'" },
    ]);
  });
  it('reads the older format and absolute or Windows paths', () => {
    const out = [
      './././PW/Defs.lean:3:2: error: unexpected token',
      '/home/u/stlc-lean/PW/LemA.lean:5:0: warning: unused variable',
      'error: C:\\docs\\stlc-lean\\PW\\LemB.lean:9:1: oops',
    ].join('\n');
    expect(parseBuild(out).map((d) => `${d.file}:${d.line}:${d.severity}`)).toEqual(['PW/Defs.lean:3:error', 'PW/LemA.lean:5:warning', 'PW/LemB.lean:9:error']);
  });
  it('finds nothing in a clean build or in noise', () => {
    expect(parseBuild('Build completed successfully.\n')).toEqual([]);
    expect(parseBuild('')).toEqual([]);
    expect(parseBuild('error: no such file or directory')).toEqual([]);
  });
});

describe('markers', () => {
  it('reads block and rule markers with their lines', () => {
    const text = ['import PW.Defs', '', '-- pw: b12', 'inductive HasType where', '  -- pw: b12 r3', '  | tTrue : HasType', '--pw:b13', 'theorem x : True := trivial', '-- pw is nice', '-- pw: '].join('\n');
    expect(markers(text)).toEqual([{ line: 3, block: 'b12' }, { line: 5, block: 'b12', rule: 'r3' }, { line: 7, block: 'b13' }]);
  });
});

describe('scanning for sorry and axiom', () => {
  it('finds them in code', () => {
    const text = ['theorem a : P := by', '  sorry', 'axiom cheat : False', 'private axiom  hidden (n : Nat) : n = 0', 'theorem b : Q := by', '  intro h; admit'].join('\n');
    expect(scan(text)).toEqual({ sorries: [2, 6], axioms: [{ line: 3, name: 'cheat' }, { line: 4, name: 'hidden' }] });
  });
  it('ignores comments, nested block comments and strings', () => {
    const text = [
      '-- sorry, this is a comment about an axiom',
      '/- sorry',
      '   /- nested sorry -/',
      '   axiom fake : False -/',
      'def msg := "sorry \\" axiom x"',
      'theorem my_sorry_free : True := trivial',
      'theorem c : True := by sorry -- for now',
    ].join('\n');
    expect(scan(text)).toEqual({ sorries: [7], axioms: [] });
  });
});

describe('scanning: literals, raw strings, axioms and sorryAx', () => {
  it('keeps a char literal holding a quote from hiding what follows', () => {
    expect(scan(['def q : Char := \'"\'', 'theorem a : P := by sorry', 'axiom cheat : False'].join('\n'))).toEqual({
      sorries: [2],
      axioms: [{ line: 3, name: 'cheat' }],
    });
  });
  it('reads escaped char literals as literals', () => {
    const text = ["def c := ['\\n', '\\'', '\\\\', '\\x41', '\\u{1F600}']", 'theorem a : P := by sorry'].join('\n');
    expect(scan(text)).toEqual({ sorries: [2], axioms: [] });
  });
  it('does not take a prime in an identifier for a char literal', () => {
    expect(scan("theorem t (h' : P) : Q := by sorry")).toEqual({ sorries: [1], axioms: [] });
  });
  it('ends a raw string at a quote, where a backslash is not an escape', () => {
    expect(scan(['def p := r"\\"', 'theorem t : True := by sorry'].join('\n'))).toEqual({ sorries: [2], axioms: [] });
  });
  it('ignores sorry inside a raw string with hashes', () => {
    expect(scan('def s := r#"a "sorry" b"#')).toEqual({ sorries: [], axioms: [] });
  });
  it('flags axioms behind attributes, options and line breaks', () => {
    expect(scan('@[simp] axiom foo : P')).toEqual({ sorries: [], axioms: [{ line: 1, name: 'foo' }] });
    expect(scan('set_option maxHeartbeats 400000 in axiom bar : P')).toEqual({ sorries: [], axioms: [{ line: 1, name: 'bar' }] });
    expect(scan(['axiom', '  baz : P'].join('\n'))).toEqual({ sorries: [], axioms: [{ line: 1, name: 'baz' }] });
    expect(scan('axiom')).toEqual({ sorries: [], axioms: [{ line: 1, name: '(unnamed)' }] });
  });
  it('does not flag axiom as part of a longer name, a comment or a string', () => {
    const text = ['theorem no_axioms_here : True := trivial', 'def my_axiom := 1', '-- axiom in comment', 'def s := "axiom x"'].join('\n');
    expect(scan(text)).toEqual({ sorries: [], axioms: [] });
  });
  it('flags sorryAx', () => {
    expect(scan('theorem u : P := sorryAx P false')).toEqual({ sorries: [1], axioms: [] });
  });
});
