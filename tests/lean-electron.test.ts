import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
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
if (process.argv[2] === '--version') { console.log('Lake version 5.0.0-src (Lean version 4.22.0)'); process.exit(0); }
console.log("error: ././././PW/Defs.lean:2:0: unknown identifier 'x'");
console.error('error: build failed');
process.exitCode = 1;
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
  const dir = lean.leanDir(join(root, 'stlc.proof.json'));
  return { root, bin, env, dir, claude: join(bin, 'claude'), lake: join(bin, 'lake') };
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
    const { dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env);
    expect(readFileSync(join(dir, 'lakefile.toml'), 'utf8')).toContain('name = "PW"');
    expect(readFileSync(join(dir, 'lean-toolchain'), 'utf8').trim()).toBe('leanprover/lean4:v4.22.0');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.lake');
    expect(existsSync(join(dir, 'PW'))).toBe(true);
    writeFileSync(join(dir, 'CONVENTIONS.md'), 'Use de Bruijn indices.');
    writeFileSync(join(dir, 'lean-toolchain'), 'leanprover/lean4:v4.20.0\n');
    await lean.ensureProject(dir, lake, env);
    expect(readFileSync(join(dir, 'CONVENTIONS.md'), 'utf8')).toBe('Use de Bruijn indices.');
    expect(readFileSync(join(dir, 'lean-toolchain'), 'utf8').trim()).toBe('leanprover/lean4:v4.20.0');
  });

  it('rewrites CLAUDE.md before a job and hands back both instruction files', async () => {
    const { dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env);
    writeFileSync(join(dir, 'CLAUDE.md'), 'tampered');
    writeFileSync(join(dir, 'CONVENTIONS.md'), 'Use de Bruijn indices.');
    const text = await lean.writeInstructions(dir);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('-- pw:');
    expect(text).toContain('-- pw:');
    expect(text).toContain('Use de Bruijn indices.');
  });

  it('recreates the project files without touching PW/', async () => {
    const { dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env);
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
    const { dir, lake, env, claude } = setup();
    await lean.ensureProject(dir, lake, env);
    const lines: string[] = [];
    const run = lean.runClaude({ claude, dir, prompt: 'Job: sync.', args: args(), env, onLine: (l: string) => lines.push(l) });
    expect(await run.done).toEqual({ ok: true, report: { outcome: 'done', summary: 'ok' }, cancelled: false });
    expect(lines).toEqual(['wrote PW/Defs.lean', 'lake build']);
    expect(readFileSync(join(dir, 'prompt.txt'), 'utf8')).toBe('Job: sync.');
    expect(JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'))).toEqual(args());
  });

  it('reports a run that ends without a report, with the CLI’s last words', async () => {
    const { dir, lake, env, claude } = setup();
    await lean.ensureProject(dir, lake, env);
    const run = lean.runClaude({ claude, dir, prompt: 'x', args: args(), env: { ...env, FAKE_CLAUDE: 'noreport' } });
    expect(await run.done).toEqual({ ok: false, report: null, cancelled: false, error: 'Not logged in' });
  });

  it('reports a run the CLI marks as an error', async () => {
    const { dir, lake, env, claude } = setup();
    await lean.ensureProject(dir, lake, env);
    const run = lean.runClaude({ claude, dir, prompt: 'x', args: args(), env: { ...env, FAKE_CLAUDE: 'error' } });
    expect(await run.done).toMatchObject({ ok: false, cancelled: false, error: 'Credit balance is too low' });
  });

  it('cancels a running job, and stops one that runs past its limit', async () => {
    const { dir, lake, env, claude } = setup();
    await lean.ensureProject(dir, lake, env);
    const hang = { ...env, FAKE_CLAUDE: 'hang' };
    const run = lean.runClaude({ claude, dir, prompt: 'x', args: args(), env: hang });
    setTimeout(() => run.cancel(), 150);
    expect(await run.done).toMatchObject({ ok: false, cancelled: true });
    const slow = lean.runClaude({ claude, dir, prompt: 'x', args: args(), env: hang, limitMs: 150 });
    expect(await slow.done).toMatchObject({ ok: false, cancelled: false, error: expect.stringMatching(/time limit/) });
  });

  it('says so when claude cannot be started', async () => {
    const { dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env);
    const run = lean.runClaude({ claude: join(dir, 'no-such-claude'), dir, prompt: 'x', args: args(), env });
    expect(await run.done).toMatchObject({ ok: false, error: expect.stringMatching(/Could not start/) });
  });

  it('builds, returning Lake’s output and the Lean files, and keeps PW.lean in step', async () => {
    const { dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env);
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

  it('says a build did not start when lake is missing', async () => {
    const { dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env);
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
    const { dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env);
    await lean.writeSnapshot(dir, { json: '{"version":1}', md: '# Doc' });
    expect(readFileSync(join(dir, 'document.json'), 'utf8')).toBe('{"version":1}');
    expect(readFileSync(join(dir, 'document.md'), 'utf8')).toBe('# Doc');
  });
});
