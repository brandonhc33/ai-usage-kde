#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  HOME, CACHE_DIR, CONFIG_FILE, accountDirectory, acquireLock, disconnectedAccount,
  expandHome, loadConfig, publicAccount, readJson, writeAtomic,
  validateAccount,
  updateLegacyProviders,
} from './lib/accounts.mjs';
import { resolveCodexCommand } from './lib/structured-sources.mjs';
import { fetchAntigravityLocal } from './lib/antigravity.mjs';

const scriptPath = fileURLToPath(import.meta.url);

function accountById(config, id) {
  const account = config.accounts.find((item) => item.id === id);
  if (!account) throw new Error('No se encontró la cuenta.');
  return account;
}

function loginLock(id) {
  validateAccount({ id, provider: 'codex' });
  return path.join(CACHE_DIR, `login-${id}.lock`);
}

async function assertNotLoggingIn(id) {
  const release = await acquireLock(loginLock(id));
  return release;
}

// Rebuild both public snapshots after an account change, so hidden/deleted
// identities and old usage cannot reappear during a later collector failure.
async function syncSnapshots(config, invalidateId = null) {
  for (const name of ['status.json', 'last-good-status.json']) {
    const file = path.join(CACHE_DIR, name);
    const previous = await readJson(file, null);
    const accounts = config.accounts.map((account) => {
      if (account.logged_out || !account.enabled) return disconnectedAccount(account);
      const cached = previous?.accounts?.find((item) => item.id === account.id)
        ?? (!previous?.accounts && account.id === `${account.provider}-default`
          ? previous?.[account.provider] : null);
      if (cached && account.id !== invalidateId) return { ...cached, ...publicAccount(account) };
      return {
        ...publicAccount(account), ok: false, error_code: 'login_required',
        updated_at: new Date().toISOString(),
      };
    });
    const errors = (previous?.errors ?? []).filter((error) =>
      error.account_id && error.account_id !== invalidateId
      && accounts.some((account) => account.id === error.account_id && !account.logged_out));
    await writeAtomic(file, updateLegacyProviders({
      schema_version: 3,
      updated_at: previous?.updated_at ?? new Date().toISOString(),
      ok: errors.length === 0, stale: errors.length > 0,
      thresholds: config.thresholds, accounts, errors,
      primary: { provider: 'none', metric: 'none', label: '--' },
    }));
  }
}

async function mutate(callback, invalidateId = null, waitForCollector = false) {
  const deadline = Date.now() + (waitForCollector ? 90_000 : 0);
  let release;
  for (;;) {
    try { release = await acquireLock(); break; }
    catch (error) {
      if (error.code !== 'operation_in_progress' || Date.now() >= deadline) throw error;
      await delay(500);
    }
  }
  try {
    const config = await loadConfig();
    const result = await callback(config);
    await writeAtomic(CONFIG_FILE, config);
    await syncSnapshots(config, invalidateId);
    return result;
  } finally {
    await release();
  }
}

async function importCredentials(account, config) {
  const original = config.providers[account.provider];
  const directory = accountDirectory(account.id);
  // Read and validate before creating anything. Never expose credential data
  // in stdout, config.json, status.json, or a parsing error.
  if (account.provider === 'codex') {
    const sourceHome = expandHome(original.codex_home ?? process.env.CODEX_HOME ?? '~/.codex');
    let credentials;
    try { credentials = await readJson(path.join(sourceHome, 'auth.json'), null); } catch { /* below */ }
    if (!credentials?.tokens?.access_token) {
      throw new Error('No hay una sesión de Codex importable. Usa «Iniciar otra sesión».');
    }
    await writeAtomic(path.join(directory, 'auth.json'), credentials);
  } else {
    const sourceDirectory = process.env.CLAUDE_CONFIG_DIR;
    const credentialFile = sourceDirectory
      ? path.join(sourceDirectory, '.credentials.json')
      : expandHome(original.oauth_credentials_file);
    let credentials;
    try { credentials = await readJson(credentialFile, null); } catch { /* below */ }
    if (!credentials?.claudeAiOauth?.accessToken) {
      throw new Error('No hay una sesión de Claude importable. Usa «Iniciar otra sesión».');
    }
    await writeAtomic(path.join(directory, '.credentials.json'), { claudeAiOauth: credentials.claudeAiOauth });
    const metadataFile = sourceDirectory ? path.join(sourceDirectory, '.claude.json')
      : expandHome(original.claude_account_file ?? '~/.claude.json');
    const metadata = await readJson(metadataFile, null).catch(() => null);
    if (metadata?.oauthAccount) {
      await writeAtomic(path.join(directory, '.claude.json'), { oauthAccount: metadata.oauthAccount });
    }
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('El inicio de sesión se canceló o no pudo completarse.')));
  });
}

