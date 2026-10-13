/**
 * Per-provider incident bookkeeping stored in provider-state.json.
 *
 * - errors.log receives one entry per incident (a new error code for that
 *   provider) instead of one entry every two minutes.
 * - Repeated web-fallback failures back off before Chrome is launched again.
 *
 * These functions are pure; the collector owns reading and writing the file.
 */

export const BACKOFF_AFTER_FAILURES = 3;
export const BACKOFF_BASE_MS = 4 * 60 * 1000;
export const BACKOFF_MAX_MS = 30 * 60 * 1000;

// 1-2 failures → no pause; 3 → 4 min, 4 → 8 min, 5 → 16 min, then 30 min.
export function backoffDelayMs(consecutiveFailures) {
  if (consecutiveFailures < BACKOFF_AFTER_FAILURES) return 0;
  const steps = consecutiveFailures - BACKOFF_AFTER_FAILURES;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** steps);
}

export function recordFailure(state, provider, code, phase, nowMs = Date.now()) {
  const previous = state?.[provider];
  const sameIncident = previous?.code === code && previous?.phase === phase;
  const now = new Date(nowMs).toISOString();
  const entry = {
    code,
    phase,
    first_at: sameIncident ? previous.first_at : now,
    last_at: now,
    count: sameIncident ? previous.count + 1 : 1,
  };
  return {
    state: { ...state, [provider]: entry },
    shouldLog: !sameIncident,
    entry,
  };
}

export function recordSuccess(state, provider) {
  if (!state?.[provider]) return state ?? {};
  const next = { ...state };
  delete next[provider];
  return next;
}

// Epoch ms until which the web fallback should not run again, or 0.
export function webBackoffUntil(entry) {
  if (entry?.phase !== 'scrape') return 0;
  const delay = backoffDelayMs(entry.count);
  const lastAt = Date.parse(entry.last_at);
  if (!delay || !Number.isFinite(lastAt)) return 0;
  return lastAt + delay;
}
