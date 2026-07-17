import { spawn, execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

let cachedAvailable;

function hasXvfb() {
  cachedAvailable ??= new Promise((resolve) => {
    execFile('which', ['Xvfb'], (error) => resolve(!error));
  });
  return cachedAvailable;
}

/**
 * Cloudflare's bot check blocks Chrome's headless mode (even with
 * `channel: 'chrome'` and anti-automation flags), but passes headed mode.
 * When Xvfb is installed, run headed Chrome inside a throwaway virtual
 * display so it's invisible to the user but still looks "headed" to
 * Cloudflare. Falls back to the caller's own headless setting if Xvfb isn't
 * installed (`sudo apt install xvfb`).
 */
export async function withDisplay(fn) {
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

    return await fn({ headless: false, env, args: ['--ozone-platform=x11'] });
  } finally {
    xvfb.kill();
  }
}
