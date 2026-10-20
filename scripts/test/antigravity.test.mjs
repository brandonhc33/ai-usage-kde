import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import {
  antigravityIdentity, discoverAntigravityServers, fetchAntigravityLocal,
  mapAntigravityUsage, portsFromProcTables, requestAntigravity,
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
