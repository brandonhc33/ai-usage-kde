import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const HOME = os.homedir();
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_BETA_HEADER = 'oauth-2025-04-20';

function sourceError(message, code = 'source_unavailable') {
  return Object.assign(new Error(message), { code });
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function expandHome(value) {
  return value?.replace(/^~(?=$|\/)/, HOME);
}

function resetLabel(epochSeconds) {
  const epoch = finiteNumber(epochSeconds);
  if (epoch === null) return null;
  return new Intl.DateTimeFormat('es-CL', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(epoch * 1000));
}

function metric(usedPercent, resetValue, resetIsEpoch = true) {
  const used = finiteNumber(usedPercent);
  if (used === null) return null;
  const resetEpoch = resetIsEpoch
    ? finiteNumber(resetValue)
    : (() => {
      const parsed = Date.parse(resetValue);
      return Number.isFinite(parsed) ? Math.round(parsed / 1000) : null;
    })();
  return {
    used_percent: used,
    remaining_percent: Math.max(0, 100 - used),
    reset_label: resetLabel(resetEpoch),
    reset_epoch: resetEpoch,
  };
}

export function mapCodexRateLimits(payload, now = new Date()) {
  const rateLimits = payload?.rateLimitsByLimitId?.codex ?? payload?.rateLimits;
  if (!rateLimits) throw sourceError('Codex no devolvió límites de uso.', 'invalid_response');

  const windows = [rateLimits.primary, rateLimits.secondary].filter(Boolean);
  let fiveHour = null;
  let weekly = null;

  for (const window of windows) {
    const duration = finiteNumber(window.windowDurationMins);
    const mapped = metric(window.usedPercent, window.resetsAt);
    if (!mapped) continue;

    if (duration !== null && duration <= 24 * 60) {
      fiveHour ??= mapped;
    } else if (duration !== null && duration >= 6 * 24 * 60) {
      weekly ??= mapped;
    } else if (!fiveHour && windows.length > 1) {
      fiveHour = mapped;
    } else {
      weekly ??= mapped;
    }
  }

  if (!fiveHour && !weekly) {
    throw sourceError('Codex devolvió límites sin porcentajes utilizables.', 'invalid_response');
  }

  const balance = rateLimits.credits?.hasCredits
    ? finiteNumber(rateLimits.credits.balance)
    : null;

  return {
    ok: true,
    source: 'codex-cli',
    updated_at: now.toISOString(),
    five_hour: fiveHour,
    weekly,
    credits_remaining: balance,
    plan_type: rateLimits.planType ?? null,
    reset_credits_available: finiteNumber(payload?.rateLimitResetCredits?.availableCount),
  };
}

export function mapClaudeOAuthUsage(payload, credentials = {}, now = new Date()) {
  const session = metric(payload?.five_hour?.utilization, payload?.five_hour?.resets_at, false);
  const weekly = metric(payload?.seven_day?.utilization, payload?.seven_day?.resets_at, false);
  const routinePayload = payload?.seven_day_routines
    ?? payload?.seven_day_cowork
    ?? payload?.limits?.find((entry) => entry?.kind === 'weekly_routines');
  const routines = routinePayload
    ? metric(
      routinePayload.utilization ?? routinePayload.percent,
      routinePayload.resets_at,
      false,
    )
    : null;

  if (!session && !weekly) {
    throw sourceError('Claude no devolvió límites de uso.', 'invalid_response');
  }

  const extra = payload?.extra_usage;
  const credits = extra?.is_enabled === true
    ? {
      enabled: true,
      spent_usd: finiteNumber(extra.used_credits) === null ? null : finiteNumber(extra.used_credits) / 100,
      spent_percent: finiteNumber(extra.utilization),
      limit_usd: finiteNumber(extra.monthly_limit) === null ? null : finiteNumber(extra.monthly_limit) / 100,
      balance_usd: null,
      reset_label: null,
    }
    : null;

  return {
    ok: true,
    source: 'claude-oauth',
    updated_at: now.toISOString(),
    session,
    weekly,
    routines,
    daily_routines: null,
    credits,
    plan_type: credentials.subscriptionType ?? credentials.rateLimitTier ?? null,
  };
}

async function executableExists(candidate) {
  if (!candidate) return false;
  try {
    await fs.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCodexCommand(config) {
  const configured = expandHome(config.cli_path);
  if (configured) {
    if (await executableExists(configured)) return configured;
    throw sourceError(`No existe el ejecutable Codex configurado: ${configured}`);
  }

  const installedLink = path.join(HOME, '.local', 'bin', 'codex');
  if (await executableExists(installedLink)) return installedLink;

  for (const directory of String(process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(directory, 'codex');
    if (await executableExists(candidate)) return candidate;
  }

  throw sourceError('No se encontró el CLI de Codex.');
}

function readCodexAppServer(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const lines = readline.createInterface({ input: child.stdout });
    let stderr = '';
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      callback(value);
    };

    const fail = (error) => finish(reject, error);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => {
      fail(sourceError(`Codex app-server no respondió en ${timeoutMs} ms.`, 'network_error'));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on('error', (error) => fail(sourceError(`No se pudo ejecutar Codex: ${error.message}`)));
    child.on('exit', (code) => {
      if (!settled) {
        fail(sourceError(`Codex app-server terminó con código ${code}: ${stderr.trim()}`));
      }
    });

    lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.id === 0 && message.result) {
        send({ method: 'initialized', params: {} });
        send({ method: 'account/rateLimits/read', id: 1, params: null });
      } else if (message.id === 0 && message.error) {
        fail(sourceError(`Codex rechazó la inicialización: ${message.error.message}`));
      } else if (message.id === 1 && message.result) {
        finish(resolve, message.result);
      } else if (message.id === 1 && message.error) {
        const code = /login|auth|account/i.test(message.error.message ?? '')
          ? 'login_required'
          : 'source_unavailable';
        fail(sourceError(`Codex no entregó límites: ${message.error.message}`, code));
      }
    });

    send({
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: {
          name: 'ai_usage_kde',
          title: 'AI Usage KDE',
          version: '0.3.0',
        },
      },
    });
  });
}

