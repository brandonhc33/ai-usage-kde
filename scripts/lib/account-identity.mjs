import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function emailAddress(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  return email.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email) ? email : null;
}

// Only read metadata belonging to the selected CLI session. Never fall back
// from a custom/managed account to another account in the global CLI profile.
// Return only the email: credentials and token claims stay inside the collector.
export async function readAccountEmail(account, home = os.homedir()) {
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
      return emailAddress(claims.email);
    }
    if (account.provider === 'claude') {
      const defaultCredentials = path.join(home, '.claude', '.credentials.json');
      const credentials = expand(config.oauth_credentials_file ?? defaultCredentials);
      const metadata = expand(config.claude_account_file ?? (credentials === defaultCredentials
        ? path.join(home, '.claude.json') : path.join(path.dirname(credentials), '.claude.json')));
      const profile = JSON.parse(await fs.readFile(metadata, 'utf8'));
      return emailAddress(profile.oauthAccount?.emailAddress);
    }
  } catch {
    // Identity is optional; a missing or malformed profile must not hide usage.
  }
  return null;
}
