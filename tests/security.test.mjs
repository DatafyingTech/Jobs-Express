import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { tempStore } from './helpers.mjs';

async function boot() {
  const t = tempStore();
  const app = createApp({ store: t.store, preflight: async () => ({ rows: [], ready: true }) });
  const port = await app.listen(0);
  /** A raw request, so tests can set any Host, Origin or cookie they like. */
  const raw = (method, path, headers = {}, body) => new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('request timed out')));
    if (body !== undefined) req.write(body);
    req.end();
  });
  const good = { 'x-cja': '1', 'x-cja-token': app.token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
  return { ...t, app, port, raw, good, close: async () => { await app.close(); t.cleanup(); } };
}

// --- DNS rebinding ---------------------------------------------------------------------------

test('Host header: only 127.0.0.1, localhost or [::1] on the server\'s own port is answered', async () => {
  const s = await boot();
  const p = s.port;
  for (const host of [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`, `LOCALHOST:${p}`]) {
    assert.equal((await s.raw('GET', '/api/health', { host })).status, 200, host);
  }
  for (const host of [
    'evil.example.com', `evil.example.com:${p}`, `127.0.0.1.evil.com:${p}`, `localhost.evil.com:${p}`, `evil.com:${p}@127.0.0.1:${p}`,
    '127.0.0.1', 'localhost', `127.0.0.1:${p + 1}`, `localhost:${p + 1}`, '127.0.0.1:80', `0.0.0.0:${p}`, `192.168.1.5:${p}`,
  ]) {
    assert.equal((await s.raw('GET', '/api/health', { host })).status, 403, `Host "${host}" must be refused`);
    assert.equal((await s.raw('GET', '/', { host })).status, 403, `page with Host "${host}" must be refused`);
  }
  await s.close();
});

// --- per-launch token ----------------------------------------------------------------------------

test('the token is random per launch and arrives with the page, in a cookie and in the HTML', async () => {
  const a = await boot();
  const b = await boot();
  assert.match(a.app.token, /^[0-9a-f]{64}$/);
  assert.notEqual(a.app.token, b.app.token);
  const page = await a.raw('GET', '/');
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(`content="${a.app.token}"`), 'token is embedded in the page');
  assert.ok(!page.text.includes('__CJA_TOKEN__'), 'placeholder was replaced');
  const cookie = [].concat(page.headers['set-cookie'] || []).join(';');
  assert.match(cookie, new RegExp(`cja_token=${a.app.token}`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const css = await a.raw('GET', '/app.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers['set-cookie'], undefined, 'only the page sets the cookie');
  await a.close();
  await b.close();
});

test('every API route except /api/health needs the token (header or cookie)', async () => {
  const s = await boot();
  for (const path of ['/api/state', '/api/profile', '/api/applications', '/api/applications.csv', '/api/held', '/api/run', '/api/preflight', '/api/schedule', '/api/digests', '/api/setup', '/api/events']) {
    const no = await s.raw('GET', path);
    assert.equal(no.status, 403, `${path} without a token`);
    assert.equal(no.json?.code, 'token');
    assert.equal((await s.raw('GET', path, { 'x-cja-token': 'wrong' })).status, 403, `${path} with a wrong token`);
    assert.equal((await s.raw('GET', path, { 'x-cja-token': s.app.token.slice(0, 10) })).status, 403, `${path} with a short token`);
  }
  assert.equal((await s.raw('GET', '/api/health')).status, 200);
  assert.equal((await s.raw('GET', '/api/state', { 'x-cja-token': s.app.token })).status, 200);
  assert.equal((await s.raw('GET', '/api/state', { cookie: `a=b; cja_token=${s.app.token}` })).status, 200);
  assert.equal((await s.raw('GET', '/api/state', { cookie: 'cja_token=nope' })).status, 403);
  await s.close();
});

test('POST, PUT and DELETE are refused without the token even with X-CJA and a right Origin', async () => {
  const s = await boot();
  const noToken = { ...s.good };
  delete noToken['x-cja-token'];
  const cases = [
    ['PUT', '/api/profile', '{}'], ['POST', '/api/run/start', '{"mode":"practice"}'], ['POST', '/api/run/stop', '{}'],
    ['POST', '/api/held/answer', '{}'], ['POST', '/api/open', '{"target":"linkedin"}'], ['POST', '/api/resume', 'x'],
    ['PUT', '/api/schedule', '{}'], ['DELETE', '/api/schedule', undefined], ['POST', '/api/schedule/test', '{"confirm":true}'],
    ['POST', '/api/setup/install', '{"confirm":true}'], ['POST', '/api/setup/login', '{}'],
  ];
  for (const [m, p, b] of cases) {
    const r = await s.raw(m, p, noToken, b);
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  assert.equal(s.app.runner.active, false, 'no agents were started');
  await s.close();
});

test('a malicious website cannot start agents: wrong or missing Origin is refused even with the token', async () => {
  const s = await boot();
  const evilHeaders = [
    { origin: 'https://evil.example.com' },
    { origin: 'null' },
    { origin: `http://127.0.0.1:${s.port + 1}` },
    { origin: `http://localhost.evil.com:${s.port}` },
    { origin: `https://127.0.0.1:${s.port}` },
    { origin: undefined, 'sec-fetch-site': 'cross-site' },
    { origin: undefined, 'sec-fetch-site': 'same-site' },
  ];
  for (const extra of evilHeaders) {
    const r = await s.raw('POST', '/api/run/start', { ...s.good, ...extra }, '{"mode":"practice"}');
    assert.equal(r.status, 403, JSON.stringify(extra));
    const put = await s.raw('PUT', '/api/profile', { ...s.good, ...extra }, '{"about":{"fullName":"Mallory"}}');
    assert.equal(put.status, 403, JSON.stringify(extra));
  }
  const state = await s.raw('GET', '/api/profile', { 'x-cja-token': s.app.token });
  assert.equal(state.json.about.fullName, '', 'nothing was written');
  assert.equal(s.app.runner.active, false);
  await s.close();
});

test('same-origin requests, with or without an Origin header, are accepted', async () => {
  const s = await boot();
  const p = s.port;
  for (const origin of [`http://127.0.0.1:${p}`, `http://localhost:${p}`]) {
    const r = await s.raw('PUT', '/api/profile', { ...s.good, origin }, '{"about":{"fullName":"Alex"}}');
    assert.equal(r.status, 200, origin);
  }
  // curl and Node have no Origin; a browser would add Sec-Fetch-Site: same-origin.
  assert.equal((await s.raw('PUT', '/api/profile', { ...s.good, origin: undefined }, '{"about":{"fullName":"Alex B"}}')).status, 200);
  assert.equal((await s.raw('PUT', '/api/profile', { ...s.good, origin: undefined, 'sec-fetch-site': 'same-origin' }, '{}')).status, 200);
  await s.close();
});

test('the X-CJA header is still required on writes', async () => {
  const s = await boot();
  const h = { ...s.good };
  delete h['x-cja'];
  assert.equal((await s.raw('PUT', '/api/profile', h, '{}')).status, 403);
  await s.close();
});

test('the live event stream needs the token and does not leak to other origins', async () => {
  const s = await boot();
  assert.equal((await s.raw('GET', '/api/events')).status, 403);
  assert.equal((await s.raw('GET', '/api/events', { host: 'evil.com' })).status, 403);
  const open = (headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/events', headers: { host: `127.0.0.1:${s.port}`, ...headers } }, (res) => {
      res.destroy();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(await open({ 'x-cja-token': s.app.token }), 200);
  assert.equal(await open({ cookie: `cja_token=${s.app.token}` }), 200);
  await s.close();
});

test('no CORS: the server never sends Access-Control-* headers, and preflights get nothing', async () => {
  const s = await boot();
  const responses = [
    await s.raw('GET', '/', { origin: 'https://evil.example.com' }),
    await s.raw('GET', '/api/health', { origin: 'https://evil.example.com' }),
    await s.raw('GET', '/api/state', { origin: 'https://evil.example.com', 'x-cja-token': s.app.token }),
    await s.raw('GET', '/api/state', { origin: 'https://evil.example.com' }),
    await s.raw('POST', '/api/run/stop', { ...s.good, origin: 'https://evil.example.com' }, '{}'),
    await s.raw('OPTIONS', '/api/profile', { origin: 'https://evil.example.com', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'x-cja,x-cja-token,content-type' }),
    await s.raw('OPTIONS', '/', { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' }),
  ];
  for (const r of responses) {
    for (const k of Object.keys(r.headers)) assert.ok(!k.startsWith('access-control-'), `unexpected ${k}`);
  }
  const preflight = responses[5];
  assert.ok(preflight.status >= 400, 'a preflight is not approved');
  await s.close();
});

test('API and page responses carry the hardening headers', async () => {
  const s = await boot();
  const page = await s.raw('GET', '/');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['cross-origin-resource-policy'], 'same-origin');
  const api = await s.raw('GET', '/api/state', { 'x-cja-token': s.app.token });
  assert.equal(api.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(api.headers['x-content-type-options'], 'nosniff');
  assert.equal(api.headers['cache-control'], 'no-store');
  await s.close();
});

test('the CSV download works with the cookie the page set, and not without it', async () => {
  const s = await boot();
  assert.equal((await s.raw('GET', '/api/applications.csv')).status, 403);
  assert.equal((await s.raw('GET', '/api/applications.csv', { cookie: `cja_token=${s.app.token}` })).status, 200);
  await s.close();
});
