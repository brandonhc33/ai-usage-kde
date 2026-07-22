#!/usr/bin/env bash
# Automated setup for the AI Usage KDE Plasma widget.
#
# Installs the plasmoid package, prepares ~/.cache and ~/.config directories
# with the right permissions, publishes the collector scripts to
# ~/.local/bin, tries to add the widget to the current panel, and enables
# the systemd collector timer.
#
# Steps that need interactive input (Chrome login) are printed at the end
# instead of being run automatically. Safe to re-run.

set -euo pipefail
cd "$(dirname "$0")"

APPLET_ID="com.github.brandonhc33.ai-usage-kde"

for cmd in node npm kpackagetool6; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: '$cmd' no está instalado. Revisá la sección 'Requisitos' del README." >&2
    exit 1
  fi
done

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "error: AI Usage requiere Node.js 18 o posterior (encontrado: $(node --version))." >&2
  exit 1
fi

# Resuelve el binario real antes de crear enlaces. `command -v node` puede
# devolver ~/.local/bin/node en una reinstalación; enlazar ese path sobre sí
# mismo produciría un loop. También repara un loop dejado por versiones
# anteriores del instalador antes de ejecutar npm (cuyo shebang usa env node).
NODE_BIN="$(readlink -f "$(command -v node)" 2>/dev/null || true)"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  for candidate in /usr/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "error: no se pudo resolver un binario Node.js real." >&2
  exit 1
fi
mkdir -p ~/.local/bin
ln -sf "$NODE_BIN" ~/.local/bin/node

browser=""
for candidate in google-chrome-stable google-chrome chromium chromium-browser; do
  if command -v "$candidate" >/dev/null 2>&1; then
    browser="$candidate"
    break
  fi
done
if [ -z "$browser" ]; then
  echo "advertencia: no se encontró Chrome/Chromium." >&2
  echo "             Solo se necesita para login y fallback web; las fuentes CLI/OAuth" >&2
  echo "             estructuradas pueden funcionar sin navegador." >&2
else
  echo "==> Navegador para login/fallback: $browser"
fi

echo "==> Instalando dependencias del colector"
(cd scripts && npm ci)

echo "==> Preparando directorios en ~/.cache y ~/.config"
mkdir -p ~/.cache/ai-usage-status
mkdir -p ~/.config/ai-usage-status/profiles/chatgpt
mkdir -p ~/.config/ai-usage-status/profiles/claude
chmod 700 ~/.cache/ai-usage-status
chmod 700 ~/.config/ai-usage-status
chmod 700 ~/.config/ai-usage-status/profiles
chmod 700 ~/.config/ai-usage-status/profiles/chatgpt
chmod 700 ~/.config/ai-usage-status/profiles/claude

if [ ! -f ~/.config/ai-usage-status/config.json ]; then
  echo "==> Copiando configuración por defecto del colector"
  cp templates/config.example.json ~/.config/ai-usage-status/config.json
fi
chmod 600 ~/.config/ai-usage-status/config.json

echo "==> Publicando scripts en ~/.local/bin"
ln -sf "$(pwd)/scripts/ai-usage-collect.mjs" ~/.local/bin/ai-usage-collect
ln -sf "$(pwd)/scripts/ai-usage-auth.mjs" ~/.local/bin/ai-usage-auth
ln -sf "$(pwd)/scripts/ai-usage-clear-errors.mjs" ~/.local/bin/ai-usage-clear-errors
ln -sf "$(pwd)/scripts/ai-usage-doctor.mjs" ~/.local/bin/ai-usage-doctor

# Plasma lanza el motor "executable" con un PATH reducido que normalmente no
# incluye el node de nvm; sin este enlace los botones del popup fallan en
# silencio (ver sección "Publicar los scripts en PATH" del README).
ln -sf "$NODE_BIN" ~/.local/bin/node

# La fuente preferida de Codex usa `codex app-server`. systemd no hereda
# necesariamente el PATH de la terminal (en este equipo Codex viene de Zed),
# por lo que publicamos un enlace estable cuando el CLI ya está disponible.
if command -v codex >/dev/null 2>&1; then
  codex_path="$(command -v codex)"
  if [ "$codex_path" != "$HOME/.local/bin/codex" ]; then
    ln -sf "$codex_path" ~/.local/bin/codex
  fi
fi

echo "==> Instalando el plasmoide"
if kpackagetool6 --type Plasma/Applet --show "$APPLET_ID" >/dev/null 2>&1; then
  kpackagetool6 --type Plasma/Applet --upgrade package
else
  kpackagetool6 --type Plasma/Applet --install package
fi

echo "==> Integrando el widget en el panel"
QDBUS="$(command -v qdbus6 || command -v qdbus || true)"
panel_added=0
if [ -n "$QDBUS" ]; then
  if "$QDBUS" org.kde.plasmashell /PlasmaShell org.kde.PlasmaShell.evaluateScript "
    var already = false;
    var p = panels();
    for (var i = 0; i < p.length; i++) {
      var widgets = p[i].widgetIds;
      for (var j = 0; j < widgets.length; j++) {
        if (p[i].widgetById(widgets[j]).type == '$APPLET_ID') { already = true; }
      }
    }
    if (!already && p.length > 0) {
      p[0].addWidget('$APPLET_ID');
      print('added');
    } else if (already) {
      print('already-present');
    } else {
      print('no-panels');
    }
  " 2>/tmp/ai-usage-kde-panel-add.log | grep -q 'added\|already-present'; then
    panel_added=1
    echo "    listo (o ya estaba presente)"
  fi
fi

if [ "$panel_added" -ne 1 ]; then
  echo "    no se pudo automatizar (¿plasmashell no está corriendo con D-Bus?)"
  echo "    agregalo a mano: click derecho en el panel > Añadir widgets > 'AI Usage'"
fi

echo "==> Habilitando el timer de systemd del colector"
mkdir -p ~/.config/systemd/user
cp systemd/ai-usage-collector.service systemd/ai-usage-collector.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ai-usage-collector.timer

cat <<'EOF'

==> Listo.

1. Ejecutá el diagnóstico seguro (no imprime tokens ni cookies):
     ai-usage-doctor
2. Solo si falta una fuente estructurada y el fallback web pide login, abrí el
   popup y usá "Configurar Codex/Claude".
3. Xvfb es opcional para ejecutar el fallback web sin una ventana visible:
     sudo pacman -S xorg-server-xvfb
EOF
