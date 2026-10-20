import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEFAULT_CONFIG, normalizeConfig } from '../lib/accounts.mjs';

const manager = fileURLToPath(new URL('../ai-usage-accounts.mjs', import.meta.url));
const collector = fileURLToPath(new URL('../ai-usage-collect.mjs', import.meta.url));

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-accounts-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const configFile = path.join(home, '.config/ai-usage-status/config.json');
  const cache = path.join(home, '.cache/ai-usage-status');
  const config = { ...DEFAULT_CONFIG, accounts: [] };
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(configFile, JSON.stringify(config));
  const env = { ...process.env, HOME: home, AI_USAGE_STRUCTURED_ONLY: '1' };
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  const json = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
  const run = (script, args = [], moreEnv = {}) => spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', env: { ...env, ...moreEnv }, timeout: 15_000,
  });
  const account = (...args) => {
    const result = run(manager, args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { home, configFile, cache, config, env, run, account, json };
}

test('migrates enabled legacy providers and preserves custom source paths', () => {
  const config = normalizeConfig({ providers: {
    codex: { enabled: false },
    claude: { source: 'oauth', oauth_credentials_file: '/custom/work.json' },
  } });
  assert.equal(config.accounts.length, 1);
  assert.equal(config.accounts[0].id, 'claude-default');
  assert.equal(config.accounts[0].managed, false);
  assert.equal(config.accounts[0].config.oauth_credentials_file, '/custom/work.json');
  assert.deepEqual(normalizeConfig({ accounts: [] }).accounts, []);
});

test('rejects duplicate identities, unknown providers and directory traversal', () => {
  for (const accounts of [
    [{ id: '../claude', provider: 'claude' }],
    [{ id: 'a', provider: 'unknown' }],
    [{ id: 'a', provider: 'claude' }, { id: 'a', provider: 'codex' }],
  ]) assert.throws(() => normalizeConfig({ accounts }));
});

test('managed accounts always resolve to independent credentials and never to web/global sessions', () => {
  const { accounts } = normalizeConfig({ accounts: [
    { id: 'personal', provider: 'claude', managed: true, config: { source: 'auto', oauth_credentials_file: '/wrong' } },
    { id: 'work', provider: 'claude', managed: true },
  ] });
  assert.equal(accounts[0].config.source, 'oauth');
  assert.notEqual(accounts[0].config.oauth_credentials_file, accounts[1].config.oauth_credentials_file);
  assert.match(accounts[0].config.oauth_credentials_file, /accounts\/personal\/\.credentials.json$/);
});

test('imports two Claude identities, renames, logs out and removes without changing global CLI credentials', async (t) => {
  const f = await fixture(t);
  const globalFile = path.join(f.home, '.claude/.credentials.json');
  await fs.mkdir(path.dirname(globalFile), { recursive: true });
  const first = { claudeAiOauth: { accessToken: 'fake-personal', scopes: ['user:profile'], expiresAt: Date.now() + 3_600_000 } };
  await fs.writeFile(globalFile, JSON.stringify(first));
  const personal = f.account('add', 'claude', 'Personal', '--import');
  const second = { claudeAiOauth: { ...first.claudeAiOauth, accessToken: 'fake-work' } };
  await fs.writeFile(globalFile, JSON.stringify(second));
  const work = f.account('add', 'claude', 'Trabajo', '--import');
  const directory = (id) => path.join(f.home, '.config/ai-usage-status/accounts', id);
  assert.deepEqual(await f.json(path.join(directory(personal.id), '.credentials.json')), first);
  assert.deepEqual(await f.json(path.join(directory(work.id), '.credentials.json')), second);
  const stat = await fs.stat(path.join(directory(work.id), '.credentials.json'));
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal((await fs.stat(directory(work.id))).mode & 0o777, 0o700);
  f.account('rename', work.id, "Trabajo 'equipo' $HOME");
  assert.equal(f.account('list')[1].label, "Trabajo 'equipo' $HOME");
  // Seed successful snapshots to verify logout purges historical usage too.
  for (const file of ['status.json', 'last-good-status.json']) {
    const status = await f.json(path.join(f.cache, file));
    status.accounts = status.accounts.map((a) => ({ ...a, ok: true, account_email: `${a.id}@example.test`, session: { used_percent: 50 } }));
    await fs.writeFile(path.join(f.cache, file), JSON.stringify(status));
  }
  f.account('logout', personal.id);
  assert.deepEqual(await f.json(globalFile), second);
  assert.deepEqual(await f.json(path.join(directory(work.id), '.credentials.json')), second);
  await assert.rejects(fs.access(directory(personal.id)));
  for (const file of ['status.json', 'last-good-status.json']) {
    const status = await f.json(path.join(f.cache, file));
    const loggedOut = status.accounts.find((a) => a.id === personal.id);
    assert.equal(loggedOut.logged_out, true);
    assert.equal(loggedOut.session, undefined);
    assert.equal(loggedOut.account_email, undefined);
    assert.equal(status.accounts.find((a) => a.id === work.id).session.used_percent, 50);
    assert.equal(status.claude.id, work.id);
    assert.doesNotMatch(JSON.stringify(status), /fake-personal|fake-work|accessToken/);
  }
  f.account('remove', personal.id);
  f.account('remove', work.id);
  assert.deepEqual(f.account('list'), []);
  const collected = f.run(collector);
  assert.equal(collected.status, 0, collected.stderr);
  assert.deepEqual(JSON.parse(collected.stdout).accounts, []);
});

test('legacy logout persists and cannot be restored by auto-detection or last-good data', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.configFile, JSON.stringify({ providers: { codex: { enabled: false } } }));
  const external = path.join(f.home, '.claude/.credentials.json');
  await fs.mkdir(path.dirname(external), { recursive: true });
  await fs.writeFile(external, '{"doNotDelete":true}');
  f.account('logout', 'claude-default');
  const result = f.run(collector);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).accounts[0].error_code, 'logged_out');
  assert.deepEqual(await f.json(external), { doNotDelete: true });
});

