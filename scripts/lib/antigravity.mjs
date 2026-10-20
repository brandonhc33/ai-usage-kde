// Read-only Antigravity quota sources: the `agy` CLI (`/usage` in print mode
// answers without an agent turn, quota or conversation) and, as a fallback,
// the desktop app's loopback service. No prompts, OAuth grants, or remote
// endpoints of our own. CSRF tokens are read only from same-user processes
// and are never persisted or returned in the public snapshot.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';

const SERVICE = '/exa.language_server_pb.LanguageServerService/';
export const ANTIGRAVITY_CLI_INSTALL = 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
const CLI_AUTH_PROMPT = /authentication required|visit the url to log in/i;
const CLI_ACCOUNT = /authenticated successfully as (\S+@\S+)/;
const fail = (message, code) => Object.assign(new Error(message), { code });
const hasValue = (value) => value !== null && value !== undefined && value !== '';

export function antigravityIdentity(email) {
  return createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

function resetEpoch(value) {
  if (value && typeof value === 'object') value = value.seconds;
  if (!hasValue(value)) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.floor(date / 1000) : null;
}

function quotaMetric(fraction, reset, description) {
  const remaining = hasValue(fraction) && Number.isFinite(Number(fraction))
    ? Math.round(Math.max(0, Math.min(1, Number(fraction))) * 10000) / 100 : null;
  // An untouched quota has not started: its reset is just "now + window" and
  // moves on every refresh, so it is not shown.
  const idle = remaining === 100;
  const epoch = idle ? null : resetEpoch(reset);
  return {
    used_percent: remaining === null ? null : Math.round((100 - remaining) * 100) / 100,
    remaining_percent: remaining,
    reset_epoch: epoch,
    reset_label: epoch === null && !idle ? description || null : null,
    state: remaining === null ? 'unavailable' : idle ? 'idle' : 'active',
  };
}

function cadence(bucket) {
  const explicit = typeof bucket.window === 'string' ? bucket.window
    : bucket.window?.type ?? bucket.window?.duration ?? '';
  const text = explicit || `${bucket.bucketId || ''} ${bucket.displayName || ''}`;
  if (/(?:^|[^a-z])(?:weekly|week|seven.day|7d)(?:$|[^a-z])/i.test(text)) return 'weekly';
  if (/(?:^|[^a-z])(?:5h|five.hour|5.hour|session)(?:$|[^a-z])/i.test(text)) return 'session';
  return null;
}

function mostUsed(windows) {
  return windows.filter((window) => window.metric.used_percent !== null)
    .sort((a, b) => b.metric.used_percent - a.metric.used_percent)[0]?.metric ?? null;
}

export function mapAntigravityUsage(userPayload, summaryPayload = null, now = new Date()) {
  const user = userPayload?.userStatus ?? userPayload?.response?.userStatus;
  const email = typeof user?.email === 'string' ? user.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    throw fail('Antigravity no informó la cuenta. Abre la aplicación e inicia sesión con Google.', 'login_required');
  }
  const windows = [];
  const groups = summaryPayload?.response?.groups ?? summaryPayload?.groups ?? [];
  for (const [groupIndex, group] of groups.entries()) {
    for (const [bucketIndex, bucket] of (group.buckets ?? []).entries()) {
      const remaining = bucket.remaining?.remainingFraction
        ?? (bucket.remaining?.case === 'remainingFraction' ? bucket.remaining.value : null);
      const period = cadence(bucket);
      windows.push({
        id: String(bucket.bucketId || `group-${groupIndex}-${bucketIndex}`),
        label: `${group.displayName || 'Cuota'} · ${period === 'weekly' ? 'Semanal'
          : period === 'session' ? 'Sesión' : bucket.displayName || 'Uso'}`,
        cadence: period,
        metric: quotaMetric(remaining, bucket.resetTime ?? bucket.resetAt, bucket.description),
      });
    }
  }
  const modelQuotas = (user.cascadeModelConfigData?.clientModelConfigs ?? [])
    .filter((model) => model.quotaInfo)
    .map((model) => ({
      id: String(model.modelOrAlias?.model ?? model.label ?? ''),
      label: String(model.label || model.modelOrAlias?.model || 'Modelo'),
      metric: quotaMetric(model.quotaInfo.remainingFraction, model.quotaInfo.resetTime),
    }));
  if (!windows.some((window) => window.metric.used_percent !== null)) {
    // Legacy IDEs report model pools without a documented time window. Keep
    // those pools distinct instead of inventing a five-hour or weekly limit.
    const families = new Map();
    for (const model of modelQuotas) {
      if (/lite|autocomplete|image|embedding/i.test(`${model.id} ${model.label}`)) continue;
      const key = /gemini/i.test(`${model.id} ${model.label}`) ? 'Gemini'
        : /claude|gpt/i.test(`${model.id} ${model.label}`) ? 'Claude + GPT' : model.label;
      const previous = families.get(key);
      if (!previous || (model.metric.used_percent !== null
          && (previous.metric.used_percent === null || model.metric.used_percent > previous.metric.used_percent))) {
        families.set(key, { id: model.id, label: key, cadence: null, metric: model.metric });
      }
    }
    if (families.size) windows.splice(0, windows.length, ...families.values());
  }
  const quota = mostUsed(windows);
  if (!quota && windows.length === 0) throw fail('Antigravity todavía no devolvió sus cuotas.', 'quota_unavailable');
  const plan = user.planStatus?.planInfo;
  return {
    ok: true, source: 'antigravity-local', updated_at: now.toISOString(),
    identity: antigravityIdentity(email), account_email: email,
    plan_type: plan?.planDisplayName ?? plan?.displayName ?? plan?.planName ?? user.userTier?.name ?? null,
    quota, quota_windows: windows, model_quotas: modelQuotas,
    session: mostUsed(windows.filter((window) => window.cadence === 'session')),
    weekly: mostUsed(windows.filter((window) => window.cadence === 'weekly')),
  };
}

