import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNodeVersion, parseClaudeVersion, parseAuthStatus, compareVersions, checkNode, parseConnectionTest,
  detectBrowsers, browserCandidates, extensionRow, linkedinRow,
} from '../lib/preflight.mjs';

test('parseNodeVersion handles the usual shapes', () => {
  assert.deepEqual(parseNodeVersion('v20.11.1'), { major: 20, minor: 11, patch: 1, raw: '20.11.1' });
  assert.equal(parseNodeVersion('18.0.0').major, 18);
  assert.equal(parseNodeVersion('nonsense'), null);
  assert.equal(parseNodeVersion(''), null);
});

test('checkNode passes 18+ and fails older versions with a hint', () => {
  assert.equal(checkNode('v18.0.0').status, 'ok');
  assert.equal(checkNode('v22.1.0').status, 'ok');
  const old = checkNode('v16.20.2');
  assert.equal(old.status, 'fail');
  assert.match(old.hint, /nodejs\.org/);
  assert.equal(checkNode('garbage').status, 'fail');
});

test('parseClaudeVersion and compareVersions', () => {
  assert.equal(parseClaudeVersion('2.1.284 (Claude Code)'), '2.1.284');
  assert.equal(parseClaudeVersion('command not found'), null);
  assert.equal(compareVersions('1.0.36', '1.0.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
});

test('parseAuthStatus: claude.ai subscription is ok', () => {
  const r = parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'someone@example.com', subscriptionType: 'max' }));
  assert.equal(r.state, 'ok');
  assert.equal(r.plan, 'max');
  assert.ok(!JSON.stringify(r).includes('someone@example.com'), 'the email is never carried forward');
});

test('parseAuthStatus: API key, third party, logged out and unknown', () => {
  assert.equal(parseAuthStatus('{"loggedIn":true,"authMethod":"api_key"}').state, 'api-key');
  assert.equal(parseAuthStatus('{"loggedIn":true,"authMethod":"ANTHROPIC_API_KEY"}').state, 'api-key');
  assert.equal(parseAuthStatus('{"loggedIn":true,"authMethod":"oauth_token"}').state, 'api-key');
  assert.equal(parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"bedrock"}').state, 'third-party');
  assert.equal(parseAuthStatus('{"loggedIn":false}').state, 'logged-out');
  assert.equal(parseAuthStatus('Not logged in. Run claude auth login').state, 'logged-out');
  assert.equal(parseAuthStatus('').state, 'unknown');
  assert.equal(parseAuthStatus('{"loggedIn":true}').state, 'ok');
});

test('parseAuthStatus tolerates log noise around the JSON', () => {
  const r = parseAuthStatus('warning: something\n{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}\n');
  assert.equal(r.state, 'ok');
});

test('parseConnectionTest recognises CONNECTED and failure shapes', () => {
  assert.deepEqual(parseConnectionTest({ stdout: JSON.stringify({ result: 'CONNECTED', is_error: false }), stderr: '' }), { ok: true, reason: 'ok' });
  assert.equal(parseConnectionTest({ stdout: JSON.stringify({ result: 'FAILED' }) }).ok, false);
  assert.equal(parseConnectionTest({ stdout: 'NOT CONNECTED' }).ok, false);
  assert.equal(parseConnectionTest({ stdout: '', stderr: 'Browser extension is not connected' }).reason, 'not-connected');
  assert.equal(parseConnectionTest({ timedOut: true, stdout: '' }).reason, 'timeout');
  assert.equal(parseConnectionTest({ notFound: true, stdout: '' }).reason, 'claude-missing');
});

test('browser detection works per OS with an injected filesystem', () => {
  const win = detectBrowsers({ platform: 'win32', env: { PROGRAMFILES: 'C:\\PF', 'PROGRAMFILES(X86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\L' }, home: 'C:\\U', exists: (p) => p.endsWith('msedge.exe') });
  assert.equal(win[0].name, 'Microsoft Edge');
  const mac = detectBrowsers({ platform: 'darwin', home: '/Users/a', exists: (p) => p.includes('Google Chrome.app/Contents/MacOS') });
  assert.equal(mac[0].name, 'Google Chrome');
  const none = detectBrowsers({ platform: 'linux', exists: () => false });
  assert.deepEqual(none, []);
  assert.ok(browserCandidates('linux').some((c) => c.path.endsWith('chromium')));
});

test('extension and LinkedIn rows reflect saved state', () => {
  assert.equal(extensionRow(null).status, 'pending');
  assert.equal(extensionRow({ ok: true, at: 'x' }).status, 'ok');
  const failed = extensionRow({ ok: false, reason: 'not-connected' });
  assert.equal(failed.status, 'fail');
  assert.match(failed.hint, /Chrome Web Store/);
  assert.match(failed.hint, /open Chrome again/);
  assert.equal(linkedinRow({}).status, 'pending');
  assert.equal(linkedinRow({ linkedinConfirmed: true }).status, 'ok');
});