test('account changes refuse an active collector or login lock and leave config intact', async (t) => {
  const f = await fixture(t);
  const account = f.account('add', 'claude', 'Personal');
  const before = await fs.readFile(f.configFile, 'utf8');
  for (const name of ['collector.lock', `login-${account.id}.lock`]) {
    const file = path.join(f.cache, name);
    await fs.writeFile(file, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    const result = f.run(manager, ['logout', account.id]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /otra operación/);
    assert.equal(await fs.readFile(f.configFile, 'utf8'), before);
    await fs.rm(file);
  }
});

test('collector keeps two Claude accounts and their last-good snapshots separate', async (t) => {
  const f = await fixture(t);
  f.config.accounts = ['personal', 'work'].map((id) => ({
    id, provider: 'claude', label: id, managed: true,
  }));
  await fs.writeFile(f.configFile, JSON.stringify(f.config));
  for (const id of ['personal', 'work']) {
    const dir = path.join(f.home, '.config/ai-usage-status/accounts', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
      accessToken: id, expiresAt: Date.now() + 3_600_000, scopes: ['user:profile'],
    } }));
    await fs.writeFile(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `${id}@example.test` } }));
  }
  const preload = path.join(f.home, 'mock-fetch.cjs');
  await fs.writeFile(preload, `globalThis.fetch = async (url, options) => {
    const personal = options.headers.Authorization === 'Bearer personal';
    return new Response(JSON.stringify({
      five_hour: { utilization: personal ? 12 : 76, resets_at: new Date(Date.now() + 3600000).toISOString() }
    }), { status: 200 });
  };`);
  const collect = () => f.run(collector, [], { NODE_OPTIONS: `--require=${preload}` });
  let result = collect();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).claude.id, 'personal');
  assert.deepEqual(JSON.parse(result.stdout).accounts.map((a) => a.session.used_percent), [12, 76]);
  assert.deepEqual(JSON.parse(result.stdout).accounts.map((a) => a.account_email), ['personal@example.test', 'work@example.test']);
  // Expire personal credentials: its own 12% stays cached, work remains fresh.
  const credentials = path.join(f.home, '.config/ai-usage-status/accounts/personal/.credentials.json');
  const auth = await f.json(credentials);
  auth.claudeAiOauth.expiresAt = 1;
  await fs.writeFile(credentials, JSON.stringify(auth));
  result = collect();
  assert.equal(result.status, 0, result.stderr);
  const accounts = JSON.parse(result.stdout).accounts;
  assert.deepEqual(accounts.map((a) => a.session.used_percent), [12, 76]);
  assert.equal(accounts[0].stale_reason, 'oauth_expired');
  assert.equal(accounts[1].stale, undefined);
  assert.deepEqual(accounts.map((a) => a.account_email), ['personal@example.test', 'work@example.test']);
});

