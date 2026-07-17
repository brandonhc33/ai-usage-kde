import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mapClaudeOAuthUsage,
  mapCodexRateLimits,
} from '../lib/structured-sources.mjs';

const NOW = new Date('2026-07-15T06:00:00Z');

test('maps a weekly-only Codex account without inventing a 5-hour window', () => {
  const result = mapCodexRateLimits({
    rateLimits: {
      primary: {
        usedPercent: 18,
        windowDurationMins: 10080,
        resetsAt: 1784699314,
      },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      planType: 'plus',
    },
    rateLimitResetCredits: { availableCount: 4 },
  }, NOW);

  assert.equal(result.source, 'codex-cli');
  assert.equal(result.five_hour, null);
  assert.equal(result.weekly.used_percent, 18);
  assert.equal(result.weekly.remaining_percent, 82);
  assert.equal(result.credits_remaining, null);
  assert.equal(result.reset_credits_available, 4);
});

test('maps two Codex rate-limit windows by duration', () => {
  const result = mapCodexRateLimits({
    rateLimits: {
      primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: 1784103600 },
      secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 1784699314 },
      credits: { hasCredits: true, unlimited: false, balance: '12.5' },
    },
  }, NOW);

  assert.equal(result.five_hour.used_percent, 60);
  assert.equal(result.weekly.used_percent, 20);
  assert.equal(result.credits_remaining, 12.5);
});

test('maps Claude OAuth limits and converts credit cents to dollars', () => {
  const result = mapClaudeOAuthUsage({
    five_hour: {
      utilization: 92,
      resets_at: '2026-07-15T08:19:59.770877+00:00',
    },
    seven_day: {
      utilization: 13,
      resets_at: '2026-07-16T03:59:59.770898+00:00',
    },
    extra_usage: {
      is_enabled: true,
      monthly_limit: 2000,
      used_credits: 440,
      utilization: 22,
    },
  }, { subscriptionType: 'pro' }, NOW);

  assert.equal(result.source, 'claude-oauth');
  assert.equal(result.session.used_percent, 92);
  assert.equal(result.session.remaining_percent, 8);
  assert.equal(result.weekly.used_percent, 13);
  assert.equal(result.credits.spent_usd, 4.4);
  assert.equal(result.credits.limit_usd, 20);
  assert.equal(result.plan_type, 'pro');
});
