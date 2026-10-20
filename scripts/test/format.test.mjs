import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// format.js is a QML JavaScript library; outside QML it is plain ES5 once the
// `.pragma library` line is removed.
const source = fs
  .readFileSync(new URL('../../package/contents/code/format.js', import.meta.url), 'utf8')
  .replace(/^\.pragma library\s*$/m, '');
const Format = vm.createContext({});
vm.runInContext(source, Format);

process.env.TZ = 'America/Santiago';
const NOW = Date.parse('2026-10-09T16:28:00Z'); // vie 09/10 13:28 local
const NOW_S = NOW / 1000;

function status(overrides = {}) {
  return {
    kind: 'loaded',
    data: {
      updated_at: new Date(NOW).toISOString(),
      thresholds: { warning_used_percent: 51, critical_used_percent: 76, stale_after_minutes: 15 },
      codex: {
        ok: true,
        source: 'codex-cli',
        plan_type: 'plus',
        updated_at: new Date(NOW).toISOString(),
        five_hour: { used_percent: 3, remaining_percent: 97, reset_epoch: NOW_S + 236 * 60, state: 'active' },
        weekly: { used_percent: 51, remaining_percent: 49, reset_epoch: 1791982242, state: 'active' },
        credits: { balance: 0, has_credits: false, unlimited: false },
        reset_credits: { available: 3, next_expiry_epoch: 1792692811 },
      },
      claude: {
        ok: true,
        source: 'claude-oauth',
        updated_at: new Date(NOW).toISOString(),
        session: { used_percent: 0, remaining_percent: 100, reset_epoch: null, state: 'idle' },
        weekly: { used_percent: 10, remaining_percent: 90, reset_epoch: 1792036800, state: 'active' },
        billing: {
          currency: 'USD', balance: 4.71, available: 4.71, spent: 0.29, limit: 100,
          limit_remaining: 99.71, percent: 0.29, limit_reached: false,
        },
      },
      ...overrides,
    },
  };
}

const labels = (options, state = status()) =>
  Array.from(Format.panelEntries(state, options, NOW), (entry) => entry.label);

test('account emails appear in the full tooltip and signed-out identities stay hidden', () => {
  const state = status();
  state.data.codex.account_email = 'personal@example.test';
  state.data.claude.account_email = 'work@example.test';
  assert.match(Format.tooltipText(state, NOW), /personal@example\.test/);
  assert.match(Format.tooltipText(state, NOW), /work@example\.test/);
  state.data.claude.logged_out = true;
  assert.doesNotMatch(Format.tooltipText(state, NOW), /work@example\.test/);
  assert.equal(Format.accountEmail({}), '');
});

test('default panel keeps the previous "% usado" look', () => {
  assert.deepEqual(labels({}), ['3%', '0%']);
});

test('presets show remaining percent and time until reset', () => {
  assert.deepEqual(labels({ preset: 'remaining' }), ['97%', '100%']);
  assert.deepEqual(labels({ preset: 'time' }), ['3h56', '—']);
  assert.deepEqual(labels({ preset: 'used_time' }), ['3% · 3h56', '0% · —']);
});

test('reset presets offer a countdown, local clock time or both for each provider', () => {
  const state = status();
  state.data.claude.session = {
    used_percent: 6, remaining_percent: 94, reset_epoch: NOW_S + 290 * 60, state: 'active',
  };
  const formats = [
    ['duration', ['3h56', '4h50']],
    ['clock', ['17:24', '18:18']],
    ['both', ['3h56 · 17:24', '4h50 · 18:18']],
  ];
  for (const [resetTimeFormat, resets] of formats) {
    assert.deepEqual(labels({ preset: 'time', resetTimeFormat }, state), resets);
    assert.deepEqual(
      labels({ preset: 'used_time', resetTimeFormat }, state),
      [`3% · ${resets[0]}`, `6% · ${resets[1]}`],
    );
    assert.deepEqual(
      labels({ preset: 'remaining_time', resetTimeFormat }, state),
      [`97% · ${resets[0]}`, `94% · ${resets[1]}`],
    );
  }
});