// "Claude and GPT models" → "Claude + GPT", the same pool labels as the app.
const poolName = (name) => String(name || 'Cuota').replace(/\s+models?$/i, '').replace(/\s+and\s+/gi, ' + ');

export function mapAntigravityCliUsage(payload, email, now = new Date()) {
  if (payload?.status !== 'SUCCESS') {
    throw /auth/i.test(String(payload?.error ?? ''))
      ? fail('El CLI de Antigravity no tiene una sesión iniciada. Ejecuta agy en una terminal.', 'login_required')
      : fail('El CLI de Antigravity no entregó sus cuotas.', 'source_unavailable');
  }
  const groups = payload.command?.data?.groups;
  if (!Array.isArray(groups)) {
    throw fail('El CLI de Antigravity respondió en un formato desconocido. Actualízalo con agy update.', 'invalid_response');
  }
  // JSON omits a zero fraction (quota exhausted); the printed table keeps it.
  const printed = new Map(String(payload.response ?? '').split('\n').map((line) => line.split('\t'))
    .filter((cells) => /^\d+(?:\.\d+)?%$/.test(cells[2] ?? ''))
    .map((cells) => [`${cells[0]}\t${cells[1]}`, parseFloat(cells[2]) / 100]));
  const summary = { groups: groups.map((group) => ({
    displayName: poolName(group.name),
    buckets: (group.buckets ?? []).map((bucket) => ({
      bucketId: bucket.id, displayName: bucket.name, window: bucket.window, description: bucket.description,
      remaining: { remainingFraction: bucket.remaining_fraction ?? printed.get(`${group.name}\t${bucket.name}`) },
      resetTime: bucket.reset_time,
    })),
  })) };
  return { ...mapAntigravityUsage({ userStatus: { email } }, summary, now), source: 'antigravity-cli' };
}

function matchesAccount(config, snapshot) {
  return (!config.identity || config.identity === snapshot.identity)
    && (!config.expected_email || config.expected_email.trim().toLowerCase() === snapshot.account_email);
}

