#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

const codex = findExecutable([
  path.join(HOME, '.local', 'bin', 'codex'),
  'codex',
]);
result(Boolean(codex), 'Codex CLI', codex ?? 'no encontrado; se usará fallback web', false);

const credentialsFile = path.join(HOME, '.claude', '.credentials.json');
const credentials = (await readJson(credentialsFile))?.claudeAiOauth;
const oauthValid = Boolean(
  credentials?.accessToken
  && credentials?.scopes?.includes('user:profile')
  && Number(credentials?.expiresAt) > Date.now(),
);
const oauthDetail = !credentials
  ? 'no encontrado; se usará fallback web'
  : oauthValid
    ? `válido hasta ${new Date(credentials.expiresAt).toLocaleString()}`
    : 'ausente, expirado o sin scope user:profile; se usará fallback web';
result(oauthValid, 'Claude OAuth', oauthDetail, false);

const browser = findExecutable(['google-chrome-stable', 'google-chrome', 'chromium']);
result(Boolean(browser), 'Chrome/Chromium (fallback)', browser ?? 'no encontrado', false);
result(Boolean(codex || browser), 'Fuente utilizable para Codex', codex ? 'CLI estructurado' : browser ? 'fallback web' : 'ninguna');
result(Boolean(oauthValid || browser), 'Fuente utilizable para Claude', oauthValid ? 'OAuth estructurado' : browser ? 'fallback web' : 'ninguna');

const xvfb = findExecutable(['Xvfb']);
result(Boolean(xvfb), 'Xvfb (fallback invisible)', xvfb ?? 'opcional: sudo pacman -S xorg-server-xvfb', false);

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
result(Boolean(await readJson(configFile)), 'Configuración JSON', configFile);

const statusFile = path.join(HOME, '.cache', 'ai-usage-status', 'status.json');
const status = await readJson(statusFile);
result(Boolean(status?.updated_at), 'Estado del widget', status
  ? `${status.ok ? 'correcto' : 'con errores'}, actualizado ${status.updated_at}`
  : 'no existe');

const timer = spawnSync('systemctl', ['--user', 'is-enabled', 'ai-usage-collector.timer'], {
  encoding: 'utf8',
});
result(timer.status === 0, 'Timer systemd', (timer.stdout || timer.stderr).trim() || 'no instalado');

console.log(`\n${failures === 0 ? 'Todo listo.' : `${failures} comprobaciones requieren atención.`}`);
process.exitCode = failures === 0 ? 0 : 1;
