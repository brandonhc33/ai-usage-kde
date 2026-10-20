import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const HOME = os.homedir();
export const CONFIG_DIR = path.join(HOME, '.config', 'ai-usage-status');
export const CACHE_DIR = path.join(HOME, '.cache', 'ai-usage-status');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const DEFAULT_CONFIG = {
  schema_version: 2,
  primary: { provider: 'codex', metric: 'five_hour' },
  thresholds: {
    warning_used_percent: 51,
    critical_used_percent: 76,
    stale_after_minutes: 15,
    last_good_valid_minutes: 30,
  },
  providers: {
    codex: {
      enabled: true, source: 'auto', cli_path: null, cli_timeout_ms: 15000,
      url: 'https://chatgpt.com/codex/settings/usage',
      profile_dir: '~/.config/ai-usage-status/profiles/chatgpt',
      headless: true, wait_ms: 8000, debug_text: false,
    },
    claude: {
      enabled: true, source: 'auto',
      oauth_credentials_file: '~/.claude/.credentials.json',
      oauth_timeout_ms: 30000, on_oauth_expired: 'keep_last',
      url: 'https://claude.ai/new#settings/usage',
      profile_dir: '~/.config/ai-usage-status/profiles/claude',
      headless: true, wait_ms: 8000, debug_text: false,
    },
    antigravity: { enabled: false, source: 'local', timeout_ms: 8000 },
  },
};

export function expandHome(value) {
  return value?.replace(/^~(?=$|\/)/, HOME);
}

export function validateAccount(account) {
  if (!account || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(account.id)
      || !['codex', 'claude', 'antigravity'].includes(account.provider)) {
    throw new Error('Cuenta no válida. Revisa config.json.');
  }
  return account;
}

export function normalizeConfig(value) {
  const config = value && typeof value === 'object' ? value : {};
  const providers = {
    codex: { ...DEFAULT_CONFIG.providers.codex, ...config.providers?.codex },
    claude: { ...DEFAULT_CONFIG.providers.claude, ...config.providers?.claude },
    antigravity: { ...DEFAULT_CONFIG.providers.antigravity, ...config.providers?.antigravity },
  };
  if (config.accounts !== undefined && !Array.isArray(config.accounts)) {
    throw new Error('accounts debe ser una lista.');
  }
  // An explicitly empty list is intentional: never resurrect removed accounts.
  const accounts = config.accounts ?? Object.keys(providers)
    .filter((provider) => providers[provider].enabled)
    .map((provider) => ({
      id: `${provider}-default`, provider, label: 'Principal',
      enabled: true, managed: false, logged_out: false,
      config: { ...providers[provider] },
    }));
  const seen = new Set();
  return {
    ...DEFAULT_CONFIG, ...config, schema_version: 2,
    primary: { ...DEFAULT_CONFIG.primary, ...config.primary },
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...config.thresholds },
    providers,
    accounts: accounts.map((account) => {
      validateAccount(account);
      if (seen.has(account.id)) throw new Error('Hay identificadores de cuenta duplicados.');
      seen.add(account.id);
      const settings = { ...providers[account.provider], ...account.config };
      if (account.provider === 'antigravity') settings.source = 'local';
      if (account.managed === true && account.provider !== 'antigravity') {
        const directory = accountDirectory(account.id);
        // Managed identities may never fall back to the user's global session.
        Object.assign(settings, {
          source: account.provider === 'codex' ? 'cli' : 'oauth',
          codex_home: directory,
          oauth_credentials_file: path.join(directory, '.credentials.json'),
          claude_account_file: path.join(directory, '.claude.json'),
          profile_dir: path.join(directory, 'browser'),
        });
      }
      return {
        ...account,
        label: String(account.label || 'Principal').trim().slice(0, 60),
        enabled: account.enabled !== false,
        managed: account.managed === true,
        logged_out: account.logged_out === true,
        config: settings,
      };
    }),
  };
}

export function accountDirectory(id) {
  validateAccount({ id, provider: 'codex' });
  return path.join(CONFIG_DIR, 'accounts', id);
}

export function publicAccount(account) {
  return {
    id: account.id, provider: account.provider, label: account.label,
    enabled: account.enabled, managed: account.managed, logged_out: account.logged_out,
  };
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function loadConfig() {
  return normalizeConfig(await readJson(CONFIG_FILE, DEFAULT_CONFIG));
}

// Shared with the collector: logout and removal cannot race a refresh and
// accidentally restore a signed-out account from last-good-status.json.
export async function acquireLock(file = path.join(CACHE_DIR, 'collector.lock')) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      return async () => { await handle.close(); await fs.rm(file, { force: true }); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const lock = await readJson(file, null).catch(() => null);
      if (lock?.pid) {
        try {
          process.kill(lock.pid, 0);
          throw Object.assign(new Error('Hay otra operación en curso. Espera a que termine y vuelve a intentar.'), { code: 'operation_in_progress' });
        } catch (activeError) {
          if (activeError.code !== 'ESRCH') throw activeError;
        }
      } else if (!lock || Date.now() - Date.parse(lock.started_at) < 10 * 60 * 1000) {
        throw Object.assign(new Error('Hay otra operación en curso. Vuelve a intentar en unos segundos.'), { code: 'operation_in_progress' });
      }
      await fs.rm(file, { force: true });
    }
  }
  throw new Error('No se pudo bloquear la configuración.');
}

export function disconnectedAccount(account) {
  return {
    ...publicAccount(account), ok: false,
    error_code: account.logged_out ? 'logged_out' : 'account_disabled',
    updated_at: new Date().toISOString(),
  };
}

// Older installed widgets may share a collector updated by the user timer.
// Keep their first-provider view working until the widget is upgraded too.
export function updateLegacyProviders(status) {
  for (const provider of ['codex', 'claude']) {
    const accounts = status.accounts.filter((account) => account.provider === provider);
    const account = accounts.find((item) => !item.logged_out && item.enabled !== false) ?? accounts[0];
    if (account) status[provider] = account;
    else delete status[provider];
  }
  return status;
}
