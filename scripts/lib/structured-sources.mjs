import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const HOME = os.homedir();
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// GET only: the same balance read Claude Code does for its usage screen. The
// sibling POST .../contracts/prepaid/credits *buys* credits; never call it.
const CLAUDE_PREPAID_URL = 'https://api.anthropic.com/api/oauth/organizations/{org}/prepaid/credits';
const CLAUDE_BETA_HEADER = 'oauth-2025-04-20';
const CLAUDE_PREPAID_TIMEOUT_MS = 5000;

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
    // A window without usage and without a reset time has not started yet:
    // it begins with the first message. The UI shows it as "sin iniciar"
    // instead of a meaningless "0 % usado".
    state: used === 0 && resetEpoch === null ? 'idle' : 'active',
  };
}

function roundMoney(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// 29 minor units with exponent 2 → 0.29.
function minorUnits(amountMinor, exponent) {
  const minor = finiteNumber(amountMinor);
  return minor === null ? null : roundMoney(minor / 10 ** exponent, exponent);
}

// `{ amount_minor: 29, exponent: 2 }` → 0.29. Plain numbers are taken as
// already-scaled amounts.
function moneyAmount(value, fallbackExponent = 2) {
  if (value && typeof value === 'object') {
    return minorUnits(value.amount_minor, finiteNumber(value.exponent) ?? fallbackExponent);
  }
  return finiteNumber(value);
}

/**
 * Normalized spend block shared by every provider and by the web fallback.
 * Amounts are already scaled to the currency unit.
 *
 * - balance: prepaid credits the account has (Claude: "Créditos de uso").
 * - limit/spent: the monthly *spending limit* and what was spent against it.
 *   The limit is a cap, not money: it never counts as available.
 * - available: what can be spent right now, i.e. the balance capped by what
 *   is left of the monthly limit; null while the balance is unknown.
 */
export function billingSummary({
  currency = 'USD',
  spent = null,
  limit = null,
  balance = null,
  percent = null,
  period = 'monthly',
  limitReached = false,
  autoReload = null,
  decimals = 2,
} = {}) {
  if (spent === null && limit === null && balance === null) return null;
  const limitRemaining = limit !== null && spent !== null
    ? roundMoney(Math.max(0, limit - spent), decimals)
    : null;
  const available = balance === null
    ? null
    : limitRemaining === null ? balance : Math.min(balance, limitRemaining);
  const computedPercent = percent ?? (
    limit !== null && limit > 0 && spent !== null ? roundMoney((spent / limit) * 100, 2) : null
  );
  return {
    currency,
    balance,
    available,
    spent,
    limit,
    limit_remaining: limitRemaining,
    percent: computedPercent,
    period,
    limit_reached: limitReached === true || limitRemaining === 0,
    auto_reload: autoReload,
  };
}

// Balance from GET .../prepaid/credits: `amount` is in minor units (cents).
function prepaidBalance(prepaid, fallbackExponent) {
  const exponent = finiteNumber(prepaid?.balance?.credits?.exponent)
    ?? finiteNumber(prepaid?.balance?.money?.exponent)
    ?? fallbackExponent;
  return minorUnits(prepaid?.amount, exponent);
}

function claudeExtraUsageEnabled(payload) {
  return payload?.extra_usage?.is_enabled === true || payload?.spend?.enabled === true;
}

function mapClaudeBilling(payload, prepaid) {
  const extra = payload?.extra_usage;
  const spend = payload?.spend;
  if (!claudeExtraUsageEnabled(payload)) return null;

  const decimals = finiteNumber(spend?.used?.exponent)
    ?? finiteNumber(extra?.decimal_places)
    ?? 2;
  return billingSummary({
    currency: spend?.used?.currency ?? extra?.currency ?? 'USD',
    spent: spend?.used
      ? moneyAmount(spend.used, decimals)
      : minorUnits(extra?.used_credits, decimals),
    limit: spend?.limit
      ? moneyAmount(spend.limit, decimals)
      : minorUnits(extra?.monthly_limit, decimals),
    // /usage does not report the balance (`spend.balance` is null even with
    // purchased credits); it comes from the prepaid endpoint when available.
    balance: prepaid ? prepaidBalance(prepaid, decimals) : moneyAmount(spend?.balance, decimals),
    // `extra_usage.utilization` keeps decimals (0.29); `spend.percent` is
    // rounded to an integer and would show small spends as 0 %.
    percent: finiteNumber(extra?.utilization) ?? finiteNumber(spend?.percent),
    limitReached: extra?.spend_limit_reached === true,
    autoReload: prepaid ? prepaid.auto_reload_settings?.enabled === true : null,
    decimals,
  });
}

function mapClaudeBreakdown(payload) {
  const rows = payload?.seven_day_breakdown?.rows;
  if (!Array.isArray(rows)) return null;
  const mapped = rows
    .map((row) => ({
      key: String(row?.key ?? ''),
      name: String(row?.display_name ?? row?.key ?? ''),
      percent: finiteNumber(row?.percent),
    }))
    .filter((row) => row.name && row.percent !== null);
  return mapped.length > 0 ? mapped : null;
}

function mapCodexResetCredits(payload) {
  const container = payload?.rateLimitResetCredits;
  if (!container) return null;
  const available = Array.isArray(container.credits)
    ? container.credits.filter((credit) => !credit?.status || credit.status === 'available')
    : [];
  const count = finiteNumber(container.availableCount) ?? available.length;
  if (!count) return null;
  const expiries = available
    .map((credit) => finiteNumber(credit?.expiresAt))
    .filter((value) => value !== null);
  return {
    available: count,
    title: available.find((credit) => credit?.title)?.title ?? null,
    next_expiry_epoch: expiries.length > 0 ? Math.min(...expiries) : null,
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
  // Codex credits are units, not money; keep them apart from `billing`.
  const credits = rateLimits.credits
    ? {
      balance: finiteNumber(rateLimits.credits.balance) ?? 0,
      has_credits: rateLimits.credits.hasCredits === true,
      unlimited: rateLimits.credits.unlimited === true,
    }
    : null;

  return {
    ok: true,
    source: 'codex-cli',
    updated_at: now.toISOString(),
    five_hour: fiveHour,
    weekly,
    // Legacy field (schema v1): only set while the account has credits.
    credits_remaining: balance,
    credits,
    plan_type: rateLimits.planType ?? null,
    reset_credits_available: finiteNumber(payload?.rateLimitResetCredits?.availableCount),
    reset_credits: mapCodexResetCredits(payload),
    limit_reached: rateLimits.spendControlReached === true || Boolean(rateLimits.rateLimitReachedType),
    limit_reached_type: rateLimits.rateLimitReachedType ?? null,
  };
}

export function mapClaudeOAuthUsage(payload, credentials = {}, now = new Date(), prepaid = null) {
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

  const billing = mapClaudeBilling(payload, prepaid);
  // Legacy shape (schema v1) kept so an older widget keeps rendering.
  const credits = billing
    ? {
      enabled: true,
      spent_usd: billing.spent,
      spent_percent: billing.percent,
      limit_usd: billing.limit,
      balance_usd: billing.balance,
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
    billing,
    weekly_breakdown: mapClaudeBreakdown(payload),
    plan_type: credentials.subscriptionType ?? credentials.rateLimitTier ?? null,
    token_expires_at: Number.isFinite(Number(credentials.expiresAt))
      ? new Date(Number(credentials.expiresAt)).toISOString()
      : null,
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

export async function resolveCodexCommand(config = {}) {
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

  // Desktop integrations often bundle the same Codex CLI/app-server without
  // publishing a `codex` command in PATH. Prefer stable package locations and
  // finally Zed's managed external-agent launcher before falling back to web.
  const bundledCandidates = [
    '/usr/lib/chatgpt/resources/codex',
    '/opt/chatgpt/resources/codex',
    path.join(
      HOME,
      '.local',
      'share',
      'zed',
      'external_agents',
      'registry',
      'npx',
      'codex-acp',
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js',
    ),
  ];
  for (const candidate of bundledCandidates) {
    if (await executableExists(candidate)) return candidate;
  }

  throw sourceError('No se encontró el CLI de Codex.');
}

function readCodexAppServer(command, timeoutMs, config = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    const args = ['app-server'];
    if (config.codex_home) {
      env.CODEX_HOME = expandHome(config.codex_home);
      for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']) delete env[key];
      args.push('-c', 'cli_auth_credentials_store="file"');
    }
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
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
          version: '0.5.3',
        },
      },
    });
  });
}

