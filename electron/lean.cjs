// Mechanizing a document in Lean: the Lake project beside the document, the
// headless Claude Code run that writes its Lean files, and the build that
// says what compiled. What the results mean is decided in src/lean; this file
// only finds the programs, keeps the project's fixed files, and runs things.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const JOB_LIMIT_MS = 30 * 60 * 1000;
const BUILD_LIMIT_MS = 10 * 60 * 1000;
const WINDOWS = process.platform === 'win32';

const LAKEFILE = `name = "PW"
version = "0.1.0"
defaultTargets = ["PW"]

[[lean_lib]]
name = "PW"
`;

const CONVENTIONS = `# Conventions for this mechanization

This file is yours. Proof Writer creates it once and never changes it; the
agent reads it after its standing instructions in CLAUDE.md.

Write here how you want this document mechanized, for example:

- how variables and binders are represented (de Bruijn indices, names, ...)
- how typing contexts are represented (lists, functions, ...)
- naming, or Lean style you prefer
`;

/** The Lean folder of a document: `stlc.proof.json` and `stlc.json` both give `stlc-lean` beside them. */
function leanDir(docPath) {
  const base = path.basename(docPath).replace(/\.json$/i, '').replace(/\.proof$/i, '');
  return path.join(path.dirname(docPath), `${base}-lean`);
}

// A packaged app is not started from a shell, so its PATH lacks the places
// these tools are usually installed to.
const SYSTEM_DIRS = WINDOWS ? [] : ['/usr/local/bin', '/opt/homebrew/bin'];

function searchPath({ env = process.env, home = os.homedir(), system = SYSTEM_DIRS } = {}) {
  const extra = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.elan', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    ...(WINDOWS && env.APPDATA ? [path.join(env.APPDATA, 'npm')] : []),
    ...system,
  ];
  return [...(env.PATH ?? '').split(path.delimiter), ...extra].filter(Boolean);
}

async function findTool(name, opts) {
  for (const dir of searchPath(opts)) {
    for (const ext of WINDOWS ? ['.exe', '.cmd'] : ['']) {
      const p = path.join(dir, name + ext);
      try {
        await fs.access(p, constants.X_OK);
        if ((await fs.stat(p)).isFile()) return p;
      } catch { /* not here */ }
    }
  }
  return null;
}

async function findTools(opts) {
  return { claude: await findTool('claude', opts), lake: await findTool('lake', opts) };
}

/** An environment in which a job finds `lake`, and Lake finds `lean`. */
function childEnv(tools, opts = {}) {
  const first = [tools.lake, tools.claude].filter(Boolean).map((p) => path.dirname(p));
  return { ...(opts.env ?? process.env), PATH: [...new Set([...first, ...searchPath(opts)])].join(path.delimiter) };
}

/** The toolchain to pin: the one `lake` runs now, so the project keeps building after an update. */
function toolchain(lake, env) {
  return new Promise((resolve) => {
    execFile(lake, ['--version'], { env, shell: WINDOWS }, (err, stdout) => {
      const m = err ? null : /Lean version ([0-9][^\s,)]*)/.exec(String(stdout));
      resolve(`leanprover/lean4:${m ? 'v' + m[1] : 'stable'}`);
    });
  });
}