function flag(args, name) {
  const equal = args.find((arg) => arg.startsWith(`${name}=`));
  if (equal) return equal.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function validPort(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 && number < 65536 ? number : null;
}

export function portsFromProcTables(tables, socketInodes) {
  const ports = new Set();
  for (const table of tables) {
    for (const line of table.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== '0A' || !socketInodes.has(fields[9])) continue;
      const [host, port] = fields[1].split(':');
      // Never send a local CSRF token to a remote interface.
      if (!['00000000', '0100007F', '00000000000000000000000000000000',
        '00000000000000000000000001000000'].includes(host)) continue;
      const parsed = validPort(parseInt(port, 16));
      if (parsed) ports.add(parsed);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

export async function discoverAntigravityServers(procRoot = '/proc') {
  const entries = await fs.readdir(procRoot).catch(() => []);
  const candidates = [];
  for (const pid of entries.filter((entry) => /^\d+$/.test(entry))) {
    const directory = path.join(procRoot, pid);
    try {
      if ((await fs.stat(directory)).uid !== process.getuid()) continue;
      const args = (await fs.readFile(path.join(directory, 'cmdline'), 'utf8')).split('\0').filter(Boolean);
      const command = args.slice(0, 2).join(' ');
      const isServer = /language[_-]server/i.test(command) && args.some((arg) => /antigravity/i.test(arg));
      const isCli = /(?:^|\/)agy$/.test(args[0] || '') || /antigravity[_-]cli\//.test(command);
      if (!isServer && !isCli) continue;
      const csrfToken = flag(args, '--csrf_token') || '';
      if (!csrfToken && !isCli) continue;
      const inodes = new Set();
      const descriptors = await fs.readdir(path.join(directory, 'fd'));
      await Promise.all(descriptors.map(async (descriptor) => {
        const target = await fs.readlink(path.join(directory, 'fd', descriptor)).catch(() => '');
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match) inodes.add(match[1]);
      }));
      const tables = await Promise.all(['tcp', 'tcp6'].map((name) =>
        fs.readFile(path.join(directory, 'net', name), 'utf8').catch(() => '')));
      const ports = portsFromProcTables(tables, inodes);
      const fallbackPort = validPort(flag(args, '--extension_server_port'));
      for (const port of ports) {
        candidates.push({ port, scheme: 'https', csrfToken });
        candidates.push({ port, scheme: 'http', csrfToken });
      }
      if (fallbackPort) candidates.unshift({ port: fallbackPort, scheme: 'http',
        csrfToken: flag(args, '--extension_server_csrf_token') || csrfToken });
    } catch { /* A process exiting during discovery is normal. */ }
  }
  return candidates;
}

export function requestAntigravity(endpoint, method, timeoutMs = 1500) {
  if (!validPort(endpoint.port) || !['http', 'https'].includes(endpoint.scheme)
      || !['GetUserStatus', 'RetrieveUserQuotaSummary'].includes(method)) {
    return Promise.reject(fail('Conexión local no válida.', 'config_error'));
  }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ metadata: {
      ideName: 'antigravity', extensionName: 'antigravity', locale: 'en', ideVersion: 'unknown',
    } });
    const request = (endpoint.scheme === 'https' ? https : http).request({
      hostname: '127.0.0.1', port: endpoint.port, path: SERVICE + method, method: 'POST',
      // Antigravity uses a self-signed certificate on its own loopback server.
      // This exception is scoped to this request; global TLS stays untouched.
      rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': endpoint.csrfToken || '' },
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        data += chunk;
        if (data.length > 2 * 1024 * 1024) request.destroy(fail('Respuesta local demasiado grande.', 'invalid_response'));
      });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(fail('El servicio local no está disponible.', 'source_unavailable'));
        try { resolve(JSON.parse(data)); }
        catch { reject(fail('Respuesta local no válida.', 'invalid_response')); }
      });
      response.on('error', () => reject(fail('No se pudo leer el servicio local.', 'source_unavailable')));
    });
    const timer = setTimeout(() => request.destroy(fail('Tiempo de espera agotado.', 'source_unavailable')), timeoutMs);
    request.on('close', () => clearTimeout(timer));
    request.on('error', () => reject(fail('Antigravity no respondió a la consulta local.', 'source_unavailable')));
    request.end(body);
  });
}

export async function fetchAntigravityLocal(config = {}, dependencies = {}) {
  const discover = dependencies.discover ?? discoverAntigravityServers;
  const read = dependencies.request ?? requestAntigravity;
  const endpoints = await discover();
  if (!endpoints.length) throw fail('Abre Antigravity e inicia sesión con Google para consultar su uso.', 'app_not_running');
  const deadline = Date.now() + Math.max(1000, Math.min(30_000, Number(config.timeout_ms) || 8000));
  const snapshots = new Map();
  let mismatch = false;
  for (const endpoint of endpoints) {
    if (Date.now() >= deadline) break;
    try {
      const user = await read(endpoint, 'GetUserStatus', Math.max(1, Math.min(1200, deadline - Date.now())));
      const email = user?.userStatus?.email ?? user?.response?.userStatus?.email;
      if (!email) continue;
      const identity = antigravityIdentity(email);
      if ((config.identity && config.identity !== identity)
          || (config.expected_email && config.expected_email.trim().toLowerCase() !== email.trim().toLowerCase())) {
        mismatch = true;
        continue;
      }
      const summary = await read(endpoint, 'RetrieveUserQuotaSummary', Math.max(1, Math.min(1200, deadline - Date.now())))
        .catch(() => null);
      const snapshot = mapAntigravityUsage(user, summary);
      const rank = (value) => value.quota_windows.reduce((score, window) => score
        + (window.metric.used_percent !== null ? (window.cadence ? 100 : 1) : 0), 0);
      if (!snapshots.has(identity) || rank(snapshot) > rank(snapshots.get(identity))) snapshots.set(identity, snapshot);
      if (config.identity || config.expected_email) return snapshot;
    } catch { /* Try the next same-user loopback listener, without leaking CSRF. */ }
  }
  if (snapshots.size > 1) throw fail('Hay varias cuentas de Antigravity abiertas. Escribe el correo de la cuenta que quieres conectar.', 'account_selection_required');
  if (snapshots.size === 1) return [...snapshots.values()][0];
  if (mismatch) throw fail('La cuenta abierta en Antigravity es distinta. Abre la cuenta conectada a esta tarjeta.', 'account_mismatch');
  throw fail('No se pudieron consultar las cuotas locales. Actualiza Antigravity y vuelve a intentar.', 'source_unavailable');
}

