#!/usr/bin/env node
// Dismisses the current collector alert without modifying cached usage data,
// mirroring `status::clear_errors` from the COSMIC applet's Rust source
// (see ../../ai-usage/src/status.rs). The QML plasmoid has no native
// filesystem write access, so this is invoked as a subprocess by the
// "Limpiar error" button in main.qml, same as ai-usage-collect/ai-usage-auth.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const CACHE_DIR = path.join(HOME, '.cache', 'ai-usage-status');
const STATUS_FILE = path.join(CACHE_DIR, 'status.json');
const ERROR_LOG_FILE = path.join(CACHE_DIR, 'errors.log');
const LOCK_FILE = path.join(CACHE_DIR, 'collector.lock');
const LOCK_STALE_MS = 10 * 60 * 1000;

function processExists(pid) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function collectorRunning() {
  const lock = await readJson(LOCK_FILE).catch(() => null);
  if (!lock) return false;
  const startedAt = Date.parse(lock.started_at);
  if (!Number.isFinite(startedAt)) return false;
  if (Date.now() - startedAt > LOCK_STALE_MS) return false;
  return processExists(lock.pid);
}

async function writeAtomic(file, data) {
  const tmp = `${file}.clear-errors-${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function main() {
  if (await collectorRunning()) {
    console.error('ai-usage-clear-errors: hay una actualización en curso.');
    process.exitCode = 1;
    return;
  }

  const status = await readJson(STATUS_FILE);

  status.errors = [];
  status.stale = false;
  status.ok = true;
  status.alert_cleared_at = new Date().toISOString();

  await writeAtomic(STATUS_FILE, status);

  await fs.rm(ERROR_LOG_FILE, { force: true });
}

main().catch((error) => {
  console.error(`ai-usage-clear-errors: ${error.message}`);
  process.exitCode = 1;
});
