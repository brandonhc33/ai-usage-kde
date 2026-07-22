#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clearStaleSingletonLock,
  resolveBrowserLaunchOptions,
} from './lib/chrome-profile.mjs';
import { fetchClaudeOAuth, fetchCodexCli } from './lib/structured-sources.mjs';
import { withDisplay } from './lib/xvfb.mjs';
import {
  CLAUDE_READY,
  CODEX_READY,
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
const LOCK_STALE_MS = 10 * 60 * 1000;
const GENERIC_FETCH_ERROR = 'No se obtuvo la información.';

const DEFAULT_CONFIG = {
  schema_version: 1,
  primary: { provider: 'codex', metric: 'five_hour' },
  thresholds: {
    warning_used_percent: 51,
    critical_used_percent: 76,
    stale_after_minutes: 15,
    last_good_valid_minutes: 30,
  },
  providers: {
    codex: {
      enabled: true,
      source: 'auto',
      cli_path: null,
      cli_timeout_ms: 15000,
      url: 'https://chatgpt.com/codex/settings/usage',
      profile_dir: '~/.config/ai-usage-status/profiles/chatgpt',
      headless: true,
      wait_ms: 8000,
      debug_text: false,
    },
    claude: {
      enabled: true,
      source: 'auto',
      oauth_credentials_file: '~/.claude/.credentials.json',
      oauth_timeout_ms: 30000,
      url: 'https://claude.ai/new#settings/usage',
      profile_dir: '~/.config/ai-usage-status/profiles/claude',
      headless: true,
      wait_ms: 8000,
      debug_text: false,
    },
  },
};

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

function normalizeConfig(value) {
  const config = value && typeof value === 'object' ? value : {};
  return {
    ...DEFAULT_CONFIG,
    ...config,
    primary: { ...DEFAULT_CONFIG.primary, ...config.primary },
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...config.thresholds },
    providers: {
      codex: { ...DEFAULT_CONFIG.providers.codex, ...config.providers?.codex },
      claude: { ...DEFAULT_CONFIG.providers.claude, ...config.providers?.claude },
    },
  };
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

function processExists(pid) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function lockIsActive(lock) {
  const startedAt = Date.parse(lock?.started_at);
  if (!Number.isFinite(startedAt)) return false;
  if (Date.now() - startedAt > LOCK_STALE_MS) return false;
  return processExists(lock.pid);
}

async function acquireCollectorLock() {
  const lock = {
    pid: process.pid,
    started_at: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(LOCK_FILE, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(lock, null, 2));
      return async () => {
        try {
          await handle.close();
        } finally {
          await fs.rm(LOCK_FILE, { force: true });
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      const existing = await readJson(LOCK_FILE, null);
      if (lockIsActive(existing)) {
        console.log('ai-usage-collect: ya hay una actualización en curso.');
        return null;
      }

      await fs.rm(LOCK_FILE, { force: true });
    }
  }

  throw new Error('No pude crear collector.lock.');
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

async function scrapeProvider(name, providerConfig, parser, readyPattern) {
  const profileDir = expandHome(providerConfig.profile_dir);
  try {
    // Playwright es una dependencia pesada y solo se carga si una fuente
    // estructurada no está disponible.
    const { chromium } = await import('playwright');
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await clearStaleSingletonLock(profileDir);
    const browserLaunchOptions = await resolveBrowserLaunchOptions();

    const text = await withDisplay(async (display) => {
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
        return await waitForUsageText(page, readyPattern, providerConfig.wait_ms ?? 8000);
      } finally {
        await context.close();
      }
    });

    if (/iniciar sesión|log in|sign in|sign up/i.test(text)) {
      throw Object.assign(new Error(`${name} requiere iniciar sesión.`), { code: 'login_required' });
    }

    if (providerConfig.debug_text) {
      await fs.writeFile(path.join(CACHE_DIR, `debug-${name}-text.txt`), text);
    }

    return parser(text);
  } catch (error) {
    await appendErrorLog(name, error, { phase: 'scrape' });
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
    await appendErrorLog(name, error, { phase: 'config' });
    return providerFailure(source, error);
  }

  if (source === 'auto' || source === structuredSource) {
    try {
      return await structuredFetcher(providerConfig);
    } catch (error) {
      if (source === structuredSource) {
        await appendErrorLog(name, error, { phase: structuredSource });
        return providerFailure(structuredSource, error);
      }
      console.warn(
        `${name}: ${structuredSource} no disponible (${classifyError(error)}); usando fallback web.`,
      );
    }
  }

  return scrapeProvider(name, providerConfig, parser, readyPattern);
}

function buildPrimary(config, status) {
  const providerName = config.primary?.provider ?? 'codex';
  const configuredMetricName = config.primary?.metric ?? 'five_hour';
  const provider = status[providerName];
  let metricName = configuredMetricName;
  let metric = provider?.[metricName];
  if (!metricHasUsableData(metric)) {
    const fallbackNames = providerName === 'codex'
      ? ['five_hour', 'weekly']
      : ['session', 'weekly'];
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
    metricHasUsableData(provider.five_hour) ||
    metricHasUsableData(provider.weekly) ||
    metricHasUsableData(provider.session) ||
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
  if (provider.source === 'codex-cli' || provider.source === 'claude-oauth') {
    return provider;
  }

  if (providerName === 'codex') {
    return {
      ...provider,
      five_hour: mergeMetric(provider.five_hour, previousProvider.five_hour),
      weekly: mergeMetric(provider.weekly, previousProvider.weekly),
      credits_remaining: valueOrPrevious(provider.credits_remaining, previousProvider.credits_remaining),
    };
  }

  if (providerName === 'claude') {
    return {
      ...provider,
      session: mergeMetric(provider.session, previousProvider.session),
      weekly: mergeMetric(provider.weekly, previousProvider.weekly),
      routines: mergeMetric(provider.routines, previousProvider.routines),
      daily_routines: mergeRoutines(provider.daily_routines, previousProvider.daily_routines),
      credits: mergeCredits(provider.credits, previousProvider.credits),
    };
  }

  return provider;
}

function hasAnyProviderData(status) {
  return providerHasUsableData(status.codex) || providerHasUsableData(status.claude);
}

function latestProviderUpdatedAt(status) {
  const timestamps = ['codex', 'claude']
    .map((providerName) => {
      const provider = status[providerName];
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

function mergeProviderResult(providerName, provider, previousStatus, failures, validMinutes) {
  const candidate = previousStatus?.[providerName];
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
    return previousProvider;
  }

  return provider;
}

function lastGoodSnapshot(config, status) {
  const snapshot = JSON.parse(JSON.stringify(status));

  for (const providerName of ['codex', 'claude']) {
    if (!providerHasUsableData(snapshot[providerName])) {
      delete snapshot[providerName];
    }
  }

  snapshot.ok = true;
  snapshot.stale = false;
  snapshot.errors = [];
  snapshot.updated_at = latestProviderUpdatedAt(snapshot) ?? snapshot.updated_at;
  snapshot.primary = buildPrimary(config, snapshot);
  return snapshot;
}

function failureStatusFromPrevious(previousStatus, error, config = DEFAULT_CONFIG) {
  const now = new Date().toISOString();
  const errors = [publicError('collector', error)];
  const fallback = previousStatus
    ? JSON.parse(JSON.stringify(previousStatus))
    : null;

  for (const providerName of ['codex', 'claude']) {
    if (!providerWithinFallbackWindow(
      fallback?.[providerName],
      config.thresholds.last_good_valid_minutes,
    )) {
      delete fallback?.[providerName];
    }
  }

  if (hasAnyProviderData(fallback ?? {})) {
    fallback.ok = false;
    fallback.stale = true;
    fallback.thresholds = config.thresholds;
    fallback.errors = errors;
    fallback.updated_at = latestProviderUpdatedAt(fallback) ?? fallback.updated_at ?? now;
    fallback.primary = buildPrimary(config, fallback);
    return fallback;
  }

  return {
    schema_version: 1,
    updated_at: now,
    ok: false,
    stale: true,
    thresholds: config.thresholds,
    primary: { provider: 'none', metric: 'none', used_percent: null, remaining_percent: null, label: '!' },
    errors,
  };
}

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function main() {
  await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
  await ensureDefaultConfig();
  const releaseLock = await acquireCollectorLock();
  if (!releaseLock) return;

  try {
    const config = normalizeConfig(await readJson(CONFIG_FILE, null));
    const previousStatus =
      (await readJson(LAST_GOOD_FILE, null)) ?? (await readJson(OUT_FILE, null));
    const failures = [];

    const result = {
      schema_version: 1,
      updated_at: new Date().toISOString(),
      ok: true,
      stale: false,
      primary: null,
      thresholds: config.thresholds,
      errors: [],
    };

    if (config.providers?.codex?.enabled) {
      const codex = await collectProvider(
        'codex',
        config.providers.codex,
        'cli',
        fetchCodexCli,
        parseCodex,
        CODEX_READY,
      );
      result.codex = mergeProviderResult(
        'codex',
        codex,
        previousStatus,
        failures,
        config.thresholds.last_good_valid_minutes,
      );
    }

    if (config.providers?.claude?.enabled) {
      const claude = await collectProvider(
        'claude',
        config.providers.claude,
        'oauth',
        fetchClaudeOAuth,
        parseClaude,
        CLAUDE_READY,
      );
      result.claude = mergeProviderResult(
        'claude',
        claude,
        previousStatus,
        failures,
        config.thresholds.last_good_valid_minutes,
      );
    }

    result.ok = failures.length === 0;
    result.stale = failures.length > 0;
    result.errors = failures;
    result.updated_at = latestProviderUpdatedAt(result) ?? previousStatus?.updated_at ?? result.updated_at;
    result.primary = buildPrimary(config, result);

    await writeAtomic(OUT_FILE, result);

    if (hasAnyProviderData(result)) {
      await writeAtomic(LAST_GOOD_FILE, lastGoodSnapshot(config, result));
    }

    if (process.env.AI_USAGE_QUIET === '1') {
      const sources = ['codex', 'claude']
        .filter((name) => result[name])
        .map((name) => `${name}=${result[name].source}`)
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
  const config = normalizeConfig(await readJson(CONFIG_FILE, null));
  const previousStatus =
    (await readJson(LAST_GOOD_FILE, null)) ?? (await readJson(OUT_FILE, null));
  const fallback = failureStatusFromPrevious(previousStatus, error, config);
  await writeAtomic(OUT_FILE, fallback);
  console.error(error);
  process.exit(1);
});
