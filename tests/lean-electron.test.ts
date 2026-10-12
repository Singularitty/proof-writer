import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { EFFORTS, MODELS } from '../src/lean/prompt';

const lean = createRequire(import.meta.url)('../electron/lean.cjs');

// Stand-ins for the two programs, driven by FAKE_CLAUDE.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  fs.writeFileSync('prompt.txt', input);
  const mode = process.env.FAKE_CLAUDE || 'ok';
  if (mode === 'orphan') {
    const grandchild = require('child_process').spawn('sleep', ['30'], { stdio: 'inherit' });
    fs.writeFileSync('grandchild.pid', String(grandchild.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'stubborn') {
    process.on('SIGTERM', () => {});
    fs.writeFileSync('stubborn.pid', String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  say({ type: 'system', subtype: 'init' });
  process.stdout.write('this line is not JSON\\n');
  say({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Write', input: { file_path: process.cwd() + '/PW/Defs.lean' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'lake build' } },
  ] } });
  if (mode === 'noreport') { process.stderr.write('first line\\nNot logged in\\n'); process.exitCode = 3; return; }
  const result = JSON.stringify(mode === 'error'
    ? { type: 'result', is_error: true, result: 'Credit balance is too low' }
    : { type: 'result', is_error: false, result: '', structured_output: { outcome: 'done', summary: 'ok' } }) + '\\n';
  process.stdout.write(result.slice(0, 20));
  await new Promise((r) => setTimeout(r, 40));
  process.stdout.write(result.slice(20));
});
`;
const FAKE_LAKE = `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('Lake version 5.0.0-src (Lean version ' + (process.env.FAKE_LEAN_VERSION || '4.22.0') + ')'); process.exit(0); }
if (process.env.FAKE_LAKE === 'hang') {
  setInterval(() => {}, 1000);
} else {
  console.log("error: ././././PW/Defs.lean:2:0: unknown identifier 'x'");
  console.error('error: build failed');
  process.exitCode = 1;
}
`;

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pw-lean-')));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const [name, text] of [['claude', FAKE_CLAUDE], ['lake', FAKE_LAKE]] as const) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const env = { ...process.env, PATH: bin + delimiter + process.env.PATH };
  const doc = join(root, 'stlc.proof.json');
  const dir = lean.leanDir(doc);
  return { root, bin, env, doc, dir, claude: join(bin, 'claude'), lake: join(bin, 'lake') };
}
const args = () => lean.claudeArgs({ model: '', effort: '', schema: { type: 'object' }, instructions: 'RULES' });

describe.skipIf(process.platform === 'win32')('the Lean side of the desktop app', () => {
  it('names the Lean folder after the document', () => {
    expect(lean.leanDir('/docs/stlc.proof.json')).toBe('/docs/stlc-lean');
    expect(lean.leanDir('/docs/My Notes.json')).toBe('/docs/My Notes-lean');
    expect(lean.leanDir('/docs/a.b.proof.json')).toBe('/docs/a.b-lean');
  });

  it('finds tools on the PATH and in the places a GUI app does not inherit', async () => {
    const { root, bin } = setup();
    expect(await lean.findTool('lake', { env: { PATH: bin }, home: root, system: [] })).toBe(join(bin, 'lake'));
    expect(await lean.findTool('lake', { env: { PATH: '' }, home: root, system: [] })).toBe(null);
    mkdirSync(join(root, '.elan', 'bin'), { recursive: true });
    writeFileSync(join(root, '.elan', 'bin', 'lake'), FAKE_LAKE);
    chmodSync(join(root, '.elan', 'bin', 'lake'), 0o755);
    expect(await lean.findTool('lake', { env: { PATH: '' }, home: root, system: [] })).toBe(join(root, '.elan', 'bin', 'lake'));
    const env = lean.childEnv({ claude: join(bin, 'claude'), lake: join(root, '.elan', 'bin', 'lake') }, { env: { PATH: '/usr/bin' }, home: root, system: [] });
    expect(env.PATH.split(delimiter).slice(0, 2)).toEqual([join(root, '.elan', 'bin'), bin]);
  });

  it('creates the project once and leaves the user’s conventions alone', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    expect(readFileSync(join(dir, 'lakefile.toml'), 'utf8')).toContain('name = "PW"');
    expect(readFileSync(join(dir, 'lean-toolchain'), 'utf8').trim()).toBe('leanprover/lean4:v4.22.0');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.lake');
    expect(existsSync(join(dir, 'PW'))).toBe(true);
    writeFileSync(join(dir, 'CONVENTIONS.md'), 'Use de Bruijn indices.');
    writeFileSync(join(dir, 'lean-toolchain'), 'leanprover/lean4:v4.20.0\n');
    await lean.ensureProject(dir, lake, env, doc);
    expect(readFileSync(join(dir, 'CONVENTIONS.md'), 'utf8')).toBe('Use de Bruijn indices.');
    expect(readFileSync(join(dir, 'lean-toolchain'), 'utf8').trim()).toBe('leanprover/lean4:v4.20.0');
  });

  it('rewrites CLAUDE.md before a job and hands back both instruction files', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    writeFileSync(join(dir, 'CLAUDE.md'), 'tampered');
    writeFileSync(join(dir, 'CONVENTIONS.md'), 'Use de Bruijn indices.');
    const text = await lean.writeInstructions(dir);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('-- pw:');
    expect(text).toContain('-- pw:');
    expect(text).toContain('Use de Bruijn indices.');
  });

  it('recreates the project files without touching PW/', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    writeFileSync(join(dir, 'PW', 'Defs.lean'), '-- mine');
    writeFileSync(join(dir, 'lakefile.toml'), 'broken');
    await lean.recreateProject(dir, lake, env);
    expect(readFileSync(join(dir, 'lakefile.toml'), 'utf8')).toContain('name = "PW"');
    expect(readFileSync(join(dir, 'PW', 'Defs.lean'), 'utf8')).toBe('-- mine');
  });

  it('builds the command line, with the model and effort only when chosen', () => {
    const plain = args();
    for (const flag of ['-p', '--restricted', '--strict-mcp-config', '--verbose', '--no-session-persistence']) expect(plain).toContain(flag);
    expect(plain[plain.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(plain[plain.indexOf('--permission-prompts') + 1]).toBe('none');
    expect(plain[plain.indexOf('--append-system-prompt') + 1]).toBe('RULES');
    expect(JSON.parse(plain[plain.indexOf('--json-schema') + 1])).toEqual({ type: 'object' });
    expect(plain).toContain('Bash(lake build)');
    expect(plain).toContain('Bash(lake build *)');
    // `lake env lean` would let a job write files anywhere (`-o`) and run code (`--run`)
    expect(plain.filter((a: string) => a.startsWith('Bash('))).toEqual(['Bash(lake build)', 'Bash(lake build *)']);
    expect(plain).not.toContain('--model');
    expect(plain).not.toContain('--effort');
    const chosen = lean.claudeArgs({ model: 'opus', effort: 'high', schema: {}, instructions: '' });
    expect(chosen[chosen.indexOf('--model') + 1]).toBe('opus');
    expect(chosen[chosen.indexOf('--effort') + 1]).toBe('high');
  });

  it('refuses a model or effort that is not on the list', () => {
    expect(() => lean.claudeArgs({ model: 'opus; rm -rf ~', effort: '', schema: {}, instructions: '' })).toThrow(/model/);
    expect(() => lean.claudeArgs({ model: '', effort: 'extreme', schema: {}, instructions: '' })).toThrow(/effort/);
    expect(lean.MODELS).toEqual([...MODELS]);
    expect(lean.EFFORTS).toEqual([...EFFORTS]);
  });

  it('runs a job to its report, and survives split and non-JSON lines', async () => {
    const { doc, dir, lake, env, claude } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    const lines: string[] = [];
    const run = lean.runClaude({ claude, dir, prompt: 'Job: sync.', args: args(), env, onLine: (l: string) => lines.push(l) });
    expect(await run.done).toEqual({ ok: true, report: { outcome: 'done', summary: 'ok' }, cancelled: false });
    expect(lines).toEqual(['wrote PW/Defs.lean', 'lake build']);
    expect(readFileSync(join(dir, 'prompt.txt'), 'utf8')).toBe('Job: sync.');
    expect(JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'))).toEqual(args());
  });

  it('reports a run that ends without a report, with the CLI’s last words', async () => {
    const { doc, dir, lake, env, claude } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    const run = lean.runClaude({ claude, dir, prompt: 'x', args: args(), env: { ...env, FAKE_CLAUDE: 'noreport' } });
    expect(await run.done).toEqual({ ok: false, report: null, cancelled: false, error: 'Not logged in' });
  });

  it('reports a run the CLI marks as an error', async () => {
    const { doc, dir, lake, env, claude } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    const run = lean.runClaude({ claude, dir, prompt: 'x', args: args(), env: { ...env, FAKE_CLAUDE: 'error' } });
    expect(await run.done).toMatchObject({ ok: false, cancelled: false, error: 'Credit balance is too low' });
  });

  it('cancels a running job, and stops one that runs past its limit', async () => {
    const { doc, dir, lake, env, claude } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    const hang = { ...env, FAKE_CLAUDE: 'hang' };
    const run = lean.runClaude({ claude, dir, prompt: 'x', args: args(), env: hang });
    setTimeout(() => run.cancel(), 150);
    expect(await run.done).toMatchObject({ ok: false, cancelled: true });
    const slow = lean.runClaude({ claude, dir, prompt: 'x', args: args(), env: hang, limitMs: 150 });
    expect(await slow.done).toMatchObject({ ok: false, cancelled: false, error: expect.stringMatching(/time limit/) });
  });

  it('stops every running program on stopAll, and does nothing when none runs', async () => {
    const { doc, dir, lake, env, claude } = setup();
    expect(() => lean.stopAll()).not.toThrow();
    await lean.ensureProject(dir, lake, env, doc);
    const run = lean.runClaude({ claude, dir, prompt: 'x', args: args(), env: { ...env, FAKE_CLAUDE: 'hang' } });
    const started = Date.now();
    setTimeout(() => lean.stopAll(), 150);
    expect(await run.done).toMatchObject({ ok: false });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(() => lean.stopAll()).not.toThrow();
  });

  it('says so when claude cannot be started', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    const run = lean.runClaude({ claude: join(dir, 'no-such-claude'), dir, prompt: 'x', args: args(), env });
    expect(await run.done).toMatchObject({ ok: false, error: expect.stringMatching(/Could not start/) });
  });

  it('builds, returning Lake’s output and the Lean files, and keeps PW.lean in step', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    writeFileSync(join(dir, 'PW', 'LemA.lean'), 'import PW.Defs\n');
    writeFileSync(join(dir, 'PW', 'Defs.lean'), '-- pw: b1\n');
    writeFileSync(join(dir, 'PW', 'notes.txt'), 'ignore me');
    const built = await lean.runBuild({ dir, lake, env });
    expect(built.started).toBe(true);
    expect(built.code).toBe(1);
    expect(built.output).toContain("unknown identifier 'x'");
    expect(built.output).toContain('build failed');
    expect(built.files).toEqual([{ path: 'PW/Defs.lean', text: '-- pw: b1\n' }, { path: 'PW/LemA.lean', text: 'import PW.Defs\n' }]);
    expect(readFileSync(join(dir, 'PW.lean'), 'utf8')).toBe('import PW.Defs\nimport PW.LemA\n');
  });

  it('removes the Lean files the document no longer has, only when told which to keep', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    for (const n of ['Defs', 'LemA', 'Old']) writeFileSync(join(dir, 'PW', n + '.lean'), `-- ${n}\n`);
    writeFileSync(join(dir, 'PW', 'notes.txt'), 'keep me');
    const kept = await lean.runBuild({ dir, lake, env });
    expect(kept.removed).toEqual([]);
    expect(kept.files.map((f: { path: string }) => f.path)).toEqual(['PW/Defs.lean', 'PW/LemA.lean', 'PW/Old.lean']);
    const asked: string[] = [];
    const built = await lean.runBuild({ dir, lake, env, keep: ['LemA'], remove: async (p: string) => { asked.push(p); await rm(p); } });
    expect(asked).toEqual([join(dir, 'PW', 'Old.lean')]);
    expect(built.removed).toEqual(['PW/Old.lean']);
    expect(built.files.map((f: { path: string }) => f.path)).toEqual(['PW/Defs.lean', 'PW/LemA.lean']);
    expect(existsSync(join(dir, 'PW', 'Old.lean'))).toBe(false);
    expect(existsSync(join(dir, 'PW', 'notes.txt'))).toBe(true);
    expect(readFileSync(join(dir, 'PW.lean'), 'utf8')).toBe('import PW.Defs\nimport PW.LemA\n');
  });

  it('leaves a file in place when it cannot be removed, and still returns the build', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    writeFileSync(join(dir, 'PW', 'Old.lean'), '-- Old\n');
    const built = await lean.runBuild({ dir, lake, env, keep: [], remove: async () => { throw new Error('busy'); } });
    expect(built.started).toBe(true);
    expect(built.removed).toEqual([]);
    expect(existsSync(join(dir, 'PW', 'Old.lean'))).toBe(true);
  });

  it('ignores files that are not valid Lean module names', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    writeFileSync(join(dir, 'PW', 'LemA.lean'), '-- A\n');
    writeFileSync(join(dir, 'PW', 'my-notes.lean'), '-- notes\n');
    writeFileSync(join(dir, 'PW', 'a b.lean'), '-- b\n');
    const asked: string[] = [];
    const built = await lean.runBuild({ dir, lake, env, keep: [], remove: async (p: string) => { asked.push(p); } });
    expect(built.files.map((f: { path: string }) => f.path)).toEqual(['PW/LemA.lean']);
    expect(asked).toEqual([join(dir, 'PW', 'LemA.lean')]);
    expect(readFileSync(join(dir, 'PW.lean'), 'utf8')).toBe('import PW.LemA\n');
  });

  it('stops what a job started, not only the job', async () => {
    const { doc, dir, lake, env, claude } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    const run = lean.runClaude({ claude, dir, prompt: 'x', args: args(), env: { ...env, FAKE_CLAUDE: 'orphan' } });
    await new Promise((r) => setTimeout(r, 400));
    const pid = Number(readFileSync(join(dir, 'grandchild.pid'), 'utf8'));
    const started = Date.now();
    run.cancel();
    expect(await run.done).toMatchObject({ ok: false, cancelled: true });
    expect(Date.now() - started).toBeLessThan(3000);
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('gives up on a build that hangs past its limit', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    const started = Date.now();
    const built = await lean.runBuild({ dir, lake, env: { ...env, FAKE_LAKE: 'hang' }, limitMs: 150 });
    expect(built).toMatchObject({ started: true, code: null, removed: [] });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('says a build did not start when lake is missing', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    expect(await lean.runBuild({ dir, lake: join(dir, 'no-such-lake'), env })).toMatchObject({ started: false, code: null });
  });

  it('writes the status file whole and reads back null for anything unreadable', async () => {
    const { dir } = setup();
    expect(await lean.readStatus(dir)).toBe(null);
    await lean.writeStatus(dir, { version: 1, blocks: {}, proposals: [] });
    expect(await lean.readStatus(dir)).toEqual({ version: 1, blocks: {}, proposals: [] });
    expect(existsSync(join(dir, 'mechanization.json.tmp'))).toBe(false);
    writeFileSync(join(dir, 'mechanization.json'), '{ "version": 1, "blo');
    expect(await lean.readStatus(dir)).toBe(null);
  });

  it('writes the snapshot', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    await lean.writeSnapshot(dir, { json: '{"version":1}', md: '# Doc' });
    expect(readFileSync(join(dir, 'document.json'), 'utf8')).toBe('{"version":1}');
    expect(readFileSync(join(dir, 'document.md'), 'utf8')).toBe('# Doc');
  });

  it('pins a released toolchain by its version, and anything else to stable', async () => {
    for (const [version, pinned] of [['4.22.0-rc3', 'leanprover/lean4:v4.22.0-rc3'], ['4.23.0-nightly-2026-10-01', 'leanprover/lean4:stable'], ['4.22.0;x', 'leanprover/lean4:stable']]) {
      const { doc, dir, lake, env } = setup();
      await lean.ensureProject(dir, lake, { ...env, FAKE_LEAN_VERSION: version }, doc);
      expect(readFileSync(join(dir, 'lean-toolchain'), 'utf8').trim()).toBe(pinned);
    }
  });

  it('rewrites the lakefile before every build', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    const made = readFileSync(join(dir, 'lakefile.toml'), 'utf8');
    writeFileSync(join(dir, 'lakefile.toml'), 'name = "PW"\ndefaultTargets = []\n');
    await lean.runBuild({ dir, lake, env });
    expect(readFileSync(join(dir, 'lakefile.toml'), 'utf8')).toBe(made);
  });

  it('keeps a file whose module differs from a kept one only in case', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    for (const n of ['lema', 'Old']) writeFileSync(join(dir, 'PW', n + '.lean'), `-- ${n}\n`);
    const asked: string[] = [];
    const built = await lean.runBuild({ dir, lake, env, keep: ['LemA'], remove: async (p: string) => { asked.push(p); await rm(p); } });
    expect(asked).toEqual([join(dir, 'PW', 'Old.lean')]);
    expect(built.removed).toEqual(['PW/Old.lean']);
    expect(existsSync(join(dir, 'PW', 'lema.lean'))).toBe(true);
  });

  it('writes PW.lean for a run from the modules the document needs', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    writeFileSync(join(dir, 'PW', 'Stray.lean'), '-- stray\n');
    await lean.writeRoot(dir, ['LemA', "Thm_B'"]);
    expect(readFileSync(join(dir, 'PW.lean'), 'utf8')).toBe("import PW.Defs\nimport PW.LemA\nimport PW.Thm_B'\n");
    expect(lean.isModuleName('LemA')).toBe(true);
    for (const bad of ['', 'a b', 'A.B', '../x', 'A\nimport Evil', 3, null]) expect(lean.isModuleName(bad)).toBe(false);
    await expect(lean.writeRoot(dir, ['A\nimport Evil'])).rejects.toThrow(/module/);
  });

  it('says which Lean files a run touched, and puts the conventions back', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    writeFileSync(join(dir, 'CONVENTIONS.md'), 'Use de Bruijn indices.');
    for (const n of ['Defs', 'LemA', 'ThmB', 'Gone']) writeFileSync(join(dir, 'PW', n + '.lean'), `-- ${n}\n`);
    const before = await lean.readSources(dir);
    expect(await lean.touchedSince(dir, before)).toEqual([]);
    writeFileSync(join(dir, 'PW', 'Defs.lean'), '-- weakened\n');
    writeFileSync(join(dir, 'PW', 'New.lean'), '-- new\n');
    unlinkSync(join(dir, 'PW', 'Gone.lean'));
    writeFileSync(join(dir, 'PW', 'notes.txt'), 'not Lean');
    writeFileSync(join(dir, 'CONVENTIONS.md'), 'Axioms are fine.');
    expect(await lean.touchedSince(dir, before)).toEqual(['PW/Defs.lean', 'PW/Gone.lean', 'PW/New.lean', 'CONVENTIONS.md']);
    expect(readFileSync(join(dir, 'CONVENTIONS.md'), 'utf8')).toBe('Use de Bruijn indices.');
    unlinkSync(join(dir, 'CONVENTIONS.md'));
    expect(await lean.touchedSince(dir, before)).toContain('CONVENTIONS.md');
    expect(readFileSync(join(dir, 'CONVENTIONS.md'), 'utf8')).toBe('Use de Bruijn indices.');
  });

  it('marks the folder it creates as this document’s', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    expect(readFileSync(join(dir, '.proof-writer'), 'utf8').trim()).toBe('stlc.proof.json');
    await expect(lean.assertOwned(dir, doc)).resolves.toBeUndefined();
    await expect(lean.ensureProject(dir, lake, env, doc)).resolves.toBeUndefined();
  });

  it('takes a folder that is not there yet, or is empty', async () => {
    const { doc, dir, lake, env } = setup();
    await expect(lean.assertOwned(dir, doc)).resolves.toBeUndefined();
    mkdirSync(dir);
    await expect(lean.assertOwned(dir, doc)).resolves.toBeUndefined();
    await lean.ensureProject(dir, lake, env, doc);
    expect(readFileSync(join(dir, '.proof-writer'), 'utf8').trim()).toBe('stlc.proof.json');
  });

  it('refuses a folder that was there already and is not its own', async () => {
    const { doc, dir, lake, env } = setup();
    mkdirSync(dir);
    writeFileSync(join(dir, 'thesis.tex'), 'mine');
    const refusal = `${dir} already exists and was not created by Proof Writer for this document.`;
    await expect(lean.assertOwned(dir, doc)).rejects.toThrow(refusal);
    await expect(lean.ensureProject(dir, lake, env, doc)).rejects.toThrow(refusal);
    expect(readdirSync(dir)).toEqual(['thesis.tex']);
  });

  it('refuses a folder made for another document that shares it', async () => {
    const { root, doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    const other = join(root, 'stlc.json');
    expect(lean.leanDir(other)).toBe(dir);
    await expect(lean.assertOwned(dir, other)).rejects.toThrow(/was not created by Proof Writer for this document/);
    await expect(lean.ensureProject(dir, lake, env, other)).rejects.toThrow(/was not created by Proof Writer for this document/);
    expect(readFileSync(join(dir, '.proof-writer'), 'utf8').trim()).toBe('stlc.proof.json');
  });

  it('takes over a folder the user renamed along with its document', async () => {
    const { root, doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    const renamed = join(root, 'calculus.proof.json');
    const moved = lean.leanDir(renamed);
    await rm(moved, { recursive: true, force: true });
    const { renameSync } = await import('node:fs');
    renameSync(dir, moved);
    await expect(lean.assertOwned(moved, renamed)).resolves.toBeUndefined();
    expect(readFileSync(join(moved, '.proof-writer'), 'utf8').trim()).toBe(basename(renamed));
  });

  it('marks a folder an earlier version made, which has a status file and no marker', async () => {
    const { doc, dir } = setup();
    await lean.writeStatus(dir, { version: 1, blocks: {}, proposals: [] });
    mkdirSync(join(dir, 'PW'));
    await expect(lean.assertOwned(dir, doc)).resolves.toBeUndefined();
    expect(readFileSync(join(dir, '.proof-writer'), 'utf8').trim()).toBe('stlc.proof.json');
  });

  it('stops a build on request, and says it was cancelled', async () => {
    const { doc, dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    const started = Date.now();
    const built = await lean.runBuild({ dir, lake, env: { ...env, FAKE_LAKE: 'hang' }, onStart: (stop: () => void) => setTimeout(stop, 150) });
    expect(built).toMatchObject({ started: true, code: null, cancelled: true });
    expect(Date.now() - started).toBeLessThan(3000);
    const timedOut = await lean.runBuild({ dir, lake, env: { ...env, FAKE_LAKE: 'hang' }, limitMs: 150 });
    expect(timedOut.cancelled).toBeUndefined();
    expect(timedOut.output).toMatch(/time limit/);
  });

  it('kills a job that ignores being asked to stop', async () => {
    const { doc, dir, lake, env, claude } = setup();
    await lean.ensureProject(dir, lake, env, doc);
    const run = lean.runClaude({ claude, dir, prompt: 'x', args: args(), env: { ...env, FAKE_CLAUDE: 'stubborn' } });
    await new Promise((r) => setTimeout(r, 400));
    const pid = Number(readFileSync(join(dir, 'stubborn.pid'), 'utf8'));
    run.cancel();
    expect(await run.done).toMatchObject({ ok: false, cancelled: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
