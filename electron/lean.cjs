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
const KILL_GRACE_MS = 2000;
// Only a file named like a Lean identifier can be imported; any other name
// in PW/ would break the build of every module if PW.lean imported it.
const MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_']*$/;
const isModuleName = (v) => typeof v === 'string' && MODULE_NAME.test(v);
const isModuleFile = (n) => n.endsWith('.lean') && isModuleName(n.slice(0, -'.lean'.length));
/** Says, by naming the document, that Proof Writer made the folder it is in. */
const OWNER_FILE = '.proof-writer';

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

/**
 * The toolchain to pin: the one `lake` runs now, so the project keeps building
 * after an update. Only a release or a release candidate has a name of this
 * form; a nightly or a local build is named otherwise, so `stable` stands in.
 */
function toolchain(lake, env) {
  return new Promise((resolve) => {
    execFile(lake, ['--version'], { env, shell: WINDOWS }, (err, stdout) => {
      const m = err ? null : /Lean version ([^\s,)]+)/.exec(String(stdout));
      resolve(`leanprover/lean4:${m && /^\d+\.\d+\.\d+(-rc\d+)?$/.test(m[1]) ? 'v' + m[1] : 'stable'}`);
    });
  });
}

async function writeIfMissing(file, text) {
  try { await fs.writeFile(file, text, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

/**
 * Refuses a folder that is in the Lean folder's place without being it: the
 * app writes, builds and moves files to the trash there, which it must not do
 * to a folder of the user's that happens to have the name. A folder is the
 * document's if it is not there yet or is empty, if its owner file names the
 * document, or if it has a status file and no owner file (made before owner
 * files were written; it is then given one).
 *
 * An owner file naming another document refuses only when that document would
 * share this folder (`stlc.json` and `stlc.proof.json` both have `stlc-lean`).
 * Otherwise the user renamed the document and the folder together, which is
 * how a mechanization is kept across a rename, and the owner file is brought
 * up to date.
 */
async function assertOwned(dir, docPath) {
  const name = path.basename(docPath);
  const file = path.join(dir, OWNER_FILE);
  const claim = () => fs.writeFile(file, name + '\n');
  let entries;
  try { entries = await fs.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (!entries.length) return;
  let owner = null;
  try { owner = (await fs.readFile(file, 'utf8')).trim(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (owner === name) return;
  if (owner === null ? entries.includes('mechanization.json') : path.basename(leanDir(owner)) !== path.basename(dir)) return claim();
  throw new Error(`${dir} already exists and was not created by Proof Writer for this document.`);
}

/** Makes the Lean folder a Lake project, creating only what is not there. */
async function ensureProject(dir, lake, env, docPath) {
  await assertOwned(dir, docPath);
  await fs.mkdir(path.join(dir, 'PW'), { recursive: true });
  await writeIfMissing(path.join(dir, OWNER_FILE), path.basename(docPath) + '\n');
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
    .filter(isModuleFile)
    .sort((a, b) => (a === 'Defs.lean' ? -1 : b === 'Defs.lean' ? 1 : a.localeCompare(b)))
    .map((n) => `PW/${n}`);
}

/**
 * Writes PW.lean, the root a build starts from, and returns the Lean files
 * there are. For the app's own build it imports every module there is, so the
 * build covers them all. For a job it is given the modules the document's
 * statements need, and imports those and Defs: the files are not written yet,
 * and the agent's own `lake build` should check what the app's will.
 */
async function writeRoot(dir, modules) {
  const files = await leanFiles(dir);
  if (modules && !modules.every(isModuleName)) throw new Error('Not a Lean module name.');
  const names = modules ? ['Defs', ...modules] : files.map((f) => path.basename(f, '.lean'));
  await fs.writeFile(path.join(dir, 'PW.lean'), names.map((n) => `import PW.${n}\n`).join(''));
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

async function textOrNull(file) {
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}

/** What a job may change and what it may not, as they are now: every Lean file under PW/ and the user's conventions. */
async function readSources(dir) {
  let names = [];
  try { names = await fs.readdir(path.join(dir, 'PW')); } catch { /* no PW yet */ }
  const files = new Map();
  for (const n of names.filter((x) => x.endsWith('.lean')).sort()) {
    const text = await textOrNull(path.join(dir, 'PW', n));
    if (text !== null) files.set(`PW/${n}`, text);
  }
  return { files, conventions: await textOrNull(path.join(dir, 'CONVENTIONS.md')) };
}

/**
 * The Lean files under PW/ created, changed or deleted since `before` was
 * read, as paths relative to the folder. CONVENTIONS.md is the user's: if it
 * changed it is put back as it was, and listed too.
 */
async function touchedSince(dir, before) {
  const now = await readSources(dir);
  const touched = [...new Set([...before.files.keys(), ...now.files.keys()])].filter((p) => before.files.get(p) !== now.files.get(p)).sort();
  if (now.conventions !== before.conventions) {
    touched.push('CONVENTIONS.md');
    const file = path.join(dir, 'CONVENTIONS.md');
    try {
      if (before.conventions === null) await fs.rm(file, { force: true });
      else await fs.writeFile(file, before.conventions);
    } catch { /* it is reported as changed either way */ }
  }
  return touched;
}

/**
 * The command line of a job. Restricted mode confines the file tools to the
 * Lean folder and ignores the user's settings and plugins; the allow list
 * lets Bash run `lake build` and nothing else; with nobody to answer a
 * permission prompt, anything else is refused. `lake env lean` is left out on
 * purpose: `lean -o <path>` writes outside the folder and `lean --run` runs a
 * program.
 */
function claudeArgs({ model, effort, schema, instructions }) {
  if (model && !MODELS.includes(model)) throw new Error(`Unknown model: ${model}`);
  if (effort && !EFFORTS.includes(effort)) throw new Error(`Unknown effort: ${effort}`);
  return [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--restricted', '--strict-mcp-config', '--no-session-persistence',
    '--permission-prompts', 'none',
    '--tools', 'Bash,Read,Edit,Write,Glob,Grep',
    '--allowedTools', 'Bash(lake build)', 'Bash(lake build *)', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
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

/**
 * Sends a signal to a program and what it started. Off Windows the program
 * leads its own process group (see `detached` where it is spawned), so the
 * whole group gets the signal; otherwise a `lean` started by `lake` would
 * outlive it.
 */
function signal(child, name) {
  if (!WINDOWS && child.pid) {
    try { process.kill(-child.pid, name); return; } catch { /* fall back to the child alone */ }
  }
  try { child.kill(name); } catch { /* it has gone */ }
}

/**
 * Stops a program and what it started: asks first, and after a short grace
 * kills whatever of its group is left. The caller stops waiting after the
 * same grace and goes on to build or to read the Lean files, which a process
 * that ignored the request must not still be writing.
 */
function stop(child) {
  signal(child, 'SIGTERM');
  setTimeout(() => signal(child, 'SIGKILL'), KILL_GRACE_MS);
}

/**
 * The programs running now. They lead their own process groups, so quitting
 * the app would not take them along; `stopAll` is how the app ends them.
 */
const running = new Set();

function stopAll() {
  for (const child of running) stop(child);
}

/** Starts a job. `done` never rejects; `cancel` stops the job. */
function runClaude({ claude, dir, prompt, args, env, onLine = () => {}, limitMs = JOB_LIMIT_MS }) {
  const child = spawn(claude, args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], shell: WINDOWS, detached: !WINDOWS });
  running.add(child);
  let cancelled = false;
  let timedOut = false;
  let result = null;
  let buffer = '';
  let stderr = '';
  let settle = () => {};
  let grace = null;
  // A process the job started may hold the output pipes open, so `close` can
  // be late or never come: after the kill, give up waiting for it.
  const halt = () => {
    stop(child);
    // set after `stop` set its own timer of the same length, so the kill comes first
    grace = setTimeout(() => settle('late'), KILL_GRACE_MS);
  };
  const timer = setTimeout(() => { timedOut = true; halt(); }, limitMs);

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
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      running.delete(child);
      clearTimeout(timer);
      clearTimeout(grace);
      resolve(value);
    };
    settle = () => finish(
      cancelled ? { ok: false, report: null, cancelled: true, error: 'Cancelled.' }
        : { ok: false, report: null, cancelled: false, error: 'Stopped: the job ran past its time limit.' });
    child.on('error', (err) => {
      finish({ ok: false, report: null, cancelled: false, error: `Could not start claude: ${err.message}` });
    });
    child.on('close', (code) => {
      take(buffer);
      if (cancelled || timedOut) settle();
      else if (!result) finish({ ok: false, report: null, cancelled: false, error: stderr.trim().split('\n').pop() || `claude exited with code ${code}` });
      else if (result.is_error) finish({ ok: false, report: result.structured_output ?? null, cancelled: false, error: (typeof result.result === 'string' && result.result) || 'The run ended with an error.' });
      else finish({ ok: true, report: result.structured_output ?? null, cancelled: false });
    });
  });
  child.stdin.on('error', () => { /* the process went away before reading the prompt; `close` reports it */ });
  child.stdin.end(prompt);
  return { done, cancel: () => { if (cancelled) return; cancelled = true; halt(); } };
}

/**
 * Removes the Lean files whose module is neither Defs nor wanted; returns
 * those it removed. Names are compared without regard to case: on a file
 * system that ignores it (macOS's default), a statement relabelled only in
 * case still has its old file, which the agent reuses.
 */
async function removeStale(dir, keep, remove) {
  const removed = [];
  const kept = new Set(['defs', ...keep.map((k) => k.toLowerCase())]);
  for (const p of await leanFiles(dir)) {
    if (kept.has(path.basename(p, '.lean').toLowerCase())) continue;
    try { await remove(path.join(dir, p)); removed.push(p); } catch { /* leave it; the build does not depend on it */ }
  }
  return removed.sort();
}

/**
 * Runs `lake build` and returns what it printed with the Lean files as they
 * now are. Given `keep` (module names), first removes the other modules the
 * document no longer has, except Defs. The lakefile and PW.lean are the
 * app's and are written afresh each time, so nothing done to them can make a
 * build that builds less than every module. `onStart` is handed a function
 * that stops the build. A build that was stopped, or ran past its limit, has
 * `code: null` whatever Lake managed to exit with: it did not check everything.
 */
async function runBuild({ dir, lake, env, limitMs = BUILD_LIMIT_MS, keep, remove = (p) => fs.rm(p), onStart = () => {} }) {
  const removed = keep ? await removeStale(dir, keep, remove) : [];
  await fs.writeFile(path.join(dir, 'lakefile.toml'), LAKEFILE);
  const paths = await writeRoot(dir);
  const ran = await new Promise((resolve) => {
    let output = '';
    let settled = false;
    let grace = null;
    let stopped = null;
    const child = spawn(lake, ['build'], { cwd: dir, env, shell: WINDOWS, detached: !WINDOWS });
    running.add(child);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      running.delete(child);
      clearTimeout(timer);
      clearTimeout(grace);
      resolve(value);
    };
    const cut = () => finish(stopped === 'cancelled'
      ? { started: true, code: null, output, cancelled: true }
      : { started: true, code: null, output: output + '\nStopped: the build ran past its time limit.' });
    // Lean processes Lake started may keep the pipes open after the kill, so
    // do not wait for `close` past a short grace.
    const halt = (why) => {
      if (stopped || settled) return;
      stopped = why;
      stop(child);
      grace = setTimeout(cut, KILL_GRACE_MS);
    };
    const timer = setTimeout(() => halt('limit'), limitMs);
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    child.on('error', (err) => finish({ started: false, code: null, output: err.message }));
    child.on('close', (code) => { if (stopped) cut(); else finish({ started: true, code, output }); });
    onStart(() => halt('cancelled'));
  });
  const files = [];
  for (const p of paths) files.push({ path: p, text: await fs.readFile(path.join(dir, p), 'utf8') });
  return { ...ran, files, removed };
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
  MODELS, EFFORTS, leanDir, findTool, findTools, childEnv, isModuleName, assertOwned, ensureProject, recreateProject,
  writeRoot, writeInstructions, writeSnapshot, readSources, touchedSince, claudeArgs, runClaude, runBuild, stopAll,
  readStatus, writeStatus,
};