test('reset formats handle idle sessions and snapshots without a reset epoch', () => {
  assert.deepEqual(labels({ preset: 'time', resetTimeFormat: 'clock' }), ['17:24', '—']);
  assert.deepEqual(labels({ preset: 'time', resetTimeFormat: 'both' }), ['3h56 · 17:24', '—']);

  const state = status();
  state.data.codex.five_hour.reset_epoch = null;
  state.data.codex.five_hour.reset_label = 'en 2 h 33 min';
  assert.deepEqual(labels({ preset: 'time', resetTimeFormat: 'both' }, state), ['2h33', '—']);
  assert.deepEqual(labels({ preset: 'time', resetTimeFormat: 'clock' }, state), ['--', '—']);
  state.data.codex.five_hour.reset_label = null;
  assert.deepEqual(labels({ preset: 'time', resetTimeFormat: 'both' }, state), ['--', '—']);
});

test('reset time formatting preserves percentage presets and custom templates', () => {
  assert.deepEqual(labels({ resetTimeFormat: 'both' }), ['3%', '0%']);
  assert.deepEqual(
    labels({ preset: 'custom', template: '{reset_in}', resetTimeFormat: 'clock' }),
    ['3h56', '—'],
  );
});

test('weekly percent and reset day can be added on one or two lines', () => {
  assert.deepEqual(
    labels({ showWeekly: true, showWeeklyReset: true }),
    ['3% · S 51% mié 09:50', '0% · S 10% jue 01:00'],
  );
  assert.deepEqual(labels({ preset: 'remaining', showWeekly: true }), ['97% · S 49%', '100% · S 90%']);

  const [codex] = Format.panelEntries(status(), { showWeekly: true, twoLines: true }, NOW);
  assert.equal(codex.lines.length, 2);
  assert.equal(codex.label, '3% / S 51%');
});

test('each segment keeps the severity of its own window', () => {
  const [codex] = Format.panelEntries(status(), { showWeekly: true }, NOW);
  assert.deepEqual(
    Array.from(codex.lines[0], (segment) => [segment.text, segment.severity]),
    [['3%', 'normal'], [' · S ', 'muted'], ['51%', 'warning']],
  );
});

test('an idle session is dimmed or replaced by the weekly window', () => {
  const [, claude] = Format.panelEntries(status(), {}, NOW);
  assert.equal(claude.lines[0][0].severity, 'muted');
  assert.deepEqual(labels({ idleWindow: 'weekly', showWeekly: true }), ['3% · S 51%', 'S 10%']);
});

test('money and custom templates', () => {
  assert.deepEqual(labels({ showMoney: true }), ['3%', '0% · $4.71']);
  assert.deepEqual(
    labels({ preset: 'custom', template: '{left} {reset_at}\\n{w_reset_in} {nope}' }),
    ['97% 17:24 / 4d20h {nope}', '100% — / 5d11h {nope}'],
  );
});

test('an expired Claude token shows old data in gray without an alert', () => {
  const state = status();
  Object.assign(state.data.claude, { stale: true, stale_reason: 'oauth_expired' });
  state.data.claude.session = { used_percent: 40, remaining_percent: 60, reset_epoch: NOW_S + 60 * 60 };
  const [, claude] = Format.panelEntries(state, {}, NOW);
  assert.equal(claude.label, '40%');
  assert.ok(claude.lines.flat().every((segment) => segment.severity === 'muted'));
});

test('stale snapshots keep the "!" marker', () => {
  const state = status();
  state.data.stale = true;
  assert.deepEqual(labels({}, state), ['3%!', '0%!']);
});

test('weekly-only Codex accounts are labeled as weekly', () => {
  const state = status();
  state.data.codex.five_hour = null;
  assert.deepEqual(labels({ showWeekly: true }, state), ['S 51%', '0% · S 10%']);
});

