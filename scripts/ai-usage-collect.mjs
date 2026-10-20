#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  browserExecutableFingerprint,
  clearStaleSingletonLock,
  isBrowserProcessCrash,
  resolveBrowserLaunchOptions,
} from './lib/chrome-profile.mjs';
import {
  recordFailure,
  recordSuccess,
  webBackoffUntil,
} from './lib/provider-state.mjs';
import { fetchClaudeOAuth, fetchCodexCli } from './lib/structured-sources.mjs';
import { fetchAntigravityLocal } from './lib/antigravity.mjs';
import { readAccountEmail } from './lib/account-identity.mjs';
import {
  DEFAULT_CONFIG, normalizeConfig, publicAccount, disconnectedAccount, acquireLock, loadConfig,
  updateLegacyProviders,
} from './lib/accounts.mjs';
import { withDisplay } from './lib/xvfb.mjs';
import {
  CLAUDE_READY,
  CODEX_READY,
  claudeBillingFromCredits,
  parseClaude,
  parseCodex,
} from './lib/web-parsers.mjs';

const HOME = os.homedir();
const CACHE_DIR = path.join(HOME, '.cache', 'ai-usage-status');
const CONFIG_DIR = path.join(HOME, '.config', 'ai-usage-status');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const OUT_FILE = path.join(CACHE_DIR, 'status.json');
const LAST_GOOD_FILE = path.join(CACHE_DIR, 'last-good-status.json');
const LOCK_FILE = path.join(CACHE_DIR, 'collector.lock');
const ERROR_LOG_FILE = path.join(CACHE_DIR, 'errors.log');
const BROWSER_DISPLAY_MODE_FILE = path.join(CACHE_DIR, 'browser-display-mode.json');
const PROVIDER_STATE_FILE = path.join(CACHE_DIR, 'provider-state.json');
const GENERIC_FETCH_ERROR = 'No se obtuvo la información.';
const SCHEMA_VERSION = 3;
const WINDOW_KEYS = ['five_hour', 'weekly', 'session', 'routines', 'quota'];

