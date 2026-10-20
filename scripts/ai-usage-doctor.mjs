#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CODEX_CLI_INSTALL, resolveCodexCommand } from './lib/structured-sources.mjs';
import { expandHome, loadConfig } from './lib/accounts.mjs';
import {
  ANTIGRAVITY_CLI_INSTALL, discoverAntigravityServers, resolveAntigravityCli,
} from './lib/antigravity.mjs';

const HOME = os.homedir();
let failures = 0;

function result(ok, label, detail, required = true) {
  const mark = ok ? 'ok' : required ? '!!' : '--';
  console.log(`[${mark}] ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok && required) failures += 1;
}

function findExecutable(names) {
  for (const name of names) {
    if (name.includes('/') && fs.existsSync(name)) return name;
    for (const directory of String(process.env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.join(directory, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Continue searching.
      }
    }
  }
  return null;
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

console.log('AI Usage KDE — diagnóstico\n');

result(Number(process.versions.node.split('.')[0]) >= 18, 'Node.js', process.version);

const browser = findExecutable([
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
]);
result(Boolean(browser), 'Chrome/Chromium (fallback)', browser ?? 'no encontrado', false);
const config = await loadConfig().catch(() => null);
for (const account of config?.accounts ?? []) {
  const label = `${account.provider === 'codex' ? 'Codex' : account.provider === 'claude' ? 'Claude' : 'Antigravity'} · ${account.label}`;
  if (account.logged_out || !account.enabled) {
    result(true, label, account.logged_out ? 'sesión cerrada' : 'desactivada', false);
    continue;
  }
  if (account.provider === 'antigravity') {
    const cli = await resolveAntigravityCli(account.config).catch(() => null);
    const servers = cli ? [] : await discoverAntigravityServers();
    result(Boolean(cli) || servers.length > 0, label, cli ? `CLI agy disponible (${cli})`
      : servers.length ? 'app abierta; instala el CLI para no depender de ella'
        : `instala el CLI: ${ANTIGRAVITY_CLI_INSTALL}`);
  } else if (account.config.source === 'web') {
    result(Boolean(browser), label, browser ? 'fallback web' : 'requiere Chrome/Chromium');
  } else if (account.provider === 'codex') {
    const command = await resolveCodexCommand(account.config).catch(() => null);
    const credentials = account.managed
      ? await readJson(path.join(expandHome(account.config.codex_home), 'auth.json')) : null;
    const usable = Boolean(command && (!account.managed || credentials?.tokens?.access_token));
    result(usable, label, usable ? 'CLI estructurado disponible'
      : command ? 'inicia sesión desde la tarjeta del widget' : `instala el CLI: ${CODEX_CLI_INSTALL}`);
  } else {
    const credentials = (await readJson(expandHome(account.config.oauth_credentials_file)))?.claudeAiOauth;
    const valid = Boolean(credentials?.accessToken && credentials?.scopes?.includes('user:profile')
      && Number(credentials?.expiresAt) > Date.now());
    result(valid, label, valid ? 'OAuth válido' : account.managed
      ? 'inicia sesión desde la tarjeta del widget' : 'abre Claude Code para renovar la sesión');
  }
}

const xvfb = findExecutable(['Xvfb']);
result(
  Boolean(xvfb),
  'Xvfb (fallback invisible)',
  xvfb ?? 'opcional: instala xorg-server-xvfb (Arch) o xvfb (Debian/Ubuntu)',
  false,
);

const qtPluginRoots = ['/usr/lib/qt6/plugins', '/usr/lib64/qt6/plugins'];
const qtpaths = findExecutable(['qtpaths6']);
if (qtpaths) {
  const query = spawnSync(qtpaths, ['--query', 'QT_INSTALL_PLUGINS'], { encoding: 'utf8' });
  if (query.status === 0 && query.stdout.trim()) qtPluginRoots.unshift(query.stdout.trim());
}
const executableEngine = qtPluginRoots
  .map((root) => path.join(root, 'plasma5support', 'dataengine', 'plasma_engine_executable.so'))
  .find((candidate) => fs.existsSync(candidate));
result(
  Boolean(executableEngine),
  'Backend de lectura Plasma',
  executableEngine ?? 'falta plasma5support',
);

const configFile = path.join(HOME, '.config', 'ai-usage-status', 'config.json');
result(Boolean(config), 'Configuración JSON', config ? `${configFile} (${config.accounts.length} cuentas)` : 'no válida');

const statusFile = path.join(HOME, '.cache', 'ai-usage-status', 'status.json');
const status = await readJson(statusFile);
result(Boolean(status?.updated_at), 'Estado del widget', status
  ? `${status.ok ? 'correcto' : 'con errores'}, actualizado ${status.updated_at}`
  : 'no existe');

const timer = spawnSync('systemctl', ['--user', 'is-enabled', 'ai-usage-collector.timer'], {
  encoding: 'utf8',
});
result(timer.status === 0, 'Timer systemd', (timer.stdout || timer.stderr).trim() || 'no instalado');

const providerState = await readJson(path.join(HOME, '.cache', 'ai-usage-status', 'provider-state.json'));
for (const [provider, incident] of Object.entries(providerState ?? {})) {
  result(
    false,
    `Incidente activo (${provider})`,
    `${incident.code} en ${incident.phase ?? '?'}, ${incident.count} veces desde ${incident.first_at}`,
    false,
  );
}

console.log(`\n${failures === 0 ? 'Todo listo.' : `${failures} comprobaciones requieren atención.`}`);
process.exitCode = failures === 0 ? 0 : 1;