async function writeIfMissing(file, text) {
  try { await fs.writeFile(file, text, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

/** Makes the Lean folder a Lake project, creating only what is not there. */
async function ensureProject(dir, lake, env) {
  await fs.mkdir(path.join(dir, 'PW'), { recursive: true });
  await writeIfMissing(path.join(dir, 'lakefile.toml'), LAKEFILE);
  if (!(await exists(path.join(dir, 'lean-toolchain')))) await writeIfMissing(path.join(dir, 'lean-toolchain'), (await toolchain(lake, env)) + '\n');
  await writeIfMissing(path.join(dir, '.gitignore'), '.lake/\n');
  await writeIfMissing(path.join(dir, 'CONVENTIONS.md'), CONVENTIONS);
}

/** The Lean files under PW/, definitions first, as paths relative to the folder. */
async function leanFiles(dir) {
  let names = [];
  try { names = await fs.readdir(path.join(dir, 'PW')); } catch { /* no PW yet */ }
  return names
    .filter((n) => n.endsWith('.lean'))
    .sort((a, b) => (a === 'Defs.lean' ? -1 : b === 'Defs.lean' ? 1 : a.localeCompare(b)))
    .map((n) => `PW/${n}`);
}

/** Writes PW.lean to import every module there is, so a build covers them all. */
async function writeRoot(dir) {
  const files = await leanFiles(dir);
  await fs.writeFile(path.join(dir, 'PW.lean'), files.map((f) => `import PW.${path.basename(f, '.lean')}\n`).join(''));
  return files;
}

/** Puts back the files that make the folder a project, leaving PW/ as it is. */
async function recreateProject(dir, lake, env) {
  await fs.mkdir(path.join(dir, 'PW'), { recursive: true });
  await fs.writeFile(path.join(dir, 'lakefile.toml'), LAKEFILE);
  await fs.writeFile(path.join(dir, 'lean-toolchain'), (await toolchain(lake, env)) + '\n');
  await writeRoot(dir);
}

/**
 * Writes the agent's standing instructions as CLAUDE.md, for sessions the
 * user opens in the folder, and returns them with the user's conventions
 * appended: a job runs in restricted mode, which does not read CLAUDE.md, so
 * it is given the text directly.
 */
async function writeInstructions(dir) {
  const text = await fs.readFile(path.join(__dirname, 'lean-instructions.md'), 'utf8');
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), text);
  let conventions = '';
  try { conventions = await fs.readFile(path.join(dir, 'CONVENTIONS.md'), 'utf8'); } catch { /* none */ }
  return `${text}\n\n# CONVENTIONS.md\n\n${conventions}`;
}

async function writeSnapshot(dir, { json, md }) {
  await fs.writeFile(path.join(dir, 'document.json'), json);
  await fs.writeFile(path.join(dir, 'document.md'), md);
}

/**
 * The command line of a job. Restricted mode confines the file tools to the
 * Lean folder and ignores the user's settings and plugins; the allow list
 * lets Bash run Lake and nothing else; with nobody to answer a permission
 * prompt, anything else is refused.
 */
function claudeArgs({ model, effort, schema, instructions }) {
  if (model && !MODELS.includes(model)) throw new Error(`Unknown model: ${model}`);
  if (effort && !EFFORTS.includes(effort)) throw new Error(`Unknown effort: ${effort}`);
  return [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--restricted', '--strict-mcp-config', '--no-session-persistence',
    '--permission-prompts', 'none',
    '--tools', 'Bash,Read,Edit,Write,Glob,Grep',
    '--allowedTools', 'Bash(lake build)', 'Bash(lake build *)', 'Bash(lake env lean *)', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    '--json-schema', JSON.stringify(schema),
    '--append-system-prompt', instructions,
  ];
}

/** What to show for one event of the stream: the files written and the commands run. */
function activity(event, dir) {
  if (event?.type !== 'assistant' || !Array.isArray(event.message?.content)) return [];
  const rel = (p) => {
    if (typeof p !== 'string') return '';
    const r = path.relative(dir, p);
    return r.startsWith('..') ? path.basename(p) : r.split(path.sep).join('/');
  };
  const lines = [];
  for (const c of event.message.content) {
    if (c?.type !== 'tool_use') continue;
    const input = c.input ?? {};
    if (c.name === 'Write') lines.push(`wrote ${rel(input.file_path)}`);
    else if (c.name === 'Edit') lines.push(`edited ${rel(input.file_path)}`);
    else if (c.name === 'Read') lines.push(`read ${rel(input.file_path)}`);
    else if (c.name === 'Bash') lines.push(String(input.command ?? '').slice(0, 120));
    else if (c.name === 'StructuredOutput') lines.push('writing the report');
  }
  return lines;
}

/** Starts a job. `done` never rejects; `cancel` stops the job. */
function runClaude({ claude, dir, prompt, args, env, onLine = () => {}, limitMs = JOB_LIMIT_MS }) {
  const child = spawn(claude, args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], shell: WINDOWS });
  let cancelled = false;
  let timedOut = false;
  let result = null;
  let buffer = '';
  let stderr = '';
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, limitMs);

  // The stream is one JSON object per line, but a chunk may end mid-line and
  // a line may not be JSON at all (a warning printed by something underneath).
  const take = (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type === 'result') result = event;
    for (const l of activity(event, dir)) onLine(l);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      take(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });

  const done = new Promise((resolve) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, report: null, cancelled: false, error: `Could not start claude: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      take(buffer);
      if (cancelled) resolve({ ok: false, report: null, cancelled: true, error: 'Cancelled.' });
      else if (timedOut) resolve({ ok: false, report: null, cancelled: false, error: 'Stopped: the job ran past its time limit.' });
      else if (!result) resolve({ ok: false, report: null, cancelled: false, error: stderr.trim().split('\n').pop() || `claude exited with code ${code}` });
      else if (result.is_error) resolve({ ok: false, report: result.structured_output ?? null, cancelled: false, error: (typeof result.result === 'string' && result.result) || 'The run ended with an error.' });
      else resolve({ ok: true, report: result.structured_output ?? null, cancelled: false });
    });
  });
  child.stdin.on('error', () => { /* the process went away before reading the prompt; `close` reports it */ });
  child.stdin.end(prompt);
  return { done, cancel: () => { cancelled = true; child.kill(); } };
}

/** Runs `lake build` and returns what it printed with the Lean files as they now are. */
async function runBuild({ dir, lake, env, limitMs = BUILD_LIMIT_MS }) {
  const paths = await writeRoot(dir);
  const ran = await new Promise((resolve) => {
    let output = '';
    const child = spawn(lake, ['build'], { cwd: dir, env, shell: WINDOWS });
    const timer = setTimeout(() => child.kill(), limitMs);
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ started: false, code: null, output: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ started: true, code, output }); });
  });
  const files = [];
  for (const p of paths) files.push({ path: p, text: await fs.readFile(path.join(dir, p), 'utf8') });
  return { ...ran, files };
}

/** What mechanization.json holds, or null if it is missing or not JSON. */
async function readStatus(dir) {
  try { return JSON.parse(await fs.readFile(path.join(dir, 'mechanization.json'), 'utf8')); } catch { return null; }
}

/** Replaces mechanization.json in one step, so a crash never leaves half a file. */
async function writeStatus(dir, status) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'mechanization.json');
  await fs.writeFile(file + '.tmp', JSON.stringify(status, null, 2));
  await fs.rename(file + '.tmp', file);
}

module.exports = {
  MODELS, EFFORTS, leanDir, findTool, findTools, childEnv, ensureProject, recreateProject,
  writeInstructions, writeSnapshot, claudeArgs, runClaude, runBuild, readStatus, writeStatus,
};
