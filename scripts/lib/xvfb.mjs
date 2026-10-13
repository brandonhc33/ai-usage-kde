import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

let cachedAvailable;

function hasXvfb() {
  cachedAvailable ??= new Promise((resolve) => {
    execFile('which', ['Xvfb'], (error) => resolve(!error));
  });
  return cachedAvailable;
}

async function readRecoveryMarker(file) {
  if (!file) return null;
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function recoveryApplies(file, compatibilityKey) {
  if (!file || !compatibilityKey) return false;
  const marker = await readRecoveryMarker(file);
  return marker?.mode === 'headless' && marker?.compatibility_key === compatibilityKey;
}

async function rememberHeadlessRecovery(file, compatibilityKey, error) {
  if (!file || !compatibilityKey) return;

  const marker = {
    schema_version: 1,
    mode: 'headless',
    compatibility_key: compatibilityKey,
    detected_at: new Date().toISOString(),
    reason: /SIGSEGV/i.test(String(error?.message ?? error))
      ? 'browser_sigsegv_on_xvfb'
      : 'browser_crash_on_xvfb',
  };
  const tmp = `${file}.${process.pid}.tmp`;

  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(tmp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

function headlessDisplay(reason) {
  return {
    headless: true,
    args: ['--disable-gpu'],
    mode: 'headless-recovery',
    reason,
  };
}

/**
 * Cloudflare's bot check can block Chrome/Chromium headless mode even with
 * anti-automation flags, but passes headed mode.
 * When Xvfb is installed, run headed Chrome inside a throwaway virtual
 * display so it's invisible to the user but still looks "headed" to
 * Cloudflare. Falls back to the caller's own headless setting if Xvfb isn't
 * installed (`sudo apt install xvfb`).
 */
export async function withDisplay(fn, options = {}) {
  const {
    compatibilityKey,
    recoveryFile,
    shouldRetryHeadless = () => false,
    onHeadlessRecovery = () => {},
  } = options;

  if (await recoveryApplies(recoveryFile, compatibilityKey)) {
    return fn(headlessDisplay('cached-browser-incompatibility'));
  }

  if (!(await hasXvfb())) {
    return fn({});
  }

  const display = `:${100 + Math.floor(Math.random() * 800)}`;
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], {
    stdio: 'ignore',
  });

  try {
    await delay(300);

    // Chrome prefers Wayland over $DISPLAY when WAYLAND_DISPLAY is set
    // (true in a COSMIC/Wayland session), which would render on the real
    // screen instead of the virtual display. Strip Wayland detection and
    // force the X11 backend so Chrome actually uses Xvfb.
    const env = { ...process.env, DISPLAY: display };
    delete env.WAYLAND_DISPLAY;
    delete env.XDG_SESSION_TYPE;

    try {
      return await fn({
        headless: false,
        env,
        args: ['--ozone-platform=x11'],
        mode: 'xvfb',
      });
    } catch (error) {
      if (!shouldRetryHeadless(error)) throw error;

      // Remember the crash before retrying. Even if the page later rejects
      // headless automation, repeatedly launching the known-crashing X11 path
      // every two minutes would only create more coredumps.
      await rememberHeadlessRecovery(recoveryFile, compatibilityKey, error);
      await onHeadlessRecovery(error);
      return fn(headlessDisplay('browser-crashed-on-xvfb'));
    }
  } finally {
    xvfb.kill();
  }
}