async function executable(name) {
  for (const directory of [path.join(HOME, '.local/bin'), ...String(process.env.PATH ?? '').split(path.delimiter)]) {
    const candidate = path.join(directory, name);
    if (await fs.access(candidate, fs.constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return null;
}

async function terminalLogin(id) {
  const terminal = await executable('konsole') ?? await executable('x-terminal-emulator')
    ?? await executable('xterm');
  if (!terminal) throw new Error('Instala Konsole para iniciar sesión desde el widget.');
  const args = path.basename(terminal) === 'konsole' ? ['--nofork'] : [];
  await run(terminal, [...args, '-e', process.execPath, scriptPath, 'login', id], { stdio: 'ignore' });
  const account = accountById(await loadConfig(), id);
  if (account.logged_out) throw new Error('El inicio de sesión no se completó. Puedes reintentarlo desde la cuenta.');
  return publicAccount(account);
}

async function login(id, inTerminal) {
  const selected = accountById(await loadConfig(), id);
  if (selected.provider === 'antigravity') {
    const release = await acquireLock(loginLock(id));
    try {
      const snapshot = await fetchAntigravityLocal(selected.config);
      return await mutate((config) => {
        const account = accountById(config, id);
        account.config = { ...account.config, identity: snapshot.identity, source: 'local' };
        account.managed = false;
        account.logged_out = false;
        account.enabled = true;
        return publicAccount(account);
      }, id);
    } finally { await release(); }
  }
  if (inTerminal) return terminalLogin(id);
  const releaseLogin = await acquireLock(loginLock(id));
  let directory;
  let connected = false;
  try {
    const account = accountById(await loadConfig(), id);
    const selectedDirectory = accountDirectory(id);
    // Signing in replaces this widget identity, never the global CLI session.
    await mutate((config) => {
      const selected = accountById(config, id);
      selected.managed = true;
      selected.logged_out = true;
    }, id);
    directory = selectedDirectory;
    await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const env = { ...process.env };
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN',
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key];
    if (account.provider === 'codex') {
      env.CODEX_HOME = directory;
      const command = await resolveCodexCommand(account.config);
      await run(command, ['login', '-c', 'cli_auth_credentials_store="file"'], { env, stdio: 'inherit', cwd: directory });
      const auth = await readJson(path.join(directory, 'auth.json'), null);
      if (!auth?.tokens?.access_token) throw new Error('Codex no guardó una sesión de suscripción.');
      await fs.chmod(path.join(directory, 'auth.json'), 0o600);
    } else {
      env.CLAUDE_CONFIG_DIR = directory;
      const command = await executable('claude');
      if (!command) throw new Error('Instala Claude Code para iniciar sesión.');
      await run(command, ['auth', 'login', '--claudeai'], { env, stdio: 'inherit', cwd: directory });
      const auth = await readJson(path.join(directory, '.credentials.json'), null);
      if (!auth?.claudeAiOauth?.accessToken) throw new Error('Claude no guardó la sesión.');
      await fs.chmod(path.join(directory, '.credentials.json'), 0o600);
    }
    const result = await mutate((config) => {
      const selected = accountById(config, id);
      selected.logged_out = false;
      selected.enabled = true;
      return publicAccount(selected);
    }, id, true);
    connected = true;
    return result;
  } finally {
    if (directory && !connected) await fs.rm(directory, { recursive: true, force: true });
    await releaseLogin();
  }
}

export async function main(args = process.argv.slice(2)) {
  const [command, target, label] = args;
  if (command === 'list') return (await loadConfig()).accounts.map(publicAccount);
  if (command === 'login') return login(target, args.includes('--terminal'));
  if (command === 'add') {
    if (!['codex', 'claude', 'antigravity'].includes(target)) throw new Error('Selecciona Codex, Claude o Antigravity.');
    const name = String(label ?? '').trim();
    if (!name || name.length > 60) throw new Error('Escribe un nombre de entre 1 y 60 caracteres.');
    const id = `${target}-${randomUUID()}`;
    let localSnapshot = null;
    if (target === 'antigravity' && (args.includes('--local') || args.includes('--import') || args.includes('--login'))) {
      const emailIndex = args.indexOf('--email');
      localSnapshot = await fetchAntigravityLocal({ expected_email: emailIndex === -1 ? null : args[emailIndex + 1] });
    }
    const result = await mutate(async (config) => {
      const account = { id, provider: target, label: name, enabled: true, managed: true, logged_out: true };
      if (target === 'antigravity') {
        account.managed = false;
        account.config = { source: 'local', ...(localSnapshot ? { identity: localSnapshot.identity } : {}) };
        account.logged_out = !localSnapshot;
      } else if (args.includes('--import')) {
        try { await importCredentials(account, config); }
        catch (error) { await fs.rm(accountDirectory(id), { recursive: true, force: true }); throw error; }
        account.logged_out = false;
      }
      config.accounts.push(account);
      return publicAccount(account);
    });
    return args.includes('--login') && target !== 'antigravity' ? terminalLogin(id) : result;
  }
  if (['logout', 'remove', 'rename'].includes(command)) {
    const releaseLogin = await assertNotLoggingIn(target);
    try {
      return await mutate(async (config) => {
        const account = accountById(config, target);
        if (command === 'rename') {
          const name = String(label ?? '').trim();
          if (!name || name.length > 60) throw new Error('Escribe un nombre de entre 1 y 60 caracteres.');
          account.label = name;
        } else {
          // Only widget-owned files are deleted. Legacy CLI credentials and
          // arbitrary configured browser profiles belong to other applications.
          await fs.rm(accountDirectory(account.id), { recursive: true, force: true });
          account.logged_out = true;
          if (command === 'remove') config.accounts = config.accounts.filter((item) => item.id !== target);
          const statesFile = path.join(CACHE_DIR, 'provider-state.json');
          const states = await readJson(statesFile, {});
          delete states[target];
          await writeAtomic(statesFile, states);
        }
        return publicAccount(account);
      }, command === 'rename' ? null : target);
    } finally { await releaseLogin(); }
  }
  throw new Error('Uso: ai-usage-accounts list | add codex|claude NOMBRE [--import|--login] | add antigravity NOMBRE --local [--email CORREO] | login ID [--terminal] | logout ID | remove ID | rename ID NOMBRE');
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => '') === scriptPath) {
  main().then((result) => console.log(JSON.stringify(result))).catch((error) => {
    // JSON parser errors may contain credential fragments. Only display known
    // operational messages; never serialize arbitrary files or error objects.
    const message = error instanceof SyntaxError ? 'No se pudo leer un archivo de configuración o sesión.' : error.message;
    console.error(message);
    process.exitCode = 1;
  });
}
