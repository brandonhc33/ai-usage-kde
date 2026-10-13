# 07 — Instalación completa opcional y systemd

La instalación normal desde KDE Store no necesita este procedimiento: el
archivo `.plasmoid` incluye el colector estructurado y QML actualiza cada dos
minutos. Esta guía corresponde a la modalidad avanzada con fallback web y
timer de systemd.

## Paquetes

### Arch Linux, CachyOS y Manjaro

```bash
sudo pacman -S --needed nodejs npm plasma-sdk plasma5support qt6-tools
```

Para el fallback web invisible:

```bash
sudo pacman -S --needed xorg-server-xvfb
```

### Debian 13 y Ubuntu/Kubuntu con Plasma 6

```bash
sudo apt update
sudo apt install nodejs npm plasma-sdk \
  qml6-module-org-kde-plasma-plasma5support qt6-tools-dev-tools
```

Para el fallback web invisible:

```bash
sudo apt install chromium xvfb
```

Si una combinación concreta de Chrome, X11 y Xvfb hace caer el proceso del
navegador, el colector cambia automáticamente a headless y guarda la decisión
en `~/.cache/ai-usage-status/browser-display-mode.json`. La marca solo se
reutiliza mientras no cambie el ejecutable de Chrome.

Ubuntu/Kubuntu 24.04 usa Plasma 5 y no es compatible con este plasmoide.

Chrome/Chromium solo es obligatorio para autenticación y fallback. El camino
normal con Codex CLI + Claude OAuth no inicia navegador.

## Instalación completa

```bash
./install.sh
```

El script usa `npm ci`, publica comandos en `~/.local/bin`, instala/actualiza el
KPackage y habilita las unidades de usuario. También enlaza el `codex` visible
en la terminal a `~/.local/bin/codex`; esto es importante en CachyOS cuando el
CLI proviene de Zed, nvm u otro PATH que systemd no hereda.

## Solo plasmoide

Para desarrollo de QML:

```bash
kpackagetool6 --type Plasma/Applet --install package
kpackagetool6 --type Plasma/Applet --upgrade package
kpackagetool6 --type Plasma/Applet --remove com.github.brandonhc33.ai-usage-kde
```

La instalación de usuario queda en:

```text
~/.local/share/plasma/plasmoids/com.github.brandonhc33.ai-usage-kde/
```

## Timer

Las unidades instaladas son:

```ini
# ~/.config/systemd/user/ai-usage-collector.service
[Service]
Type=oneshot
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin
Environment=AI_USAGE_QUIET=1
ExecStart=%h/.local/bin/ai-usage-collect
TimeoutStartSec=3min
UMask=0077
```

```ini
# ~/.config/systemd/user/ai-usage-collector.timer
[Timer]
OnStartupSec=30s
OnUnitInactiveSec=2min
Persistent=true
```

Instalación manual:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/ai-usage-collector.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ai-usage-collector.timer
```

`OnUnitInactiveSec` programa la siguiente ejecución desde el final de la
anterior, evitando carreras si un fallback web demora. El lock del colector es
una segunda defensa frente a ejecuciones manuales simultáneas.

El widget tiene su propio timer, pero llama al colector con `--if-older-than`:
si el timer de systemd acaba de escribir `status.json`, no repite el trabajo.
Para dejar solo el de systemd, pon **Actualizar cada** en 0 en la
configuración del widget.

## Verificación

```bash
ai-usage-doctor
systemctl --user status ai-usage-collector.timer
systemctl --user status ai-usage-collector.service
journalctl --user -u ai-usage-collector.service -n 100 --no-pager
```

Forzar una corrida:

```bash
systemctl --user start ai-usage-collector.service
```

## Integración en el panel

`install.sh` intenta agregar el widget por D-Bus sin duplicarlo. Si Plasma no
está activo, no hay paneles o la API de scripting rechaza la operación, el
paquete igual queda instalado. Agrégalo manualmente desde **Añadir widgets**.

## Desinstalación

```bash
just uninstall-user
systemctl --user disable --now ai-usage-collector.timer
rm -f ~/.config/systemd/user/ai-usage-collector.{service,timer}
systemctl --user daemon-reload
rm -f ~/.local/bin/ai-usage-{auth,collect,clear-errors,doctor}
```

Los perfiles y credenciales se conservan deliberadamente. Bórralos solo si ya
no necesitas sus sesiones:

```bash
rm -rf ~/.cache/ai-usage-status ~/.config/ai-usage-status
```