test('Codex app-server receives the selected account home and an isolated credential store', async (t) => {
  const f = await fixture(t);
  const mockCli = path.join(f.home, 'mock-codex');
  await fs.writeFile(mockCli, `#!${process.execPath}
import('node:readline').then(({createInterface}) => {
  const rl = createInterface({input: process.stdin});
  rl.on('line', line => {
    const message = JSON.parse(line);
    if (message.id === 0) console.log(JSON.stringify({id: 0, result: {}}));
    if (message.id === 1) {
      if (!process.argv.includes('cli_auth_credentials_store="file"') || process.env.OPENAI_API_KEY) process.exit(3);
      console.log(JSON.stringify({id: 1, result: {rateLimits: {primary: {
        usedPercent: process.env.CODEX_HOME.endsWith('/personal') ? 14 : 82,
        windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000) + 3600
      }}}}));
    }
  });
});`, { mode: 0o700 });
  f.config.accounts = ['personal', 'work'].map((id) => ({
    id, provider: 'codex', label: id, managed: true, config: { cli_path: mockCli },
  }));
  for (const id of ['personal', 'work']) {
    const directory = path.join(f.home, '.config/ai-usage-status/accounts', id);
    await fs.mkdir(directory, { recursive: true });
    const claims = Buffer.from(JSON.stringify({ email: `${id}@example.test` })).toString('base64url');
    await fs.writeFile(path.join(directory, 'auth.json'), JSON.stringify({ tokens: {
      id_token: `header.${claims}.signature`, access_token: 'private-access', refresh_token: 'private-refresh',
    } }));
  }
  await fs.writeFile(f.configFile, JSON.stringify(f.config));
  const result = f.run(collector, [], { OPENAI_API_KEY: 'must-not-be-used' });
  assert.equal(result.status, 0, result.stderr);
  const accounts = JSON.parse(result.stdout).accounts;
  assert.deepEqual(accounts.map((a) => a.five_hour.used_percent), [14, 82]);
  assert.deepEqual(accounts.map((a) => a.account_email), ['personal@example.test', 'work@example.test']);
  assert.doesNotMatch(result.stdout, /private-access|private-refresh|id_token|access_token/);
});

test('invalid configuration never reactivates globally detected accounts', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.configFile, '{broken');
  const result = f.run(collector);
  assert.notEqual(result.status, 0);
  await assert.rejects(fs.access(path.join(f.cache, 'status.json')));
});