test('popup texts for credits, resets and idle windows', () => {
  const { claude, codex } = status().data;
  assert.equal(Format.billingAvailableLine(claude.billing), 'USD 4.71 disponibles');
  assert.equal(Format.billingSpentLine(claude.billing), 'Límite de gasto mensual: USD 0.29 de USD 100.00 (0.3%)');
  assert.equal(Format.resetCreditsLine(codex.reset_credits), '3 reinicios gratis de límites · el primero vence el 22/10');
  assert.equal(Format.resetLine(codex.five_hour, NOW), 'reinicia hoy 17:24 (3 h 56 min)');
  assert.equal(Format.resetLine(codex.weekly, NOW), 'reinicia mié 14 09:50 (4 d 20 h 22 min)');
  assert.equal(Format.resetLine(claude.session, NOW), 'Empieza con tu primer mensaje.');
  assert.equal(Format.usageSummary(claude.session), 'sin iniciar · 100% disponible');
  assert.equal(Format.providerSubtitle(codex, NOW), 'Plan plus · CLI · hace instantes');
});

test('the monthly spending limit is never shown as available money', () => {
  const noBalance = { currency: 'USD', balance: null, available: null, spent: 0.29, limit: 100, percent: 0.29 };
  assert.equal(Format.billingAvailableLine(noBalance), 'saldo no informado');
  assert.equal(Format.panelMoney({ billing: noBalance }, null), null);

  const capped = { currency: 'USD', balance: 50, available: 2, spent: 98, limit: 100, percent: 98 };
  assert.equal(Format.billingAvailableLine(capped), 'USD 2.00 disponibles (saldo USD 50.00)');
});

test('legacy (schema v1) credits use the balance, not the limit', () => {
  const legacy = Format.billingOf({ credits: { spent_usd: 4.4, spent_percent: 22, limit_usd: 20, balance_usd: null } });
  assert.equal(legacy.available, null);
  assert.equal(legacy.limit_remaining, 15.6);
  const withBalance = Format.billingOf({ credits: { spent_usd: 0.29, limit_usd: 100, balance_usd: 4.71 } });
  assert.equal(withBalance.available, 4.71);
  assert.equal(Format.billingOf({ credits: { balance: 0, has_credits: false } }), null);
});

test('tooltip lists every window without opening the popup', () => {
  const text = Format.tooltipText(status(), NOW);
  assert.match(text, /5 horas: 3% usado · reinicia hoy 17:24/);
  assert.match(text, /Semanal: 51% usado · reinicia mié 14 09:50/);
  assert.match(text, /Sesión: sin iniciar/);
  assert.match(text, /Créditos: USD 4.71 disponibles/);
  assert.match(text, /Límite de gasto mensual: USD 0.29 de USD 100.00/);
  assert.match(text, /3 reinicios gratis/);
});

test('vertical panels stack every part on its own line', () => {
  const [codex] = Format.panelEntries(status(), { preset: 'used_time', showWeekly: true, stacked: true }, NOW);
  assert.deepEqual(Array.from(codex.lines, (line) => Array.from(line, (s) => s.text).join('')), ['3%', '3h56', 'S 51%']);
  const [withClock] = Format.panelEntries(status(), {
    preset: 'used_time', resetTimeFormat: 'both', showWeekly: true, stacked: true,
  }, NOW);
  assert.deepEqual(
    Array.from(withClock.lines, (line) => Array.from(line, (s) => s.text).join('')),
    ['3%', '3h56', '17:24', 'S 51%'],
  );
});

function multiAccountStatus() {
  const state = status();
  state.data.accounts = [
    { ...state.data.codex, id: 'codex-personal', provider: 'codex', label: 'Personal' },
    { ...state.data.claude, id: 'claude-personal', provider: 'claude', label: 'Personal' },
    { ...state.data.claude, id: 'claude-work', provider: 'claude', label: 'Trabajo',
      session: { used_percent: 42, reset_epoch: NOW_S + 3600 } },
  ];
  return state;
}

