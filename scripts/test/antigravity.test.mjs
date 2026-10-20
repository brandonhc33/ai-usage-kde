import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import {
  antigravityIdentity, discoverAntigravityServers, fetchAntigravity, fetchAntigravityCli,
  fetchAntigravityLocal, mapAntigravityCliUsage, mapAntigravityUsage, portsFromProcTables,
  readAntigravityCli, requestAntigravity, resolveAntigravityCli,
} from '../lib/antigravity.mjs';

const now = new Date('2026-10-19T15:00:00Z');
function user(email = 'one@example.test') {
  return { userStatus: { email, planStatus: { planInfo: { planDisplayName: 'Google AI Pro' } },
    cascadeModelConfigData: { clientModelConfigs: [
      { label: 'Gemini Pro', modelOrAlias: { model: 'gemini-pro' }, quotaInfo: { remainingFraction: 0.7, resetTime: '2026-10-19T20:00:00Z' } },
      { label: 'Gemini Flash', modelOrAlias: { model: 'gemini-flash' }, quotaInfo: { remainingFraction: 0.8 } },
      { label: 'Claude Sonnet', modelOrAlias: { model: 'claude-sonnet' }, quotaInfo: { remainingFraction: 1 } },
    ] } } };
}
const summary = { response: { groups: [
  { displayName: 'Gemini', buckets: [
    { bucketId: 'gemini-5h', displayName: 'Session', remaining: { remainingFraction: 0.75 }, resetTime: '2026-10-19T20:00:00Z' },
    { bucketId: 'gemini-weekly', displayName: 'Weekly', remaining: { remainingFraction: 0.25 } },
  ] },
  { displayName: 'Claude + GPT', buckets: [
    { bucketId: '3p-5h', displayName: 'Session', remaining: { remainingFraction: 0 } },
    { bucketId: '3p-weekly', displayName: 'Weekly', remaining: { case: 'remainingFraction', value: 0.5 } },
  ] },
] } };

test('maps measured session and weekly quotas and preserves an exhausted zero fraction', () => {
  const result = mapAntigravityUsage(user(), summary, now);
  assert.equal(result.source, 'antigravity-local');
  assert.equal(result.plan_type, 'Google AI Pro');
  assert.equal(result.quota_windows.length, 4);
  assert.deepEqual(result.quota_windows.map((w) => w.metric.used_percent), [25, 75, 100, 50]);
  assert.equal(result.quota.used_percent, 100);
  assert.equal(result.session.used_percent, 100);
  assert.equal(result.weekly.used_percent, 75);
  assert.equal(result.quota_windows[0].metric.reset_epoch, 1792440000);
  assert.equal(result.identity, antigravityIdentity('ONE@example.test'));
});

test('legacy model quotas do not invent a weekly or five-hour duration', () => {
  const result = mapAntigravityUsage(user(), null, now);
  assert.equal(result.weekly, null);
  assert.equal(result.session, null);
  assert.equal(result.quota.used_percent, 30);
  assert.deepEqual(result.quota_windows.map((w) => w.label), ['Gemini', 'Claude + GPT']);
  assert.equal(result.model_quotas.length, 3);
});

test('missing utilization stays unavailable instead of appearing exhausted', () => {
  const result = mapAntigravityUsage({ userStatus: { email: 'one@example.test' } }, {
    groups: [{ displayName: 'Gemini', buckets: [{ bucketId: 'gemini-weekly', resetTime: '2026-10-20T00:00:00Z' }] }],
  }, now);
  assert.equal(result.quota, null);
  assert.equal(result.quota_windows[0].metric.used_percent, null);
  assert.equal(result.quota_windows[0].metric.remaining_percent, null);
  assert.equal(result.quota_windows[0].metric.state, 'unavailable');
  assert.throws(() => mapAntigravityUsage({ userStatus: {} }, summary), { code: 'login_required' });
});

test('the connector matches the selected identity and refuses a different active Google account', async () => {
  const dependencies = {
    discover: async () => [{ port: 1 }, { port: 2 }],
    request: async (endpoint, method) => method === 'GetUserStatus'
      ? user(endpoint.port === 1 ? 'other@example.test' : 'selected@example.test') : summary,
  };
  const result = await fetchAntigravityLocal({ identity: antigravityIdentity('selected@example.test') }, dependencies);
  assert.equal(result.account_email, 'selected@example.test');
  await assert.rejects(fetchAntigravityLocal({ identity: antigravityIdentity('absent@example.test') }, dependencies), { code: 'account_mismatch' });
  await assert.rejects(fetchAntigravityLocal({}, dependencies), { code: 'account_selection_required' });
});

