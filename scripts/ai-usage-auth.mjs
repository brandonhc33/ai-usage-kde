#!/usr/bin/env node
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clearStaleSingletonLock } from './lib/chrome-profile.mjs';

const HOME = os.homedir();
const provider = process.argv[2];

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

const providers = {
  codex: {
    profileDir: path.join(HOME, '.config', 'ai-usage-status', 'profiles', 'chatgpt'),
    url: 'https://chatgpt.com/codex/settings/usage',
    validate: /Límite de uso|usage limit|Créditos restantes|Credits remaining/i,
  },
  claude: {
    profileDir: path.join(HOME, '.config', 'ai-usage-status', 'profiles', 'claude'),
    url: 'https://claude.ai/new#settings/usage',
    validate: /Sesión actual|Current session|Todos los modelos|All models/i,
  },
};

if (!providers[provider]) {
  console.error('Uso: ai-usage-auth codex|claude');
  process.exit(1);
}

async function main() {
  const selected = providers[provider];
  await fs.mkdir(selected.profileDir, { recursive: true, mode: 0o700 });
  await clearStaleSingletonLock(selected.profileDir);

  const context = await chromium.launchPersistentContext(selected.profileDir, {
    // Usa el Chrome real del sistema (no el Chromium de Playwright): pasa los
    // chequeos "Verify you are human" / Private Access Token de Cloudflare
    // que bloquean al Chromium automatizado.
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = await context.newPage();
    await page.goto(selected.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    console.log(`\nInicia sesión en ${provider} en la ventana de Chromium.`);
    console.log('La sesión se guarda automáticamente apenas se detecte el panel de uso.\n');

    // No hay terminal interactiva cuando este script se lanza desde el
    // applet, así que la sesión se valida sondeando el texto de la página
    // hasta que aparezca el panel de uso (o hasta agotar el tiempo de
    // espera).
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let confirmed = false;

    while (Date.now() < deadline) {
      if (page.isClosed()) {
        console.error('La ventana se cerró antes de confirmar el login.');
        process.exitCode = 2;
        return;
      }

      const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      if (selected.validate.test(text)) {
        confirmed = true;
        break;
      }

      await page.waitForTimeout(POLL_INTERVAL_MS).catch(() => {});
    }

    if (!confirmed) {
      console.error(`No se detectó el panel de uso de ${provider} dentro del tiempo de espera.`);
      console.error('La sesión pudo guardarse igual; podés intentar "Actualizar ahora".');
      process.exitCode = 2;
      return;
    }

    console.log(`Login guardado correctamente para ${provider}.`);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((error) => {
  if (error.code === 'profile_busy') {
    console.error(`${provider}: ya hay una sesión de Chrome en uso para este perfil.`);
    console.error('Esperá a que termine y volvé a intentar.');
  } else {
    console.error(`ai-usage-auth ${provider}: ${error.message}`);
  }
  process.exitCode = 1;
});
