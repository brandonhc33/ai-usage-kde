import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function emailAddress(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  return email.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) ? email : null;
}

function identifier(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// `key` names the provider account whose usage is read (user plus
// workspace/organization), so two widget accounts can be compared without
// trusting their labels. Missing parts fall back to the email.
function identity(email, user, workspace) {
  const owner = identifier(user) ?? email;
  return owner ? { email, key: `${owner}:${identifier(workspace) ?? ''}` } : null;
}

// Only read metadata belonging to the selected CLI session. Never fall back
// from a custom/managed account to another account in the global CLI profile.
// Return only the email and an opaque key: credentials and token claims stay
// inside the collector.
export async function readAccountIdentity(account, home = os.homedir()) {
  if (!account || account.logged_out || account.enabled === false) return null;
  const config = account.config ?? {};
  const expand = (value) => value.replace(/^~(?=$|\/)/, home);
  try {
    if (account.provider === 'codex') {
      const directory = expand(config.codex_home ?? process.env.CODEX_HOME ?? path.join(home, '.codex'));
      const auth = JSON.parse(await fs.readFile(path.join(directory, 'auth.json'), 'utf8'));
      if (auth.auth_mode === 'apikey' || auth.auth_mode === 'api_key') return null;
      const token = auth.tokens?.id_token;
      if (typeof token !== 'string' || token.split('.').length !== 3) return null;
      // The local ID token is used only as a display hint, never for authorization.
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      const openai = claims['https://api.openai.com/auth'] ?? {};
      return identity(emailAddress(claims.email), openai.chatgpt_user_id ?? claims.sub,
        openai.chatgpt_account_id);
    }
    if (account.provider === 'claude') {
      const defaultCredentials = path.join(home, '.claude', '.credentials.json');
      const credentials = expand(config.oauth_credentials_file ?? defaultCredentials);
      const metadata = expand(config.claude_account_file ?? (credentials === defaultCredentials
        ? path.join(home, '.claude.json') : path.join(path.dirname(credentials), '.claude.json')));
      const profile = JSON.parse(await fs.readFile(metadata, 'utf8')).oauthAccount ?? {};
      return identity(emailAddress(profile.emailAddress), profile.accountUuid, profile.organizationUuid);
    }
  } catch {
    // Identity is optional; a missing or malformed profile must not hide usage.
  }
  return null;
}

export async function readAccountEmail(account, home = os.homedir()) {
  return (await readAccountIdentity(account, home))?.email ?? null;
}

// Two cards on one identity show the same usage twice, typically after a
// browser login that reused the session already open for another account.
// The widget's own sessions win over one that follows the global CLI, then
// configuration order. Returns account id → label of the account it repeats.
export function findDuplicateAccounts(entries) {
  const owners = new Map();
  const duplicates = new Map();
  entries
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => entry.identity?.key)
    .sort((a, b) => Number(b.account.managed === true) - Number(a.account.managed === true)
      || a.index - b.index)
    .forEach(({ account, identity: { key } }) => {
      const owner = owners.get(`${account.provider}:${key}`);
      if (owner) duplicates.set(account.id, owner.label);
      else owners.set(`${account.provider}:${key}`, account);
    });
  return duplicates;
}
