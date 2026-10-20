import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const Layout = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('../../package/contents/code/layout.js', import.meta.url), 'utf8')
  .replace(/^\.pragma library\s*$/m, ''), Layout);
const accounts = [
  { id: 'claude-work', provider: 'claude' },
  { id: 'codex-one', provider: 'codex' },
  { id: 'claude-personal', provider: 'claude' },
  { id: 'google-one', provider: 'antigravity' },
];
const ids = (plan) => Array.from(plan.lanes, (lane) => Array.from(lane.accounts, (account) => account.id)).flat();

test('automatic layout gives each agent a lane and keeps all accounts, including unpinned ones', () => {
  const plan = Layout.plan(accounts, { screenWidth: 1600, screenHeight: 950 });
  assert.equal(plan.columns, 3);
  assert.deepEqual(Array.from(plan.lanes, (lane) => lane.provider), ['codex', 'claude', 'antigravity']);
  assert.deepEqual(ids(plan), ['codex-one', 'claude-work', 'claude-personal', 'google-one']);
  assert.equal(plan.autoHeight, true);
});

test('manual rows continue the same agent in adjacent columns', () => {
  const plan = Layout.plan(accounts, { screenWidth: 1800, screenHeight: 950, rows: 1, columns: 4 });
  assert.equal(plan.columns, 4);
  assert.equal(plan.lanes.length, 4);
  assert.equal(plan.lanes[1].provider, 'claude');
  assert.equal(plan.lanes[2].provider, 'claude');
  assert.equal(plan.lanes[1].part, 1);
  assert.equal(plan.lanes[2].part, 2);
  assert.equal(plan.lanes[2].parts, 2);
  assert.equal(ids(plan).length, 4);
});

test('width and height can be controlled independently and are bounded by the screen', () => {
  const plan = Layout.plan(accounts, {
    screenWidth: 1000, screenHeight: 700,
    autoWidth: false, autoHeight: false, width: 1200, height: 900, columns: 4,
  });
  assert.equal(plan.width, 1000);
  assert.equal(plan.height, 700);
  assert.equal(plan.autoHeight, false);
  assert.equal(plan.columns, 3);
  const mixed = Layout.plan(accounts, { screenWidth: 1600, autoWidth: true, autoHeight: false, height: 500 });
  assert.equal(mixed.height, 500);
  assert.equal(mixed.width, 1488);
  assert.equal(mixed.rows, 1);
});

test('a narrow manual window reduces columns instead of clipping account cards', () => {
  const plan = Layout.plan(accounts, { screenWidth: 1000, autoWidth: false, width: 340, columns: 4 });
  assert.equal(plan.columns, 1);
  assert.equal(plan.width, 340);
  assert.equal(ids(plan).length, 4);
});

test('empty accounts produce a usable window and large groups retain every row', () => {
  assert.equal(Layout.plan([], {}).columns, 1);
  const large = Array.from({ length: 25 }, (_, i) => ({ id: `claude-${i}`, provider: 'claude' }));
  const plan = Layout.plan(large, { screenWidth: 1400, screenHeight: 900, columns: 3, rows: 2 });
  assert.equal(plan.lanes.length, 13);
  assert.equal(ids(plan).length, 25);
  assert.equal(new Set(ids(plan)).size, 25);
});

test('automatic rows allow for taller Antigravity cards before adding another column', () => {
  const accounts = Array.from({ length: 3 }, (_, i) => ({
    id: `google-${i}`, provider: 'antigravity', quota_windows: [{}, {}, {}, {}],
  }));
  const plan = Layout.plan(accounts, { screenWidth: 1600, screenHeight: 900 });
  assert.equal(plan.columns, 2);
  assert.deepEqual(Array.from(plan.lanes, (lane) => lane.accounts.length), [2, 1]);
});