test('a stopped app returns an actionable state and no request is sent', async () => {
  await assert.rejects(fetchAntigravityLocal({}, {
    discover: async () => [], request: async () => { assert.fail('No listener should be called'); },
  }), { code: 'app_not_running' });
});

test('loopback quota requests use only read endpoints, redact CSRF and reject malformed or slow responses', async (t) => {
  let hits = 0;
  let mode = 'good';
  const server = http.createServer((req, res) => {
    hits++;
    assert.equal(req.headers['x-codeium-csrf-token'], 'private-test-csrf');
    assert.equal(req.method, 'POST');
    if (mode === 'slow') return;
    if (mode === 'malformed') return res.end('invalid private-test-csrf');
    if (req.url.endsWith('GetUserStatus')) res.end(JSON.stringify(user()));
    else if (req.url.endsWith('RetrieveUserQuotaSummary')) res.end(JSON.stringify(summary));
    else { res.statusCode = 404; res.end('{}'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const endpoint = { port: server.address().port, scheme: 'http', csrfToken: 'private-test-csrf' };
  const result = await fetchAntigravityLocal({}, { discover: async () => [endpoint] });
  assert.equal(result.quota.used_percent, 100);
  assert.equal(hits, 2);
  assert.doesNotMatch(JSON.stringify(result), /private-test-csrf|csrfToken/);
  await assert.rejects(requestAntigravity(endpoint, 'SendPrompt'), { code: 'config_error' });
  assert.equal(hits, 2);
  mode = 'malformed';
  await assert.rejects(requestAntigravity(endpoint, 'GetUserStatus'), { code: 'invalid_response' });
  mode = 'slow';
  await assert.rejects(requestAntigravity(endpoint, 'GetUserStatus', 25), { code: 'source_unavailable' });
});

test('process discovery scopes listeners to the same-user Antigravity process and its socket inodes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const processDir = path.join(root, '123');
  await fs.mkdir(path.join(processDir, 'fd'), { recursive: true });
  await fs.mkdir(path.join(processDir, 'net'));
  await fs.writeFile(path.join(processDir, 'cmdline'), '/opt/antigravity/language_server\0--csrf_token\0private-test-csrf\0');
  await fs.symlink('socket:[100]', path.join(processDir, 'fd/4'));
  const table = 'sl local_address rem_address st tx_queue tr retrnsmt uid timeout inode\n'
    + '0: 0100007F:1234 00000000:0000 0A 0:0 0:0 0 1000 0 100\n'
    + '1: 0100007F:5678 00000000:0000 0A 0:0 0:0 0 1000 0 999\n';
  await fs.writeFile(path.join(processDir, 'net/tcp'), table);
  const servers = await discoverAntigravityServers(root);
  assert.equal(servers.length, 2);
  assert.equal(servers[0].port, 0x1234);
  assert.equal(servers[0].csrfToken, 'private-test-csrf');
  assert.deepEqual(portsFromProcTables([table], new Set(['999'])), [0x5678]);
});

function cliPayload(fractions = { gemini: 0.75, thirdParty: 1 }) {
  const bucket = (id, fraction) => ({ id, name: 'Weekly Limit Remaining', window: 'weekly',
    ...(fraction === undefined ? {} : { remaining_fraction: fraction }), reset_time: '2026-10-26T15:00:00Z' });
  return { status: 'SUCCESS', conversation_id: '',
    response: 'Gemini Models\tWeekly Limit Remaining\t0%\t2026-10-26T15:00:00Z\n',
    command: { name: 'usage', data: { groups: [
      { name: 'Gemini Models', buckets: [bucket('gemini-weekly', fractions.gemini)] },
      { name: 'Claude and GPT models', buckets: [bucket('3p-weekly', fractions.thirdParty)] },
    ] } } };
}

test('maps agy /usage pools, treats an untouched quota as not started and recovers an omitted zero', () => {
  const result = mapAntigravityCliUsage(cliPayload(), 'one@example.test', now);
  assert.equal(result.source, 'antigravity-cli');
  assert.equal(result.identity, antigravityIdentity('one@example.test'));
  assert.deepEqual(result.quota_windows.map((w) => w.label), ['Gemini · Semanal', 'Claude + GPT · Semanal']);
  assert.equal(result.weekly.used_percent, 25);
  assert.equal(result.quota_windows[0].metric.reset_epoch, Date.parse('2026-10-26T15:00:00Z') / 1000);
  // A full quota's reset is a moving "now + 7 days", not a real deadline.
  assert.deepEqual(result.quota_windows[1].metric,
    { used_percent: 0, remaining_percent: 100, reset_epoch: null, reset_label: null, state: 'idle' });
  const exhausted = mapAntigravityCliUsage(cliPayload({ gemini: undefined, thirdParty: undefined }), 'one@example.test', now);
  assert.equal(exhausted.quota_windows[0].metric.used_percent, 100);
  assert.equal(exhausted.quota_windows[1].metric.state, 'unavailable');
  assert.throws(() => mapAntigravityCliUsage({ status: 'ERROR', error: 'authentication failed or timed out' }, null),
    { code: 'login_required' });
  assert.throws(() => mapAntigravityCliUsage({ status: 'SUCCESS', command: {} }, 'one@example.test'), { code: 'invalid_response' });
});

test('the CLI source needs the signed-in account and refuses a different one', async () => {
  const read = (email) => async () => ({ payload: cliPayload(), email });
  const resolve = async () => '/fake/agy';
  const config = { identity: antigravityIdentity('selected@example.test') };
  const result = await fetchAntigravityCli(config, { resolve, read: read('selected@example.test') });
  assert.equal(result.account_email, 'selected@example.test');
  await assert.rejects(fetchAntigravityCli(config, { resolve, read: read('other@example.test') }), { code: 'account_mismatch' });
  await assert.rejects(fetchAntigravityCli({}, { resolve, read: read(null) }), { code: 'invalid_response' });
  await assert.rejects(resolveAntigravityCli({ cli_path: '/nonexistent/agy' }), { code: 'cli_missing' });
});

test('the CLI goes first; the app is the fallback and a closed app reports the CLI problem', async () => {
  const cliSnapshot = { source: 'antigravity-cli' };
  const appSnapshot = { source: 'antigravity-local' };
  const failing = (code) => async () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(await fetchAntigravity({}, { cli: async () => cliSnapshot, app: () => assert.fail('app not needed') }), cliSnapshot);
  assert.equal(await fetchAntigravity({}, { cli: failing('account_mismatch'), app: async () => appSnapshot }), appSnapshot);
  await assert.rejects(fetchAntigravity({}, { cli: failing('cli_missing'), app: failing('app_not_running') }), { code: 'cli_missing' });
  await assert.rejects(fetchAntigravity({}, { cli: failing('cli_missing'), app: failing('account_mismatch') }), { code: 'account_mismatch' });
});

test('agy runs without any way to open a browser and stops at a sign-in prompt', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-agy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'environment');
  const fake = async (body) => {
    const file = path.join(root, `agy-${Math.random().toString(36).slice(2)}`);
    await fs.writeFile(file, `#!/bin/sh
echo "$(command -v xdg-open) $BROWSER \${DISPLAY:-none} \${WAYLAND_DISPLAY:-none}" > ${marker}
${body}
`, { mode: 0o700 });
    return file;
  };
  const work = path.join(root, 'work');
  const signedIn = await fake(`echo 'I1 OAuth: authenticated successfully as One@Example.test' > "$6"
printf '%s' '${JSON.stringify(cliPayload())}'`);
  const result = await readAntigravityCli(signedIn, 5000, work);
  assert.equal(result.email, 'one@example.test');
  assert.equal(result.payload.status, 'SUCCESS');
  const [opener, browser, display, wayland] = (await fs.readFile(marker, 'utf8')).trim().split(' ');
  assert.ok(opener.startsWith(`${work}/agy-`) && opener === browser, opener);
  assert.deepEqual([display, wayland], ['none', 'none']);
  assert.deepEqual(await fs.readdir(work), []);

  const started = Date.now();
  const signedOut = await fake(`echo 'Authentication required. Please visit the URL to log in:' >&2
xdg-open https://accounts.example.test
exec sleep 30`);
  await assert.rejects(readAntigravityCli(signedOut, 10_000, work), { code: 'login_required' });
  assert.ok(Date.now() - started < 5000);
  await assert.rejects(readAntigravityCli(await fake('exec sleep 30'), 200, work), { code: 'source_unavailable' });
  assert.deepEqual(await fs.readdir(work), []);
});