test('panel selection filters individual accounts while the popup model and tooltip retain every account', () => {
  const state = multiAccountStatus();
  const options = { hiddenAccountIds: ['claude-personal'] };
  const entries = Format.panelEntries(state, options, NOW);
  assert.deepEqual(Array.from(entries, (entry) => entry.accountId), ['codex-personal', 'claude-work']);
  assert.equal(entries[1].accountLabel, 'Trabajo');
  assert.equal(entries[1].showAccountName, true);
  assert.equal(Format.accountsOf(state.data).length, 3);
  assert.match(Format.tooltipText(state, NOW), /Claude · Personal/);
  assert.match(Format.tooltipText(state, NOW), /Claude · Trabajo/);
});

test('all accounts can be hidden and an AI icon remains to open the popup', () => {
  const state = multiAccountStatus();
  const entries = Format.panelEntries(state, {
    hiddenAccountIds: state.data.accounts.map((a) => a.id),
  }, NOW);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].icon, 'ai');
  assert.equal(entries[0].label, '');
  assert.equal(Format.accountsOf(state.data).length, 3);
});

test('disconnected accounts remain in the popup and disappear from the panel', () => {
  const state = multiAccountStatus();
  state.data.accounts[1].logged_out = true;
  state.data.accounts[1].error_code = 'logged_out';
  state.data.accounts[1].ok = false;
  const entries = Format.panelEntries(state, {}, NOW);
  assert.deepEqual(Array.from(entries, (entry) => entry.accountId), ['codex-personal', 'claude-work']);
  assert.match(Format.tooltipText(state, NOW), /Sesión cerrada/);
});

test('one failing account does not mark the other accounts stale', () => {
  const state = multiAccountStatus();
  state.data.stale = true;
  state.data.errors = [{ account_id: 'claude-work', code: 'network_error' }];
  const entries = Format.panelEntries(state, {}, NOW);
  assert.equal(entries[0].label, '3%');
  assert.equal(entries[2].label, '42%!');
});

test('Antigravity panel uses its most constrained quota and the tooltip retains every quota window', () => {
  const state = multiAccountStatus();
  state.data.accounts.push({
    id: 'google', provider: 'antigravity', label: 'Google', ok: true,
    source: 'antigravity-local', updated_at: new Date(NOW).toISOString(),
    quota: { used_percent: 75, remaining_percent: 25 },
    quota_windows: [
      { label: 'Gemini · Sesión', metric: { used_percent: 25 } },
      { label: 'Gemini · Semanal', metric: { used_percent: 75 } },
    ],
  });
  const entries = Format.panelEntries(state, {}, NOW);
  assert.equal(entries[3].label, '75%');
  assert.equal(entries[3].icon, 'antigravity');
  assert.match(Format.tooltipText(state, NOW), /Gemini · Sesión: 25%/);
  assert.match(Format.tooltipText(state, NOW), /Gemini · Semanal: 75%/);
  assert.equal(Format.panelEntries(state, { showAntigravity: false }, NOW).length, 3);
});

test('a missing CLI asks to install it and stale Antigravity data keeps the actionable reason', () => {
  assert.match(Format.providerErrorMessage('Antigravity', { provider: 'antigravity', error_code: 'cli_missing' }),
    /curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash$/);
  assert.match(Format.providerErrorMessage('Codex', { provider: 'codex', error_code: 'cli_missing' }),
    /npm install -g @openai\/codex$/);
  assert.match(Format.providerErrorMessage('Antigravity', { provider: 'antigravity', error_code: 'login_required' }), /ejecuta agy/);
  const stale = { provider: 'antigravity', source: 'antigravity-cli', stale: true, stale_reason: 'login_required',
    updated_at: new Date(NOW).toISOString() };
  assert.match(Format.providerNotice(stale), /^Inicia sesión en el CLI de Antigravity.*Se conservan los últimos datos/);
  assert.match(Format.providerSubtitle(stale, NOW), /^CLI · /);
});
