#!/usr/bin/env node
// Dismisses the current collector alert without modifying cached usage data,
// mirroring `status::clear_errors` from the COSMIC applet's Rust source
// (see ../../ai-usage/src/status.rs). The QML plasmoid has no native
// filesystem write access, so this is invoked as a subprocess by the
// "Limpiar error" button in main.qml, same as ai-usage-collect/ai-usage-auth.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireLock } from './lib/accounts.mjs';

const HOME = os.homedir();
const CACHE_DIR = path.join(HOME, '.cache', 'ai-usage-status');
const STATUS_FILE = path.join(CACHE_DIR, 'status.json');
const ERROR_LOG_FILE = path.join(CACHE_DIR, 'errors.log');
const PROVIDER_STATE_FILE = path.join(CACHE_DIR, 'provider-state.json');
async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeAtomic(file, data) {
  const tmp = `${file}.clear-errors-${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function main() {
  const release = await acquireLock();
  try {
    const status = await readJson(STATUS_FILE);

    status.errors = [];
    status.stale = false;
    status.ok = true;
    status.alert_cleared_at = new Date().toISOString();

    await writeAtomic(STATUS_FILE, status);

    await fs.rm(ERROR_LOG_FILE, { force: true });
    // Forget known incidents too: otherwise a failure that is still happening
    // would not be written again to the now empty log (and its web backoff
    // would keep running).
    await fs.rm(PROVIDER_STATE_FILE, { force: true });
  } finally {
    await release();
  }
}

main().catch((error) => {
  console.error(`ai-usage-clear-errors: ${error.message}`);
  process.exitCode = 1;
});
