import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = createRequire(import.meta.url)('../electron/git.cjs');

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/** A repository with one commit, and a remote for it on disk. */
function repo() {
  const base = mkdtempSync(join(tmpdir(), 'pw-git-'));
  const remote = join(base, 'remote.git');
  const work = join(base, 'work');
  sh(base, 'init', '-q', '--bare', '-b', 'main', remote);
  sh(base, 'init', '-q', '-b', 'main', work);
  for (const [k, v] of [['user.name', 'Test'], ['user.email', 'test@example.com'], ['commit.gpgsign', 'false']]) sh(work, 'config', k, v);
  sh(work, 'remote', 'add', 'origin', remote);
  mkdirSync(join(work, 'docs'));
  writeFileSync(join(work, 'docs', 'a.proof.json'), '{"a":1}');
  writeFileSync(join(work, 'outside.txt'), 'x');
  sh(work, 'add', '-A');
  sh(work, 'commit', '-q', '-m', 'first');
  return { base, remote, work, docs: join(work, 'docs') };
}
const names = (s: { files: { path: string; state: string }[] }) => s.files.map((f) => `${f.state}:${f.path}`).sort();

describe('parseStatus', () => {
  it('reads the branch, its remote and each kind of change', () => {
    const text = [
      '# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb docs/with space.json',
      '1 A. N... 000000 100644 100644 000 bbb added.json',
      '1 .D N... 100644 100644 000000 aaa aaa gone.json',
      '2 R. N... 100644 100644 100644 aaa aaa R100 new name.json', 'old name.json',
      'u UU N... 100644 100644 100644 100644 a b c both.json',
      '? fresh.json', '',
    ].join('\0');
    expect(git.parseStatus(text)).toEqual({
      branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1,
      files: [
        { path: 'docs/with space.json', state: 'modified' },
        { path: 'added.json', state: 'new' },
        { path: 'gone.json', state: 'deleted' },
        { path: 'new name.json', from: 'old name.json', state: 'renamed' },
        { path: 'both.json', state: 'conflict' },
        { path: 'fresh.json', state: 'new' },
      ],
    });
  });
});

describe('git in the open folder', () => {
  it('says when a folder is not a repository', async () => {
    expect((await git.status(mkdtempSync(join(tmpdir(), 'pw-plain-')))).repo).toBe(false);
    expect((await git.status(null)).repo).toBe(false);
  });

  it('reports the changes inside the folder, and not those beside it', async () => {
    const r = repo();
    writeFileSync(join(r.docs, 'a.proof.json'), '{"a":2}');
    writeFileSync(join(r.docs, 'b.proof.json'), '{}');
    writeFileSync(join(r.work, 'outside.txt'), 'changed');
    const s = await git.status(r.docs);
    expect(s).toMatchObject({ repo: true, branch: 'main', upstream: '', remote: 'origin' });
    expect(names(s)).toEqual(['modified:docs/a.proof.json', 'new:docs/b.proof.json']);
  });

  it('commits the chosen files only', async () => {
    const r = repo();
    writeFileSync(join(r.docs, 'a.proof.json'), '{"a":2}');
    writeFileSync(join(r.docs, 'b.proof.json'), '{}');
    writeFileSync(join(r.work, 'outside.txt'), 'changed');
    sh(r.work, 'add', 'outside.txt'); // staged by hand, and not ours to commit
    const after = await git.commit(r.docs, 'Update a', ['docs/a.proof.json', 'outside.txt']);
    expect(names(after)).toEqual(['new:docs/b.proof.json']);
    expect(sh(r.work, 'show', '--name-only', '--format=%s', 'HEAD').trim().split('\n')).toEqual(['Update a', '', 'docs/a.proof.json']);
    expect(sh(r.work, 'status', '--porcelain')).toContain('M  outside.txt');
  });

  it('commits a deleted file, and refuses an empty message or selection', async () => {
    const r = repo();
    rmSync(join(r.docs, 'a.proof.json'));
    await expect(git.commit(r.docs, '  ', ['docs/a.proof.json'])).rejects.toThrow('needs a message');
    await expect(git.commit(r.docs, 'x', ['nothing.json'])).rejects.toThrow('Nothing is selected');
    expect(names(await git.commit(r.docs, 'Remove a', ['docs/a.proof.json']))).toEqual([]);
    expect(sh(r.work, 'ls-files')).not.toContain('a.proof.json');
  });

  it('pushes a new branch to the remote, then pulls what someone else pushed', async () => {
    const r = repo();
    const pushed = await git.push(r.docs);
    expect(pushed).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0 });
    // someone else clones, commits and pushes
    const other = join(r.base, 'other');
    sh(r.base, 'clone', '-q', r.remote, other);
    for (const [k, v] of [['user.name', 'Other'], ['user.email', 'other@example.com'], ['commit.gpgsign', 'false']]) sh(other, 'config', k, v);
    writeFileSync(join(other, 'docs', 'a.proof.json'), '{"a":"theirs"}');
    sh(other, 'commit', '-q', '-am', 'theirs');
    sh(other, 'push', '-q');
    sh(r.work, 'fetch', '-q');
    expect(await git.status(r.docs)).toMatchObject({ ahead: 0, behind: 1 });
    await git.pull(r.docs);
    expect(readFileSync(join(r.docs, 'a.proof.json'), 'utf8')).toBe('{"a":"theirs"}');
  });

  it('says so when there is nowhere to push', async () => {
    const r = repo();
    sh(r.work, 'remote', 'remove', 'origin');
    await expect(git.push(r.docs)).rejects.toThrow('no remote');
  });
});
