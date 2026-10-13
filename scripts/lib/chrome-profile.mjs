import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

async function executableExists(candidate) {
  try {
    await fs.access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveBrowserLaunchOptions() {
  const names = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'];
  for (const directory of String(process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (await executableExists(candidate)) return { executablePath: candidate };
    }
  }

  throw Object.assign(
    new Error('No se encontró Google Chrome ni Chromium para el fallback web.'),
    { code: 'browser_missing' },
  );
}

/**
 * Returns a stable-enough key for remembering launch compatibility. Package
 * upgrades replace the browser launcher, changing its size or mtime and
 * automatically causing the headed/Xvfb path to be tried again.
 */
export async function browserExecutableFingerprint(executablePath) {
  const stats = await fs.stat(executablePath);
  return `${executablePath}:${stats.size}:${Math.trunc(stats.mtimeMs)}`;
}

/**
 * Playwright reports an early browser process crash as a closed target. Keep
 * this deliberately narrower than all launch errors: a missing display or a
 * bad configuration should still be surfaced instead of being remembered as
 * a browser incompatibility.
 */
export function isBrowserProcessCrash(error) {
  const message = String(error?.message ?? error);
  return /launchPersistentContext/i.test(message)
    && /signal=SIG(?:SEGV|ILL|BUS|ABRT)/i.test(message);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Chrome's persistent-context profiles are guarded by a `SingletonLock`
 * symlink (`hostname-pid`). If the owning process is gone, remove the
 * leftover lock files; if it's still running, surface `profile_busy` so the
 * caller can report it instead of crashing on launchPersistentContext.
 */
export async function clearStaleSingletonLock(profileDir) {
  const lockPath = path.join(profileDir, 'SingletonLock');
  let target;
  try {
    target = await fs.readlink(lockPath);
  } catch {
    return;
  }

  const pid = Number(target.split('-').pop());

  if (Number.isInteger(pid) && isProcessAlive(pid)) {
    throw Object.assign(
      new Error('Ya hay una sesión de Chrome en uso para este perfil.'),
      { code: 'profile_busy' },
    );
  }

  await Promise.all(
    SINGLETON_FILES.map((name) => fs.rm(path.join(profileDir, name), { force: true })),
  );
}
