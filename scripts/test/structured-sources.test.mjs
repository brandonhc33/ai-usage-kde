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

// Shapes captured from the real endpoints on 2026-10-09 (IDs removed).
test('maps Claude spend without presenting the monthly limit as money', () => {
  const result = mapClaudeOAuthUsage({
    five_hour: { utilization: 6, resets_at: '2026-10-09T21:19:59.635196+00:00' },
    seven_day: { utilization: 10, resets_at: '2026-10-15T03:59:59.635222+00:00' },
    extra_usage: {
      is_enabled: true,
      monthly_limit: 10000,
      used_credits: 29,
      utilization: 0.29,
      currency: 'USD',
      decimal_places: 2,
      spend_limit_reached: false,
    },
    spend: {
      used: { amount_minor: 29, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 10000, currency: 'USD', exponent: 2 },
      percent: 0,
      enabled: true,
      balance: null,
    },
    seven_day_breakdown: {
      rows: [
        { key: 'claude_code', display_name: 'Claude Code', percent: 100 },
        { key: 'chat', display_name: 'Chats', percent: 0 },
      ],
    },
  }, { subscriptionType: 'pro', expiresAt: 1791590808249 }, NOW);

  // /usage has no balance: USD 100 is only the monthly spending limit.
  assert.deepEqual(result.billing, {
    currency: 'USD',
    balance: null,
    available: null,
    spent: 0.29,
    limit: 100,
    limit_remaining: 99.71,
    percent: 0.29,
    period: 'monthly',
    limit_reached: false,
    auto_reload: null,
  });
  assert.equal(result.credits.spent_usd, 0.29);
  assert.equal(result.credits.spent_percent, 0.29);
  assert.equal(result.weekly_breakdown[0].name, 'Claude Code');
  assert.equal(result.token_expires_at, '2026-10-10T00:06:48.249Z');
});

test('marks a Claude session that has not started as idle', () => {
  const result = mapClaudeOAuthUsage({
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 10, resets_at: '2026-10-15T03:59:59Z' },
  }, {}, NOW);

  assert.equal(result.session.state, 'idle');
  assert.equal(result.session.remaining_percent, 100);
  assert.equal(result.weekly.state, 'active');
  assert.equal(result.billing, null);
});

test('flags Claude credits as exhausted when the spend limit is reached', () => {
  const result = mapClaudeOAuthUsage({
    five_hour: { utilization: 100, resets_at: '2026-10-09T21:19:59Z' },
    extra_usage: {
      is_enabled: true, monthly_limit: 2000, used_credits: 2000, utilization: 100,
      spend_limit_reached: true,
    },
  }, {}, NOW);

  assert.equal(result.billing.limit_remaining, 0);
  assert.equal(result.billing.limit_reached, true);
});

test('takes the Claude balance from the prepaid credits endpoint', () => {
  const usage = {
    five_hour: { utilization: 75, resets_at: '2026-10-09T21:19:59Z' },
    extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 29, utilization: 0.29 },
    spend: {
      used: { amount_minor: 29, currency: 'USD', exponent: 2 },
      limit: { amount_minor: 10000, currency: 'USD', exponent: 2 },
      enabled: true,
      balance: null,
    },
  };
  // Shape returned by GET /api/oauth/organizations/:org/prepaid/credits.
  const prepaid = {
    amount: 471,
    currency: 'USD',
    balance: { money: null, credits: { amount_minor: 471, exponent: 2 } },
    auto_reload_settings: null,
  };

  const { billing } = mapClaudeOAuthUsage(usage, {}, NOW, prepaid);
  assert.equal(billing.balance, 4.71);
  assert.equal(billing.available, 4.71);
  assert.equal(billing.limit_remaining, 99.71);
  assert.equal(billing.auto_reload, false);

  // A balance above what is left of the monthly limit can only be spent up to it.
  const capped = mapClaudeOAuthUsage(
    { ...usage, spend: { ...usage.spend, used: { amount_minor: 9900, exponent: 2 } } },
    {}, NOW, { ...prepaid, amount: 50000 },
  ).billing;
  assert.equal(capped.balance, 500);
  assert.equal(capped.available, 1);
});

test('keeps Codex credits at zero and exposes free rate-limit resets', () => {
  const result = mapCodexRateLimits({
    rateLimits: {
      primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1791577452 },
      secondary: { usedPercent: 51, windowDurationMins: 10080, resetsAt: 1791982242 },
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      spendControlReached: false,
      planType: 'plus',
      rateLimitReachedType: null,
    },
    rateLimitResetCredits: {
      availableCount: 3,
      credits: [
        { status: 'available', expiresAt: 1793291219, title: 'Full reset (Weekly + 5 hr)' },
        { status: 'available', expiresAt: 1792692811, title: 'Full reset (Weekly + 5 hr)' },
        { status: 'used', expiresAt: 1790000000, title: 'Full reset (Weekly + 5 hr)' },
      ],
    },
  }, NOW);

  assert.equal(result.credits_remaining, null);
  assert.deepEqual(result.credits, { balance: 0, has_credits: false, unlimited: false });
  assert.deepEqual(result.reset_credits, {
    available: 3,
    title: 'Full reset (Weekly + 5 hr)',
    next_expiry_epoch: 1792692811,
  });
  assert.equal(result.limit_reached, false);
  assert.equal(result.five_hour.state, 'active');
});