// --force: manual refresh, ignores the web-fallback backoff.
// --if-older-than <s>: periodic refresh from the widget; does nothing when
// status.json was written less than <s> seconds ago (e.g. by the systemd
// timer), so two schedulers do not double the work.
const ARGS = process.argv.slice(2);
const FORCE = ARGS.includes('--force');
const IF_OLDER_THAN_SECONDS = (() => {
  const index = ARGS.indexOf('--if-older-than');
  if (index === -1) return null;
  const seconds = Number(ARGS[index + 1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
})();

// Loaded in main(); see lib/provider-state.mjs.
let providerState = {};

function expandHome(value) {
  return value?.replace(/^~(?=$|\/)/, HOME);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function ensureDefaultConfig() {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(CONFIG_FILE, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

function classifyError(error) {
  if (error?.code) return error.code;
  const message = String(error?.message ?? error);
  if (isBrowserProcessCrash(error)) return 'browser_crashed';
  if (/timeout|timed out|net::|ERR_/i.test(message)) return 'network_error';
  return 'collector_error';
}

async function appendErrorLog(provider, error, extra = {}) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
    const stats = await fs.stat(ERROR_LOG_FILE).catch(() => null);
    if (stats?.size > 256 * 1024) {
      await fs.rm(`${ERROR_LOG_FILE}.1`, { force: true });
      await fs.rename(ERROR_LOG_FILE, `${ERROR_LOG_FILE}.1`);
    }
    const entry = {
      time: new Date().toISOString(),
      provider,
      code: classifyError(error),
      message: String(error?.message ?? error),
      stack: error?.stack ?? null,
      ...extra,
    };
    await fs.appendFile(ERROR_LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (logError) {
    console.error(`No pude escribir ${ERROR_LOG_FILE}:`, logError);
  }
}

// Logs only the first failure of an incident; repeated runs with the same
// code just bump the counter in provider-state.json.
async function reportFailure(provider, error, extra = {}) {
  const { state, shouldLog, entry } = recordFailure(
    providerState,
    provider,
    classifyError(error),
    extra.phase ?? null,
  );
  providerState = state;
  if (shouldLog) {
    await appendErrorLog(provider, error, extra);
  } else {
    console.warn(`${provider}: ${entry.code} se repite (${entry.count} veces desde ${entry.first_at}).`);
  }
}

async function acquireCollectorLock() {
  try {
    return await acquireLock(LOCK_FILE);
  } catch (error) {
    if (error.code === 'operation_in_progress') {
      console.log('ai-usage-collect: ya hay una operación en curso.');
      return null;
    }
    throw error;
  }
}

function publicError(provider, error) {
  return {
    provider,
    code: classifyError(error),
    message: GENERIC_FETCH_ERROR,
  };
}

/**
 * Espera a que el texto de uso esté presente en la página y lo devuelve
 * apenas aparece, en vez de esperar siempre `maxMs` fijos. Sondea cada
 * `POLL_MS` y se rinde a los `maxMs` (devolviendo lo último que haya, así
 * la detección de login_required sigue funcionando). Esto reduce el tiempo
 * típico de scraping de ~8 s a ~1-3 s sin tocar el techo de seguridad, lo
 * que abarata cada corrida del recolector.
 */
const POLL_MS = 250;
async function waitForUsageText(page, readyPattern, maxMs) {
  const deadline = Date.now() + maxMs;
  let text = '';
  for (;;) {
    text = await page.locator('body').innerText({ timeout: 30_000 });
    if (readyPattern.test(text) || Date.now() >= deadline) {
      return text;
    }
    await page.waitForTimeout(POLL_MS);
  }
}

const LOGIN_URL = /\/(login|log-in|signin|sign-in|auth)\b/i;
const LOGIN_TEXT = /iniciar sesión|log in|sign in|sign up/i;

async function writeDebugText(name, text) {
  await fs.writeFile(path.join(CACHE_DIR, `debug-${name}-text.txt`), text, { mode: 0o600 });
}

async function scrapeProvider(name, providerConfig, parser, readyPattern, fallbackFrom = null) {
  const profileDir = expandHome(providerConfig.profile_dir);
  try {
    // Playwright es una dependencia pesada y solo se carga si una fuente
    // estructurada no está disponible.
    const { chromium } = await import('playwright');
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    const browserLaunchOptions = await resolveBrowserLaunchOptions();
    const compatibilityKey = await browserExecutableFingerprint(
      browserLaunchOptions.executablePath,
    );

    return await withDisplay(async (display) => {
      // A failed Chrome launch can leave Singleton* files behind. This must
      // run for both the first attempt and an automatic headless retry.
      await clearStaleSingletonLock(profileDir);
      const context = await chromium.launchPersistentContext(profileDir, {
        // Mismo motivo que en ai-usage-auth.mjs: el Chrome real evita los
        // desafíos "Verify you are human" de Cloudflare que bloquean al
        // Chromium de Playwright.
        ...browserLaunchOptions,
        headless: display.headless ?? providerConfig.headless !== false,
        viewport: { width: 1280, height: 900 },
        args: ['--disable-blink-features=AutomationControlled', ...(display.args ?? [])],
        env: display.env,
      });

      try {
        const page = await context.newPage();
        await page.goto(providerConfig.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        const text = await waitForUsageText(page, readyPattern, providerConfig.wait_ms ?? 8000);

        // A page that already shows usage is logged in, even if a footer or
        // upsell button says "Sign up". Otherwise trust the URL first.
        if (!readyPattern.test(text) && (LOGIN_URL.test(page.url()) || LOGIN_TEXT.test(text))) {
          throw Object.assign(
            new Error(`${name} requiere iniciar sesión.`),
            { code: 'login_required' },
          );
        }

        if (providerConfig.debug_text) {
          await writeDebugText(name, text);
        }

        try {
          return parser(text);
        } catch (error) {
          // Keep the text of the last unparsable page (0600; may include the
          // account name) so a parser fixture can be written from it.
          if (error?.code === 'page_changed' && !providerConfig.debug_text) {
            await writeDebugText(name, text).catch(() => {});
          }
          throw error;
        }
      } finally {
        await context.close().catch(() => {});
      }
    }, {
      compatibilityKey,
      recoveryFile: BROWSER_DISPLAY_MODE_FILE,
      shouldRetryHeadless: isBrowserProcessCrash,
      onHeadlessRecovery: () => {
        console.warn(
          `${name}: Chrome falló sobre Xvfb; reintentando en modo headless compatible.`,
        );
      },
    });
  } catch (error) {
    await reportFailure(name, error, {
      phase: 'scrape',
      ...(fallbackFrom ? { fallback_from: fallbackFrom } : {}),
    });
    return providerFailure('web', error);
  }
}

function providerFailure(source, error) {
  return {
    ok: false,
    source,
    updated_at: new Date().toISOString(),
    error_code: classifyError(error),
    error_message: GENERIC_FETCH_ERROR,
  };
}

async function collectProvider(
  name,
  providerConfig,
  structuredSource,
  structuredFetcher,
  parser,
  readyPattern,
) {
  const configuredSource = providerConfig.source ?? 'auto';
  const source = process.env.AI_USAGE_STRUCTURED_ONLY === '1' && configuredSource === 'auto'
    ? structuredSource
    : configuredSource;
  const allowedSources = new Set(['auto', structuredSource, 'web']);
  if (!allowedSources.has(source)) {
    const error = Object.assign(
      new Error(`Fuente '${source}' no válida para ${name}.`),
      { code: 'config_error' },
    );
    await reportFailure(name, error, { phase: 'config' });
    return providerFailure(source, error);
  }

  let fallbackFrom = null;
  if (source === 'auto' || source === structuredSource) {
    try {
      return await structuredFetcher(providerConfig);
    } catch (error) {
      // Claude Code only renews its token while it is being used. Until the
      // first use of the day the token is expired; scraping claude.ai then
      // fails every two minutes, so keep the last snapshot instead.
      if (classifyError(error) === 'oauth_expired' && providerConfig.on_oauth_expired !== 'web') {
        await reportFailure(name, error, { phase: structuredSource });
        return { ...providerFailure(structuredSource, error), keep_last: true };
      }
      if (source === structuredSource) {
        await reportFailure(name, error, { phase: structuredSource });
        return providerFailure(structuredSource, error);
      }
      fallbackFrom = {
        source: structuredSource,
        code: classifyError(error),
        message: String(error?.message ?? error),
      };
      console.warn(
        `${name}: ${structuredSource} no disponible (${fallbackFrom.code}); usando fallback web.`,
      );
    }
  }

  const backoffUntil = webBackoffUntil(providerState[name]);
  if (!FORCE && Date.now() < backoffUntil) {
    console.warn(
      `${name}: fallback web en pausa hasta ${new Date(backoffUntil).toISOString()} `
      + `tras ${providerState[name].count} fallos (${providerState[name].code}).`,
    );
    return {
      ...providerFailure('web', { code: providerState[name].code }),
      backoff_until: new Date(backoffUntil).toISOString(),
    };
  }

  return scrapeProvider(name, providerConfig, parser, readyPattern, fallbackFrom);
}

function buildPrimary(config, status) {
  const providerName = config.primary?.provider ?? 'codex';
  const configuredMetricName = config.primary?.metric ?? 'five_hour';
  const provider = status.accounts?.find((account) => account.provider === providerName && account.ok)
    ?? status[providerName];
  let metricName = configuredMetricName;
  let metric = provider?.[metricName];
  if (!metricHasUsableData(metric)) {
    const fallbackNames = providerName === 'codex'
      ? ['five_hour', 'weekly']
      : providerName === 'antigravity' ? ['quota', 'session', 'weekly'] : ['session', 'weekly'];
    metricName = fallbackNames.find((name) => metricHasUsableData(provider?.[name])) ?? configuredMetricName;
    metric = provider?.[metricName];
  }
  const used = metric?.used_percent ?? null;
  const remaining = metric?.remaining_percent ?? null;

  return {
    provider: provider?.ok ? providerName : 'none',
    metric: provider?.ok ? metricName : 'none',
    used_percent: used,
    remaining_percent: remaining,
    label: used === null ? '--' : `${Math.round(used)}%`,
  };
}

function hasObtainedValue(value) {
  return value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '');
}

function valueOrPrevious(value, previousValue) {
  return hasObtainedValue(value) ? value : previousValue;
}

function metricHasUsableData(metric) {
  return Boolean(metric) && (
    hasObtainedValue(metric.used_percent) ||
    hasObtainedValue(metric.remaining_percent) ||
    hasObtainedValue(metric.reset_label) ||
    hasObtainedValue(metric.reset_epoch)
  );
}

function routinesHasUsableData(routines) {
  return Boolean(routines) && (
    hasObtainedValue(routines.used) ||
    hasObtainedValue(routines.limit)
  );
}

function creditsHasUsableData(credits) {
  return Boolean(credits) && (
    hasObtainedValue(credits.spent_usd) ||
    hasObtainedValue(credits.spent_percent) ||
    hasObtainedValue(credits.limit_usd) ||
    hasObtainedValue(credits.balance_usd) ||
    hasObtainedValue(credits.reset_label)
  );
}

function providerHasUsableData(provider) {
  if (provider?.ok !== true) return false;

  return (
    hasObtainedValue(provider.billing?.spent) ||
    hasObtainedValue(provider.billing?.balance) ||
    metricHasUsableData(provider.five_hour) ||
    metricHasUsableData(provider.weekly) ||
    metricHasUsableData(provider.session) ||
    metricHasUsableData(provider.quota) ||
    (provider.quota_windows ?? []).some((window) => metricHasUsableData(window.metric)) ||
    metricHasUsableData(provider.routines) ||
    routinesHasUsableData(provider.daily_routines) ||
    creditsHasUsableData(provider.credits) ||
    hasObtainedValue(provider.credits_remaining)
  );
}

function mergeMetric(metric, previousMetric) {
  if (!metric) return previousMetric ?? metric;
  if (!previousMetric) return metric;

  const merged = {
    ...metric,
    used_percent: valueOrPrevious(metric.used_percent, previousMetric.used_percent),
    remaining_percent: valueOrPrevious(metric.remaining_percent, previousMetric.remaining_percent),
  };

  if (hasObtainedValue(metric.reset_label)) {
    merged.reset_label = metric.reset_label;
    merged.reset_epoch = hasObtainedValue(metric.reset_epoch) ? metric.reset_epoch : null;
  } else {
    merged.reset_label = valueOrPrevious(metric.reset_label, previousMetric.reset_label);
    merged.reset_epoch = valueOrPrevious(metric.reset_epoch, previousMetric.reset_epoch);
  }

  return merged;
}

function mergeRoutines(routines, previousRoutines) {
  if (!routines) return previousRoutines ?? routines;
  if (!previousRoutines) return routines;

  return {
    ...routines,
    used: valueOrPrevious(routines.used, previousRoutines.used),
    limit: valueOrPrevious(routines.limit, previousRoutines.limit),
  };
}

function mergeCredits(credits, previousCredits) {
  if (!credits) return previousCredits ?? credits;
  if (!previousCredits) return credits;

  return {
    ...credits,
    spent_usd: valueOrPrevious(credits.spent_usd, previousCredits.spent_usd),
    spent_percent: valueOrPrevious(credits.spent_percent, previousCredits.spent_percent),
    limit_usd: valueOrPrevious(credits.limit_usd, previousCredits.limit_usd),
    balance_usd: valueOrPrevious(credits.balance_usd, previousCredits.balance_usd),
    reset_label: valueOrPrevious(credits.reset_label, previousCredits.reset_label),
  };
}

function mergeProviderFields(providerName, provider, previousProvider) {
  if (!previousProvider) return provider;

  // Las fuentes estructuradas describen el snapshot completo disponible. Si
  // una ventana ya no existe (por ejemplo Codex pasó de 5 h + semanal a solo
  // semanal), conservarla desde el snapshot web anterior produciría datos
  // fantasma. El merge parcial se reserva para el parser web tolerante.
  if (provider.source === 'codex-cli' || provider.source === 'claude-oauth' || provider.source === 'antigravity-local') {
    return provider;
  }

  if (providerName === 'codex') {
    return {
      ...provider,
      five_hour: mergeMetric(provider.five_hour, previousProvider.five_hour),
      weekly: mergeMetric(provider.weekly, previousProvider.weekly),
      credits_remaining: valueOrPrevious(provider.credits_remaining, previousProvider.credits_remaining),
      credits: provider.credits ?? previousProvider.credits ?? null,
    };
  }

  if (providerName === 'claude') {
    const credits = mergeCredits(provider.credits, previousProvider.credits);
    return {
      ...provider,
      session: mergeMetric(provider.session, previousProvider.session),
      weekly: mergeMetric(provider.weekly, previousProvider.weekly),
      routines: mergeMetric(provider.routines, previousProvider.routines),
      daily_routines: mergeRoutines(provider.daily_routines, previousProvider.daily_routines),
      credits,
      billing: claudeBillingFromCredits(credits),
    };
  }

  return provider;
}

function hasAnyProviderData(status) {
  return (status.accounts ?? [status.codex, status.claude]).some(providerHasUsableData);
}

function latestProviderUpdatedAt(status) {
  const timestamps = (status.accounts ?? [status.codex, status.claude])
    .map((provider) => {
      if (!providerHasUsableData(provider)) return null;
      const timestamp = Date.parse(provider.updated_at);
      return Number.isFinite(timestamp) ? timestamp : null;
    })
    .filter((timestamp) => timestamp !== null);

  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function providerWithinFallbackWindow(provider, validMinutes) {
  if (!providerHasUsableData(provider)) return false;
  const updatedAt = Date.parse(provider.updated_at);
  if (!Number.isFinite(updatedAt)) return false;
  const minutes = Number(validMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return false;
  return Date.now() - updatedAt <= minutes * 60 * 1000;
}

// A reused snapshot may outlive its windows (e.g. kept overnight while the
// Claude token was expired). A window whose reset already passed has, at
// most, the usage made since; show it as not started instead of the old %.
function expireElapsedWindows(provider, nowSeconds = Math.floor(Date.now() / 1000)) {
  const next = { ...provider };
  for (const key of WINDOW_KEYS) {
    const metric = provider[key];
    if (hasObtainedValue(metric?.reset_epoch) && metric.reset_epoch <= nowSeconds) {
      next[key] = {
        ...metric,
        used_percent: provider.source === 'antigravity-local' ? null : 0,
        remaining_percent: provider.source === 'antigravity-local' ? null : 100,
        reset_label: null,
        reset_epoch: null,
        state: provider.source === 'antigravity-local' ? 'unavailable' : 'idle',
      };
    }
  }
  if (provider.quota_windows) {
    next.quota_windows = provider.quota_windows.map((window) => ({
      ...window, metric: expireElapsedWindows({ ...provider, quota_windows: null, quota: window.metric }, nowSeconds).quota,
    }));
  }
  return next;
}

function mergeProviderResult(providerName, provider, previousStatus, failures, validMinutes) {
  const candidate = previousStatus?.[providerName];

  // Known, non-error state: keep the last data regardless of its age and let
  // the widget present it as "datos de las HH:MM".
  if (!provider.ok && provider.keep_last && providerHasUsableData(candidate)) {
    return {
      ...expireElapsedWindows(candidate),
      stale: true,
      stale_reason: provider.error_code,
    };
  }

  const previousProvider = providerWithinFallbackWindow(candidate, validMinutes)
    ? candidate
    : null;

  if (provider.ok) {
    return mergeProviderFields(providerName, provider, previousProvider);
  }

  failures.push(publicError(providerName, {
    code: provider.error_code,
    message: provider.error_message,
  }));

  if (previousProvider) {
    return { ...expireElapsedWindows(previousProvider), stale: true, stale_reason: provider.error_code };
  }

  // `keep_last` only steers this merge; it is not part of status.json.
  const { keep_last: _keepLast, ...failure } = provider;
  return failure;
}

function lastGoodSnapshot(config, status) {
  const snapshot = JSON.parse(JSON.stringify(status));
  snapshot.accounts = snapshot.accounts.filter((account) => providerHasUsableData(account));
  updateLegacyProviders(snapshot);
  snapshot.ok = true;
  snapshot.stale = false;
  snapshot.errors = [];
  snapshot.updated_at = latestProviderUpdatedAt(snapshot) ?? snapshot.updated_at;
  snapshot.primary = buildPrimary(config, snapshot);
  return snapshot;
}

function previousAccount(status, account) {
  // Never mix snapshots between accounts of the same provider.
  if (Array.isArray(status?.accounts)) {
    return status.accounts.find((item) => item.id === account.id);
  }
  return account.id === `${account.provider}-default` ? status?.[account.provider] : null;
}

function failureStatusFromPrevious(previousStatus, error, config = normalizeConfig(DEFAULT_CONFIG)) {
  const now = new Date().toISOString();
  const accounts = config.accounts.map((account) => {
    if (account.logged_out || !account.enabled) return disconnectedAccount(account);
    const previous = previousAccount(previousStatus, account);
    if (providerWithinFallbackWindow(previous, config.thresholds.last_good_valid_minutes)) {
      return { ...expireElapsedWindows(previous), ...publicAccount(account), stale: true };
    }
    return { ...publicAccount(account), ...providerFailure(null, error) };
  });
  const result = updateLegacyProviders({
    schema_version: SCHEMA_VERSION, updated_at: now, ok: false, stale: true,
    thresholds: config.thresholds, accounts,
    errors: [publicError('collector', error)],
  });
  result.primary = buildPrimary(config, result);
  return result;
}

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function statusIsFresh(maxAgeSeconds) {
  const stats = await fs.stat(OUT_FILE).catch(() => null);
  return Boolean(stats) && Date.now() - stats.mtimeMs < maxAgeSeconds * 1000;
}

function recordProviderOutcome(name, provider) {
  if (provider.ok) providerState = recordSuccess(providerState, name);
}

async function main() {
  await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
  await ensureDefaultConfig();
  if (!FORCE && IF_OLDER_THAN_SECONDS !== null && await statusIsFresh(IF_OLDER_THAN_SECONDS)) {
    console.log('ai-usage-collect: status.json es reciente; no hay nada que hacer.');
    return;
  }
  const releaseLock = await acquireCollectorLock();
  if (!releaseLock) return;

  try {
    const config = await loadConfig();
    const previousStatus =
      (await readJson(LAST_GOOD_FILE, null)) ?? (await readJson(OUT_FILE, null));
    providerState = (await readJson(PROVIDER_STATE_FILE, null)) ?? {};
    const failures = [];

    const result = {
      schema_version: SCHEMA_VERSION,
      updated_at: new Date().toISOString(),
      ok: true,
      stale: false,
      primary: null,
      thresholds: config.thresholds,
      errors: [],
      accounts: [],
    };

    for (const account of config.accounts) {
      if (!account.enabled || account.logged_out) {
        result.accounts.push(disconnectedAccount(account));
        continue;
      }
      const isCodex = account.provider === 'codex';
      const isGoogle = account.provider === 'antigravity';
      const collected = await collectProvider(
        account.id,
        account.config,
        isGoogle ? 'local' : isCodex ? 'cli' : 'oauth',
        isGoogle ? fetchAntigravityLocal : isCodex ? fetchCodexCli : fetchClaudeOAuth,
        isCodex ? parseCodex : parseClaude,
        isCodex ? CODEX_READY : CLAUDE_READY,
      );
      recordProviderOutcome(account.id, collected);
      const accountFailures = [];
      const merged = mergeProviderResult(
        account.provider, collected,
        { [account.provider]: previousAccount(previousStatus, account) },
        accountFailures, config.thresholds.last_good_valid_minutes,
      );
      failures.push(...accountFailures.map((error) => ({
        ...error, account_id: account.id, account_label: account.label,
      })));
      // Browser sessions can belong to a different identity than the CLI.
      // Only enrich snapshots actually collected from the matching CLI session.
      const email = merged.account_email ?? (['codex-cli', 'claude-oauth'].includes(merged.source)
        ? await readAccountEmail(account) : null);
      result.accounts.push({ ...merged, ...(email ? { account_email: email } : {}), ...publicAccount(account) });
    }

    updateLegacyProviders(result);
    result.ok = failures.length === 0;
    result.stale = failures.length > 0;
    result.errors = failures;
    result.updated_at = latestProviderUpdatedAt(result) ?? previousStatus?.updated_at ?? result.updated_at;
    result.primary = buildPrimary(config, result);

    await writeAtomic(OUT_FILE, result);
    await writeAtomic(PROVIDER_STATE_FILE, providerState);

    if (hasAnyProviderData(result)) {
      await writeAtomic(LAST_GOOD_FILE, lastGoodSnapshot(config, result));
    }

    if (process.env.AI_USAGE_QUIET === '1') {
      const sources = result.accounts
        .map((account) => `${account.id}=${account.source ?? 'disconnected'}`)
        .join(' ');
      console.log(`ai-usage-collect: ok=${result.ok} ${sources} updated_at=${result.updated_at}`);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    await releaseLock();
  }
}

main().catch(async (error) => {
  await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
  await appendErrorLog('collector', error, { phase: 'fatal' });
  const release = await acquireLock(LOCK_FILE).catch(() => null);
  if (release) {
    try {
      const config = await loadConfig();
      const previousStatus =
        (await readJson(LAST_GOOD_FILE, null)) ?? (await readJson(OUT_FILE, null));
      await writeAtomic(OUT_FILE, failureStatusFromPrevious(previousStatus, error, config));
    } catch {
      // Invalid config must never fall back to reading unrelated global sessions.
    } finally {
      await release();
    }
  }
  console.error('ai-usage-collect: no se pudo completar la actualización. Revisa errors.log.');
  process.exitCode = 1;
});