test('native login runs through a terminal using separate Claude and Codex homes', async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.home, '.local/bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'konsole'), `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(process.argv.indexOf('-e') + 1);
const child = spawnSync(args[0], args.slice(1), {stdio: 'ignore'});
process.exit(child.status ?? 1);
`, { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const dir = process.env.CLAUDE_CONFIG_DIR;
if (!dir.includes('/ai-usage-status/accounts/')) process.exit(2);
if (process.env.ANTHROPIC_API_KEY) process.exit(3);
fs.writeFileSync(dir+'/.credentials.json', JSON.stringify({claudeAiOauth: {accessToken:'fake-isolated'}}));
`, { mode: 0o700 });
  await fs.writeFile(path.join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
const dir = process.env.CODEX_HOME;
if (!dir.includes('/ai-usage-status/accounts/')) process.exit(2);
if (!process.argv.includes('cli_auth_credentials_store="file"')) process.exit(3);
fs.writeFileSync(dir+'/auth.json', JSON.stringify({tokens: {access_token:'fake-isolated'}}));
`, { mode: 0o700 });
  for (const provider of ['claude', 'codex']) {
    const result = f.run(manager, ['add', provider, 'Otra cuenta', '--login'], { ANTHROPIC_API_KEY: 'must-not-be-used' });
    assert.equal(result.status, 0, result.stderr);
    const account = JSON.parse(result.stdout);
    assert.equal(account.logged_out, false);
    const config = await f.json(f.configFile);
    assert.equal(config.accounts.find((item) => item.id === account.id).managed, true);
    f.account('logout', account.id);
    f.account('login', account.id, '--terminal');
    assert.equal(f.account('list').find((item) => item.id === account.id).logged_out, false);
  }
});

test('account CLI also works when launched through an installed symlink', async (t) => {
  const f = await fixture(t);
  const link = path.join(f.home, 'ai-usage-accounts');
  await fs.symlink(manager, link);
  const result = f.run(link, ['list']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('Antigravity account connects locally, collects quotas and disconnects without persisting CSRF', async (t) => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const f = await fixture(t);
  const dir = path.join(f.home, 'antigravity');
  await fs.mkdir(dir);
  const script = path.join(dir, 'language_server.cjs');
  const email = `account-${path.basename(f.home)}@example.test`;
  await fs.writeFile(script, `
const http = require('node:http');
const server = http.createServer((req,res) => {
  if (req.headers['x-codeium-csrf-token'] !== 'secret-local-csrf') { res.statusCode=403; return res.end('{}'); }
  if (req.url.endsWith('GetUserStatus')) return res.end(JSON.stringify({userStatus: {
    email: ${JSON.stringify(email)}, cascadeModelConfigData: {clientModelConfigs: [{label: 'Gemini Pro',
    modelOrAlias: {model:'gemini-pro'}, quotaInfo: {remainingFraction: .6, resetTime: new Date(Date.now()+3600000).toISOString()}}]}
  }}));
  res.statusCode=404; res.end('{}');
});
server.listen(0,'127.0.0.1', () => console.log('ready'));
`);
  const child = spawn(process.execPath, [script, '--csrf_token', 'secret-local-csrf', '--app_data_dir', 'antigravity'], {
    env: f.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  await once(child.stdout, 'data');
  const account = f.account('add', 'antigravity', 'Google', '--local', '--email', email);
  assert.equal(account.logged_out, false);
  const config = await f.json(f.configFile);
  assert.match(config.accounts[0].config.identity, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(config), /secret-local-csrf|csrfToken/);
  const collected = f.run(collector);
  assert.equal(collected.status, 0, collected.stderr);
  const snapshot = JSON.parse(collected.stdout);
  assert.equal(snapshot.accounts[0].quota.used_percent, 40);
  assert.equal(snapshot.accounts[0].source, 'antigravity-local');
  assert.doesNotMatch(collected.stdout, /secret-local-csrf|csrfToken/);
  f.account('logout', account.id);
  const status = await f.json(path.join(f.cache, 'status.json'));
  assert.equal(status.accounts[0].logged_out, true);
  assert.equal(status.accounts[0].quota, undefined);
  assert.equal(child.exitCode, null);
});
