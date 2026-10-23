import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findDuplicateAccounts, readAccountEmail, readAccountIdentity } from '../lib/account-identity.mjs';

const token = (email) => `header.${Buffer.from(JSON.stringify({ email, private_claim: 'not-for-the-widget' })).toString('base64url')}.signature`;
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-identity-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const write = async (file, value) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
  };
  return { home, write };
}

test('Codex reads only the selected session email and never returns token data', async (t) => {
  const { home, write } = await fixture(t);
  await write(path.join(home, '.codex/auth.json'), { tokens: { id_token: token('global@example.test') } });
  for (const name of ['personal', 'work']) {
    const directory = path.join(home, name);
    await write(path.join(directory, 'auth.json'), { tokens: {
      id_token: token(` ${name}@example.test `), access_token: 'private-access', refresh_token: 'private-refresh',
    } });
    assert.equal(await readAccountEmail({ provider: 'codex', config: { codex_home: directory } }, home), `${name}@example.test`);
  }
  const missing = { provider: 'codex', config: { codex_home: path.join(home, 'missing-managed') } };
  assert.equal(await readAccountEmail(missing, home), null);
});

test('Claude scopes metadata to its credentials and never borrows the global identity', async (t) => {
  const { home, write } = await fixture(t);
  await write(path.join(home, '.claude.json'), { oauthAccount: { emailAddress: 'global@example.test' } });
  assert.equal(await readAccountEmail({ provider: 'claude' }, home), 'global@example.test');
  for (const name of ['personal', 'work']) {
    const directory = path.join(home, name);
    const account = { provider: 'claude', config: { oauth_credentials_file: path.join(directory, '.credentials.json') } };
    assert.equal(await readAccountEmail(account, home), null);
    await write(path.join(directory, '.claude.json'), { oauthAccount: { emailAddress: `${name}@example.test`, accountUuid: 'private-metadata' } });
    assert.equal(await readAccountEmail(account, home), `${name}@example.test`);
  }
  assert.equal(await readAccountEmail({ provider: 'claude', config: { claude_account_file: path.join(home, 'missing.json') } }, home), null);
});

test('invalid metadata, API keys and signed-out accounts do not expose an email or break collection', async (t) => {
  const { home, write } = await fixture(t);
  const directory = path.join(home, 'codex');
  const account = { provider: 'codex', config: { codex_home: directory } };
  for (const id_token of ['broken', 'header.invalid.signature', token('not an email'), token('name@example.test\nprivate-data')]) {
    await write(path.join(directory, 'auth.json'), { tokens: { id_token } });
    assert.equal(await readAccountEmail(account, home), null);
  }
  await write(path.join(directory, 'auth.json'), { auth_mode: 'apikey', tokens: { id_token: token('old@example.test') } });
  assert.equal(await readAccountEmail(account, home), null);
  await write(path.join(directory, 'auth.json'), { tokens: { id_token: token('active@example.test') } });
  assert.equal(await readAccountEmail({ ...account, logged_out: true }, home), null);
  assert.equal(await readAccountEmail({ ...account, enabled: false }, home), null);
  await fs.writeFile(path.join(home, 'bad-profile.json'), '{"private-token":broken');
  assert.equal(await readAccountEmail({ provider: 'claude', config: { claude_account_file: path.join(home, 'bad-profile.json') } }, home), null);
});

test('identity keys tell accounts and workspaces apart without exposing tokens', async (t) => {
  const { home, write } = await fixture(t);
  const codexToken = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
  const codex = (name, claims) => write(path.join(home, name, 'auth.json'), { tokens: {
    id_token: codexToken(claims), access_token: 'private-access', refresh_token: 'private-refresh',
  } });
  await codex('a', { email: 'me@example.test', 'https://api.openai.com/auth': { chatgpt_user_id: 'u1', chatgpt_account_id: 'w1' } });
  await codex('b', { email: 'me@example.test', 'https://api.openai.com/auth': { chatgpt_user_id: 'u1', chatgpt_account_id: 'w2' } });
  const keyOf = async (account) => (await readAccountIdentity(account, home))?.key;
  const a = await readAccountIdentity({ provider: 'codex', config: { codex_home: path.join(home, 'a') } }, home);
  assert.deepEqual(a, { email: 'me@example.test', key: 'u1:w1' });
  assert.equal(await keyOf({ provider: 'codex', config: { codex_home: path.join(home, 'b') } }), 'u1:w2');
  const claude = path.join(home, 'claude');
  await write(path.join(claude, '.claude.json'), { oauthAccount: { emailAddress: 'me@example.test', accountUuid: 'acc', organizationUuid: 'org' } });
  assert.equal(await keyOf({ provider: 'claude', config: { claude_account_file: path.join(claude, '.claude.json') } }), 'acc:org');
  await write(path.join(claude, '.claude.json'), { oauthAccount: { emailAddress: 'me@example.test' } });
  assert.equal(await keyOf({ provider: 'claude', config: { claude_account_file: path.join(claude, '.claude.json') } }), 'me@example.test:');
});

test('duplicates keep the widget session first and never compare across providers', () => {
  const entry = (id, provider, key, managed = true) => ({ account: { id, provider, label: id, managed }, identity: key ? { key } : null });
  const duplicates = findDuplicateAccounts([
    entry('global', 'claude', 'k', false), entry('work', 'claude', 'k'), entry('copy', 'claude', 'k'),
    entry('codex', 'codex', 'k'), entry('unknown', 'claude', null), entry('unknown-2', 'claude', null),
  ]);
  assert.deepEqual(Object.fromEntries(duplicates), { global: 'work', copy: 'work' });
});
