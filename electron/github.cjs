// Signing in to GitHub with the device flow: the app shows a short code, the user
// enters it on github.com, and the app asks until GitHub hands over a token. It
// runs here and not in the page because GitHub does not let web pages call these
// two addresses. Nothing in it is secret: an OAuth app's client ID is public.

const CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

const MESSAGES = {
  access_denied: 'The sign-in was refused on GitHub.',
  expired_token: 'The code ran out before it was entered. Sign in again for a new one.',
  device_flow_disabled: 'Signing in is not set up: the app\'s GitHub OAuth app has the device flow turned off.',
  incorrect_client_credentials: 'Signing in is not set up: GitHub does not know this app\'s client ID.',
};
const failure = (d) => new Error(MESSAGES[d.error] ?? d.error_description ?? String(d.error));

/** Waits, giving up at once when the signal fires. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(t); reject(new Error('cancelled')); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

async function post(fetchFn, url, body, signal) {
  const res = await fetchFn(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  let data = {};
  try { data = await res.json(); } catch { /* an answer that is not JSON carries no reason */ }
  if (!res.ok && !data.error) {
    if (res.status === 404) throw failure({ error: 'incorrect_client_credentials' });
    throw new Error(`GitHub answered ${res.status}.`);
  }
  return data;
}

/**
 * Signs in and resolves to an access token. `onCode` is given the code to enter and
 * where; the rest is waiting. `fetch` and `wait` can be replaced to test it.
 */
async function signIn({ clientId, scope = 'repo', onCode, signal, fetch: fetchFn = fetch, wait = sleep }) {
  const d = await post(fetchFn, CODE_URL, { client_id: clientId, scope }, signal);
  if (d.error || !d.device_code) throw failure(d.error ? d : { error: 'GitHub sent no code.' });
  onCode?.({ userCode: d.user_code, verificationUri: d.verification_uri });
  let every = (d.interval ?? 5) * 1000;
  for (let left = (d.expires_in ?? 900) * 1000; left > 0; left -= every) {
    await wait(every, signal);
    const r = await post(fetchFn, TOKEN_URL, { client_id: clientId, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, signal);
    if (r.access_token) return r.access_token;
    // asked too often: GitHub says how long to leave between questions from now on
    if (r.error === 'slow_down') every = (r.interval ?? every / 1000 + 5) * 1000;
    else if (r.error !== 'authorization_pending') throw failure(r);
  }
  throw failure({ error: 'expired_token' });
}

module.exports = { signIn, sleep };
