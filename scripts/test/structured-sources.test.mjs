import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  fetchClaudeOAuth,
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

// A managed Claude session on disk plus a fake Anthropic API that records
// every request: renewals go to the token URL, usage reads to the usage URL.
async function claudeSession(t, oauth, usageStatus = () => 200) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-oauth-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.credentials.json');
  await fs.writeFile(file, JSON.stringify({ claudeAiOauth: {
    accessToken: 'old-access', refreshToken: 'old-refresh', scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'pro', ...oauth,
  }, other: 'kept' }));
  const requests = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, body, authorization: options.headers?.Authorization });
    if (url.endsWith('/v1/oauth/token')) {
      if (body.refresh_token === 'dead-refresh') {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      return new Response(JSON.stringify({
        access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 28800,
        scope: 'user:inference user:profile',
      }), { status: 200 });
    }
    const status = usageStatus(options.headers.Authorization);
    return new Response(status === 200
      ? JSON.stringify({ five_hour: { utilization: 40, resets_at: '2026-10-23T20:00:00Z' } })
      : '{}', { status });
  };
  const read = async () => JSON.parse(await fs.readFile(file, 'utf8'));
  return { file, requests, read };
}

test('renews an expired managed Claude session and saves the rotated tokens', async (t) => {
  const session = await claudeSession(t, { expiresAt: Date.now() - 1000 });
  const result = await fetchClaudeOAuth({ oauth_credentials_file: session.file, oauth_refresh: true });
  assert.equal(result.session.used_percent, 40);
  assert.deepEqual(session.requests.map((request) => new URL(request.url).pathname),
    ['/v1/oauth/token', '/api/oauth/usage']);
  assert.deepEqual(session.requests[0].body, {
    grant_type: 'refresh_token', refresh_token: 'old-refresh',
    client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', scope: 'user:inference user:profile',
  });
  assert.equal(session.requests[1].authorization, 'Bearer new-access');
  const saved = await session.read();
  assert.equal(saved.other, 'kept');
  assert.equal(saved.claudeAiOauth.accessToken, 'new-access');
  assert.equal(saved.claudeAiOauth.refreshToken, 'new-refresh');
  assert.equal(saved.claudeAiOauth.subscriptionType, 'pro');
  assert.ok(saved.claudeAiOauth.expiresAt > Date.now() + 7 * 3600 * 1000);
  assert.equal((await fs.stat(session.file)).mode & 0o777, 0o600);
});

test('never renews a Claude session the widget does not own', async (t) => {
  const session = await claudeSession(t, { expiresAt: Date.now() - 1000 });
  await assert.rejects(fetchClaudeOAuth({ oauth_credentials_file: session.file }), { code: 'oauth_expired' });
  assert.equal(session.requests.length, 0);
  assert.equal((await session.read()).claudeAiOauth.refreshToken, 'old-refresh');
});

test('a rejected refresh token asks for a new login once instead of retrying it', async (t) => {
  const session = await claudeSession(t, { expiresAt: Date.now() - 1000, refreshToken: 'dead-refresh' });
  const config = { oauth_credentials_file: session.file, oauth_refresh: true };
  await assert.rejects(fetchClaudeOAuth(config), { code: 'login_required' });
  assert.equal((await session.read()).claudeAiOauth.refreshToken, '');
  await assert.rejects(fetchClaudeOAuth(config), { code: 'login_required' });
  assert.equal(session.requests.length, 1);
});

test('renews once when Claude revokes a managed access token before it expires', async (t) => {
  const session = await claudeSession(t, { expiresAt: Date.now() + 3600 * 1000 },
    (authorization) => (authorization === 'Bearer old-access' ? 401 : 200));
  const result = await fetchClaudeOAuth({ oauth_credentials_file: session.file, oauth_refresh: true });
  assert.equal(result.session.used_percent, 40);
  assert.deepEqual(session.requests.map((request) => new URL(request.url).pathname),
    ['/api/oauth/usage', '/v1/oauth/token', '/api/oauth/usage']);
});
