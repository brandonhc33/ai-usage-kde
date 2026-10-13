import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  browserExecutableFingerprint,
  isBrowserProcessCrash,
} from '../lib/chrome-profile.mjs';

test('detects the Playwright SIGSEGV launch failure', () => {
  const error = new Error(
    'browserType.launchPersistentContext: Target page has been closed\n'
      + '[pid=42] <process did exit: exitCode=null, signal=SIGSEGV>',
  );

  assert.equal(isBrowserProcessCrash(error), true);
});

test('does not treat ordinary navigation failures as browser crashes', () => {
  assert.equal(isBrowserProcessCrash(new Error('page.goto: net::ERR_TIMED_OUT')), false);
  assert.equal(
    isBrowserProcessCrash(new Error('browserType.launchPersistentContext: executable missing')),
    false,
  );
});

test('browser fingerprint changes when the launcher changes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-usage-browser-test-'));
  const executable = path.join(directory, 'browser');

  try {
    await fs.writeFile(executable, 'v1');
    const first = await browserExecutableFingerprint(executable);
    await fs.writeFile(executable, 'version-two');
    const second = await browserExecutableFingerprint(executable);
    assert.notEqual(first, second);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
