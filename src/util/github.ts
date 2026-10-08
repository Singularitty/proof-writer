// Minimal GitHub REST client for opening and committing documents from the browser.
// Public repositories work without a token; private ones and commits need a
// personal access token, which is kept only in this browser's storage.

export interface RepoRef { owner: string; repo: string; branch?: string; path?: string }
export interface GitHubSource { owner: string; repo: string; branch: string; path: string; sha?: string }
export interface RepoFile { path: string; size: number }

const TOKEN_KEY = 'proof-writer:github-token';
const LAST_REPO_KEY = 'proof-writer:github-repo';

export const githubToken = {
  get: (): string => { try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; } },
  set: (t: string) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
};
export const lastRepo = {
  get: (): string => { try { return localStorage.getItem(LAST_REPO_KEY) ?? ''; } catch { return ''; } },
  set: (r: string) => { try { localStorage.setItem(LAST_REPO_KEY, r); } catch { /* ignore */ } },
};

/** Accepts "owner/repo", "github.com/owner/repo", and …/tree/<branch>/<dir> or …/blob/<branch>/<file> URLs. */
export function parseRepo(input: string): RepoRef | null {
  let s = input.trim().replace(/^git@github\.com:/, 'github.com/').replace(/\.git$/, '');
  s = s.replace(/^https?:\/\//, '').replace(/^(www\.)?github\.com\//, '');
  const raw = /^raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(s);
  if (raw) return { owner: raw[1], repo: raw[2], branch: raw[3], path: decodeURIComponent(raw[4]) };
  const m = /^([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+))?)?\/?$/.exec(s);
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[3], path: m[4] ? decodeURIComponent(m[4].replace(/\/$/, '')) : undefined };
}

export class GitHubError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = githubToken.get();
  const res = await fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = ((await res.json()) as { message?: string }).message ?? msg; } catch { /* ignore */ }
    if (res.status === 404) msg = token ? 'Not found (check the name, or that your token can read this repository)' : 'Not found. If the repository is private, add a token.';
    if (res.status === 401) msg = 'The token was rejected. Check it or create a new one.';
    if (res.status === 403 && /rate limit/i.test(msg)) msg = 'GitHub rate limit reached. Add a token to raise it.';
    throw new GitHubError(msg, res.status);
  }
  return res.json() as Promise<T>;
}

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export async function defaultBranch(owner: string, repo: string): Promise<string> {
  const r = await api<{ default_branch: string }>(`/repos/${owner}/${repo}`);
  return r.default_branch;
}

export async function listBranches(owner: string, repo: string): Promise<string[]> {
  const r = await api<{ name: string }[]>(`/repos/${owner}/${repo}/branches?per_page=100`);
  return r.map((b) => b.name);
}

/** All .json and .typ files on a branch. */
export async function listDocFiles(owner: string, repo: string, branch: string): Promise<RepoFile[]> {
  const r = await api<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>(
    `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  return r.tree
    .filter((t) => t.type === 'blob' && /\.(json|typ)$/i.test(t.path) && !/(^|\/)(package(-lock)?|tsconfig[\w.]*|node_modules\/.*)\.json$/i.test(t.path) && !t.path.includes('node_modules/'))
    .map((t) => ({ path: t.path, size: t.size ?? 0 }));
}

function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function getFile(src: Omit<GitHubSource, 'sha'>): Promise<{ text: string; sha: string }> {
  const r = await api<{ content?: string; encoding?: string; sha: string; download_url?: string; type: string }>(
    `/repos/${src.owner}/${src.repo}/contents/${enc(src.path)}?ref=${encodeURIComponent(src.branch)}`,
  );
  if (r.type !== 'file') throw new GitHubError(`${src.path} is not a file`, 400);
  // Files over 1 MB come without inline content.
  if (!r.content && r.download_url) return { text: await (await fetch(r.download_url)).text(), sha: r.sha };
  return { text: fromBase64(r.content ?? ''), sha: r.sha };
}

/** Sha of the file currently at `path`, or undefined when it doesn't exist. */
async function currentSha(src: Omit<GitHubSource, 'sha'>): Promise<string | undefined> {
  try {
    const r = await api<{ sha: string }>(`/repos/${src.owner}/${src.repo}/contents/${enc(src.path)}?ref=${encodeURIComponent(src.branch)}`);
    return r.sha;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return undefined;
    throw e;
  }
}

/**
 * Commits `text` to the file. `expectedSha` is the version this document was opened
 * from; if the file changed since, GitHub rejects the commit (409) instead of overwriting.
 */
export async function commitFile(src: Omit<GitHubSource, 'sha'>, text: string, message: string, expectedSha?: string): Promise<{ sha: string; url: string }> {
  const sha = expectedSha ?? (await currentSha(src));
  const r = await api<{ content: { sha: string; html_url: string } }>(`/repos/${src.owner}/${src.repo}/contents/${enc(src.path)}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: toBase64(text), branch: src.branch, ...(sha ? { sha } : {}) }),
  }).catch((e) => {
    if (e instanceof GitHubError && (e.status === 409 || e.status === 422) && expectedSha) {
      throw new GitHubError('The file changed on GitHub since you opened it. Open it again, or commit to a different path.', 409);
    }
    throw e;
  });
  return { sha: r.content.sha, url: r.content.html_url };
}
