// Read-only local Antigravity quota service. No prompts, OAuth grants, or
// remote endpoints. CSRF tokens are read only from same-user processes and
// are never persisted or returned in the public snapshot.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';

const SERVICE = '/exa.language_server_pb.LanguageServerService/';
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
  return {
    used_percent: remaining === null ? null : Math.round((100 - remaining) * 100) / 100,
    remaining_percent: remaining,
    reset_epoch: resetEpoch(reset),
    reset_label: resetEpoch(reset) === null ? description || null : null,
    state: remaining === null ? 'unavailable' : 'active',
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