export async function fetchCodexCli(config = {}) {
  const command = await resolveCodexCommand(config);
  const timeoutMs = Number(config.cli_timeout_ms) || 15_000;
  return mapCodexRateLimits(await readCodexAppServer(command, timeoutMs));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchClaudeOAuth(config = {}) {
  const credentialsPath = expandHome(
    config.oauth_credentials_file ?? '~/.claude/.credentials.json',
  );
  let root;
  try {
    root = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw sourceError('No existe ~/.claude/.credentials.json.');
    throw sourceError(`No pude leer credenciales OAuth de Claude: ${error.message}`);
  }

  const credentials = root?.claudeAiOauth;
  if (!credentials?.accessToken) throw sourceError('Las credenciales de Claude no incluyen OAuth.');
  if (!credentials.scopes?.includes('user:profile')) {
    throw sourceError('El token de Claude no tiene el scope user:profile.', 'oauth_scope_missing');
  }
  if (Number(credentials.expiresAt) <= Date.now()) {
    throw sourceError('El token OAuth de Claude expiró.', 'oauth_expired');
  }

  let response;
  try {
    response = await fetchWithTimeout(CLAUDE_USAGE_URL, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credentials.accessToken}`,
        'anthropic-beta': CLAUDE_BETA_HEADER,
        'User-Agent': 'claude-code/2.1.0',
      },
    }, Number(config.oauth_timeout_ms) || 30_000);
  } catch (error) {
    throw sourceError(`Claude OAuth no respondió: ${error.message}`, 'network_error');
  }

  if (response.status === 401) throw sourceError('Claude OAuth requiere iniciar sesión.', 'login_required');
  if (response.status === 403) throw sourceError('Claude OAuth rechazó los permisos.', 'oauth_scope_missing');
  if (response.status === 429) throw sourceError('Claude OAuth limitó temporalmente las consultas.', 'rate_limited');
  if (!response.ok) throw sourceError(`Claude OAuth respondió HTTP ${response.status}.`, 'network_error');

  return mapClaudeOAuthUsage(await response.json(), credentials);
}
