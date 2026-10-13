// Version control for the open folder, through the git installed on the system.
// Nothing here knows about accounts or keys: pulling and pushing go the way they
// do in a terminal, over whatever the repository's remote and the user's SSH
// setup say.
const { execFile } = require('node:child_process');

const SSH_HINT = '\n\nGit could not sign in to the remote. Check that pushing works from a terminal in this folder; a key with a passphrase has to be loaded in the ssh-agent first, because the app cannot ask for it.';

/** Runs git in `cwd` and resolves to what it printed. It is never asked a question: one it would ask fails instead. */
function git(cwd, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
    execFile('git', args, { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') return reject(Object.assign(new Error('Git is not installed, or not on the PATH.'), { missing: true }));
      if (err.killed) return reject(new Error('Git took too long and was stopped.'));
      const said = (stderr || stdout || err.message).trim();
      reject(new Error(/Permission denied \(|Host key verification failed|terminal prompts disabled|Could not read from remote repository/i.test(said) ? said + SSH_HINT : said));
    });
  });
}

/** Reads `git status --porcelain=v2 --branch -z`. Paths are relative to the top of the repository. */
function parseStatus(text) {
  const out = { branch: '', upstream: '', ahead: 0, behind: 0, files: [] };
  const records = text.split('\0');
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const rest = (fields) => r.split(' ').slice(fields).join(' ');
    if (r.startsWith('# branch.head ')) out.branch = r.slice(14);
    else if (r.startsWith('# branch.upstream ')) out.upstream = r.slice(18);
    else if (r.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(r); if (m) { out.ahead = +m[1]; out.behind = +m[2]; } }
    else if (r.startsWith('? ')) out.files.push({ path: r.slice(2), state: 'new' });
    else if (r.startsWith('u ')) out.files.push({ path: rest(10), state: 'conflict' });
    else if (r.startsWith('1 ')) {
      const xy = r.slice(2, 4);
      out.files.push({ path: rest(8), state: xy.includes('D') ? 'deleted' : xy[0] === 'A' ? 'new' : 'modified' });
    } else if (r.startsWith('2 ')) out.files.push({ path: rest(9), from: records[++i], state: 'renamed' });
  }
  return out;
}

/** What git says of the folder: its branch, how it stands against the remote, and what has changed inside the folder. */
async function status(root) {
  if (!root) return { repo: false };
  let top;
  try { top = (await git(root, ['rev-parse', '--show-toplevel'])).trim(); } catch (e) { return { repo: false, missing: !!e.missing }; }
  const s = parseStatus(await git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--', '.']));
  const remotes = (await git(root, ['remote'])).split('\n').filter(Boolean);
  return { repo: true, top, remote: remotes.includes('origin') ? 'origin' : remotes[0] ?? '', ...s };
}

/** Commits the given changed files (paths as `status` reports them), and only those. */
async function commit(root, message, paths) {
  if (!String(message ?? '').trim()) throw new Error('A commit needs a message.');
  const s = await status(root);
  if (!s.repo) throw new Error('This folder is not a git repository.');
  // only what status reported: nothing outside the open folder can be named
  const chosen = s.files.filter((f) => paths.includes(f.path));
  if (!chosen.length) throw new Error('Nothing is selected to commit.');
  const now = chosen.map((f) => f.path);
  await git(s.top, ['--literal-pathspecs', 'add', '-A', '--', ...now]);
  await git(s.top, ['--literal-pathspecs', 'commit', '-m', String(message).trim(), '--', ...now, ...chosen.filter((f) => f.from).map((f) => f.from)]);
  return status(root);
}

/** Brings in the remote's commits, when that needs no merge. */
async function pull(root) {
  await git(root, ['pull', '--ff-only'], 120000);
  return status(root);
}

/** Sends the branch to its remote; a branch that has none yet is given one of the same name. */
async function push(root) {
  const s = await status(root);
  if (!s.repo) throw new Error('This folder is not a git repository.');
  if (!s.upstream && !s.remote) throw new Error('This repository has no remote to push to. Add one with "git remote add origin …" in a terminal.');
  await git(root, s.upstream ? ['push'] : ['push', '-u', s.remote, 'HEAD'], 120000);
  return status(root);
}

module.exports = { parseStatus, status, commit, pull, push };