export async function fetchCodexCli(config = {}) {
  const command = await resolveCodexCommand(config);
  const timeoutMs = Number(config.cli_timeout_ms) || 15_000;
  return mapCodexRateLimits(await readCodexAppServer(command, timeoutMs, config));
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

function claudeHeaders(accessToken) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'anthropic-beta': CLAUDE_BETA_HEADER,
    'User-Agent': 'claude-code/2.1.0',
  };
}

// Best effort: the balance is extra information, so any failure just leaves
// it unknown instead of failing the whole Claude reading.
async function fetchClaudePrepaid(config, accessToken) {
  const accountFile = expandHome(config.claude_account_file ?? '~/.claude.json');
  let organizationUuid;
  try {
    organizationUuid = JSON.parse(await fs.readFile(accountFile, 'utf8'))
      ?.oauthAccount?.organizationUuid;
  } catch {
    return null;
  }
  if (!organizationUuid) return null;

  try {
    const response = await fetchWithTimeout(
      CLAUDE_PREPAID_URL.replace('{org}', encodeURIComponent(organizationUuid)),
      { method: 'GET', headers: claudeHeaders(accessToken) },
      CLAUDE_PREPAID_TIMEOUT_MS,
    );
    if (!response.ok) return null;
    const data = await response.json();
    return finiteNumber(data?.amount) === null ? null : data;
  } catch {
    return null;
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
    throw sourceError('No pude leer las credenciales OAuth de esta cuenta de Claude.');
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
      headers: claudeHeaders(credentials.accessToken),
    }, Number(config.oauth_timeout_ms) || 30_000);
  } catch (error) {
    throw sourceError(`Claude OAuth no respondió: ${error.message}`, 'network_error');
  }

  if (response.status === 401) throw sourceError('Claude OAuth requiere iniciar sesión.', 'login_required');
  if (response.status === 403) throw sourceError('Claude OAuth rechazó los permisos.', 'oauth_scope_missing');
  if (response.status === 429) throw sourceError('Claude OAuth limitó temporalmente las consultas.', 'rate_limited');
  if (!response.ok) throw sourceError(`Claude OAuth respondió HTTP ${response.status}.`, 'network_error');

  const payload = await response.json();
  const prepaid = claudeExtraUsageEnabled(payload)
    ? await fetchClaudePrepaid(config, credentials.accessToken)
    : null;
  return mapClaudeOAuthUsage(payload, credentials, new Date(), prepaid);
}
