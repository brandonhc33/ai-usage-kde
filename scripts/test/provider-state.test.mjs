import assert from 'node:assert/strict';
import test from 'node:test';
import {
  backoffDelayMs,
  recordFailure,
  recordSuccess,
  webBackoffUntil,
} from '../lib/provider-state.mjs';

const T0 = Date.parse('2026-10-09T12:00:00Z');
const MINUTE = 60 * 1000;

test('logs only the first failure of an incident', () => {
  let { state, shouldLog } = recordFailure({}, 'claude', 'page_changed', 'scrape', T0);
  assert.equal(shouldLog, true);

  ({ state, shouldLog } = recordFailure(state, 'claude', 'page_changed', 'scrape', T0 + 2 * MINUTE));
  assert.equal(shouldLog, false);
  assert.equal(state.claude.count, 2);
  assert.equal(state.claude.first_at, '2026-10-09T12:00:00.000Z');

  ({ state, shouldLog } = recordFailure(state, 'claude', 'login_required', 'scrape', T0 + 4 * MINUTE));
  assert.equal(shouldLog, true);
  assert.equal(state.claude.count, 1);
});

test('a success closes the incident so the next failure is logged again', () => {
  const { state } = recordFailure({}, 'claude', 'oauth_expired', 'oauth', T0);
  const cleared = recordSuccess(state, 'claude');
  assert.equal(cleared.claude, undefined);
  assert.equal(recordFailure(cleared, 'claude', 'oauth_expired', 'oauth', T0).shouldLog, true);
});

test('backs off the web fallback after three consecutive failures', () => {
  assert.equal(backoffDelayMs(2), 0);
  assert.equal(backoffDelayMs(3), 4 * MINUTE);
  assert.equal(backoffDelayMs(4), 8 * MINUTE);
  assert.equal(backoffDelayMs(5), 16 * MINUTE);
  assert.equal(backoffDelayMs(9), 30 * MINUTE);

  let state = {};
  for (let i = 0; i < 3; i += 1) {
    ({ state } = recordFailure(state, 'claude', 'page_changed', 'scrape', T0 + i * MINUTE));
  }
  assert.equal(webBackoffUntil(state.claude), T0 + 2 * MINUTE + 4 * MINUTE);
});

test('structured-source failures never pause the web fallback', () => {
  let state = {};
  for (let i = 0; i < 5; i += 1) {
    ({ state } = recordFailure(state, 'claude', 'oauth_expired', 'oauth', T0));
  }
  assert.equal(webBackoffUntil(state.claude), 0);
});
