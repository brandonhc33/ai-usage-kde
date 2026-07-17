#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const CACHE_DIR = path.join(HOME, '.cache', 'ai-usage-status');
const OUT_FILE = path.join(CACHE_DIR, 'status.json');

// Script útil para desarrollo del applet sin Playwright.
// Genera un status.json fake con datos parecidos a los paneles reales.

const status = {
  schema_version: 1,
  updated_at: new Date().toISOString(),
  ok: true,
  stale: false,
  primary: {
    provider: 'codex',
    metric: 'five_hour',
    used_percent: 100,
    remaining_percent: 0,
    label: '100%',
  },
  codex: {
    ok: true,
    source: 'fake',
    updated_at: new Date().toISOString(),
    five_hour: { used_percent: 100, remaining_percent: 0, reset_label: '4:39', reset_epoch: null },
    weekly: { used_percent: 26, remaining_percent: 74, reset_label: '18 jun 2026 15:29', reset_epoch: null },
    credits_remaining: 128,
  },
  claude: {
    ok: true,
    source: 'fake',
    updated_at: new Date().toISOString(),
    session: { used_percent: 13, remaining_percent: 87, reset_label: 'en 2 h 33 min', reset_epoch: null },
    weekly: { used_percent: 1, remaining_percent: 99, reset_label: 'mié., 11:59 p.m.', reset_epoch: null },
    daily_routines: { used: 0, limit: 5 },
  },
  errors: [],
};

await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
await fs.writeFile(`${OUT_FILE}.tmp`, JSON.stringify(status, null, 2), { mode: 0o600 });
await fs.rename(`${OUT_FILE}.tmp`, OUT_FILE);
console.log(`Wrote ${OUT_FILE}`);
