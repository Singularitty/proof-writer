import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const { signIn } = createRequire(import.meta.url)('../electron/github.cjs');

type Answer = { status?: number; body: unknown };
/** A GitHub that gives these answers in turn, and remembers what it was asked. */
function fakeGitHub(answers: Answer[]) {
  const asked: { url: string; body: Record<string, string> }[] = [];
  const fetch = async (url: string, init: { body: string }) => {
    asked.push({ url, body: JSON.parse(init.body) });
    const a = answers.shift()!;
    const status = a.status ?? 200;
    return { ok: status < 400, status, json: async () => { if (a.body === undefined) throw new Error('no body'); return a.body; } };
  };
  const waits: number[] = [];
  const wait = async (ms: number) => { waits.push(ms); };
  return { fetch, wait, asked, waits };
}
const code = { device_code: 'dev', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };

describe('signing in to GitHub', () => {
  it('shows the code, then asks until the token comes', async () => {
    const gh = fakeGitHub([{ body: code }, { body: { error: 'authorization_pending' } }, { body: { access_token: 'gho_x' } }]);
    const shown: unknown[] = [];
    const token = await signIn({ clientId: 'Iv1.abc', onCode: (c: unknown) => shown.push(c), fetch: gh.fetch, wait: gh.wait });
    expect(token).toBe('gho_x');
    expect(shown).toEqual([{ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' }]);
    expect(gh.asked[0]).toEqual({ url: 'https://github.com/login/device/code', body: { client_id: 'Iv1.abc', scope: 'repo' } });
    expect(gh.asked[1].url).toBe('https://github.com/login/oauth/access_token');
    expect(gh.asked[1].body).toMatchObject({ client_id: 'Iv1.abc', device_code: 'dev' });
    expect(gh.waits).toEqual([5000, 5000]);
  });

  it('asks less often when told to slow down', async () => {
    const gh = fakeGitHub([{ body: code }, { body: { error: 'slow_down', interval: 10 } }, { body: { access_token: 't' } }]);
    await signIn({ clientId: 'c', fetch: gh.fetch, wait: gh.wait });
    expect(gh.waits).toEqual([5000, 10000]);
  });

  it('says why when GitHub refuses', async () => {
    const refused = fakeGitHub([{ body: code }, { body: { error: 'access_denied' } }]);
    await expect(signIn({ clientId: 'c', fetch: refused.fetch, wait: refused.wait })).rejects.toThrow('refused on GitHub');
    const off = fakeGitHub([{ body: { error: 'device_flow_disabled' } }]);
    await expect(signIn({ clientId: 'c', fetch: off.fetch, wait: off.wait })).rejects.toThrow('device flow turned off');
    const unknown = fakeGitHub([{ status: 404, body: undefined }]);
    await expect(signIn({ clientId: 'c', fetch: unknown.fetch, wait: unknown.wait })).rejects.toThrow('does not know');
  });

  it('gives up when the code runs out', async () => {
    const gh = fakeGitHub([{ body: { ...code, expires_in: 10 } }, { body: { error: 'authorization_pending' } }, { body: { error: 'authorization_pending' } }]);
    await expect(signIn({ clientId: 'c', fetch: gh.fetch, wait: gh.wait })).rejects.toThrow('ran out');
    expect(gh.asked.length).toBe(3);
  });

  it('stops when cancelled', async () => {
    const gh = fakeGitHub([{ body: code }]);
    const ac = new AbortController();
    const going = signIn({ clientId: 'c', fetch: gh.fetch, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(going).rejects.toThrow('cancelled');
    expect(gh.asked.length).toBe(1);
  });
});