export async function resolveAntigravityCli(config = {}, env = process.env) {
  const home = os.homedir();
  const configured = config.cli_path?.replace(/^~(?=$|\/)/, home);
  const candidates = configured ? [configured] : [path.join(home, '.local', 'bin', 'agy'),
    ...String(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, 'agy'))];
  for (const candidate of candidates) {
    if (await fs.access(candidate, fs.constants.X_OK).then(() => true, () => false)) return candidate;
  }
  throw fail(`No se encontró el CLI de Antigravity (agy). Instálalo con: ${ANTIGRAVITY_CLI_INSTALL}`, 'cli_missing');
}

// Without a saved session agy opens a browser for Google sign-in. A background
// refresh must never do that: URL openers resolve to a private no-op and the
// run stops at the sign-in prompt. The temporary log, which names the signed-in
// account, keeps per-run logs out of ~/.gemini and is deleted afterwards.
export async function readAntigravityCli(command, timeoutMs = 20_000,
  workRoot = path.join(os.homedir(), '.cache', 'ai-usage-status')) {
  await fs.mkdir(workRoot, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(workRoot, 'agy-'));
  try {
    const shims = path.join(directory, 'bin');
    const opener = path.join(shims, 'xdg-open');
    await fs.mkdir(shims);
    await fs.writeFile(opener, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    await Promise.all(['x-www-browser', 'www-browser', 'sensible-browser']
      .map((name) => fs.symlink(opener, path.join(shims, name))));
    const logFile = path.join(directory, 'agy.log');
    const env = { ...process.env, PATH: `${shims}${path.delimiter}${process.env.PATH ?? ''}`, BROWSER: opener };
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(command, ['-p', '/usage', '--output-format', 'json', '--log-file', logFile],
        { cwd: os.homedir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let errors = '';
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.exitCode === null) child.kill();
        if (error) reject(error); else resolve(output);
      };
      const timer = setTimeout(() => finish(fail('El CLI de Antigravity no respondió a tiempo.', 'source_unavailable')), timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.length > 2 * 1024 * 1024) finish(fail('Respuesta del CLI demasiado grande.', 'invalid_response'));
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        errors = `${errors}${chunk}`.slice(-4000);
        if (CLI_AUTH_PROMPT.test(errors)) {
          finish(fail('El CLI de Antigravity no tiene una sesión iniciada. Ejecuta agy en una terminal.', 'login_required'));
        }
      });
      child.on('error', (error) => finish(fail(`No se pudo ejecutar agy: ${error.message}`, 'source_unavailable')));
      child.on('close', () => finish(null));
    });
    let payload;
    try { payload = JSON.parse(stdout); }
    catch { throw fail('El CLI de Antigravity respondió en un formato desconocido. Actualízalo con agy update.', 'invalid_response'); }
    const log = await fs.readFile(logFile, 'utf8').catch(() => '');
    return { payload, email: CLI_ACCOUNT.exec(log)?.[1]?.trim().toLowerCase() ?? null };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function fetchAntigravityCli(config = {}, dependencies = {}) {
  const command = await (dependencies.resolve ?? resolveAntigravityCli)(config);
  const timeoutMs = Math.max(1000, Math.min(60_000, Number(config.cli_timeout_ms) || 20_000));
  const { payload, email } = await (dependencies.read ?? readAntigravityCli)(command, timeoutMs);
  if (payload?.status === 'SUCCESS' && !email) {
    // Never show quotas without knowing whose they are.
    throw fail('No se pudo identificar la cuenta del CLI de Antigravity. Actualízalo con agy update.', 'invalid_response');
  }
  const snapshot = mapAntigravityCliUsage(payload, email);
  if (!matchesAccount(config, snapshot)) {
    throw fail('El CLI de Antigravity tiene iniciada otra cuenta de Google.', 'account_mismatch');
  }
  return snapshot;
}

// The CLI works with the desktop app closed, so it goes first. The app covers
// machines without agy, or with a different Google account signed in to it.
export async function fetchAntigravity(config = {}, dependencies = {}) {
  let cliError;
  try {
    return await (dependencies.cli ?? fetchAntigravityCli)(config);
  } catch (error) {
    cliError = error;
  }
  try {
    return await (dependencies.app ?? fetchAntigravityLocal)(config);
  } catch (error) {
    // With the app closed, the CLI failure is the actionable one.
    throw error.code === 'app_not_running' ? cliError : error;
  }
}
