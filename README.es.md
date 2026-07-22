# AI Usage para KDE Plasma 6

**Español** | [English](README.md)

AI Usage es un widget de panel de solo lectura que monitorea los límites de
uso de Codex y Claude. No envía prompts, no consume créditos ni realiza
solicitudes de IA en nombre del usuario.

El widget prefiere fuentes locales y estructuradas:

- **Codex:** `account/rateLimits/read` mediante el app server local de Codex.
- **Claude:** el endpoint oficial de uso con la sesión OAuth local de Claude
  Code.

El paquete de KDE Store incluye el colector y se actualiza automáticamente
cada dos minutos. Para el uso normal no necesita un servicio en segundo plano,
ejecutar npm ni automatizar un navegador.

## Requisitos

- KDE Plasma 6.0 o posterior.
- Node.js 18 o posterior.
- El módulo QML Plasma 5 Support utilizado por Plasma 6.
- Codex CLI y/o Claude Code, según las cuentas que quieras monitorear.

El widget funciona con uno o con ambos proveedores. No es obligatorio tener
los dos.

## Configuración inicial

### Arch Linux, CachyOS y Manjaro

Instala las dependencias de ejecución:

```bash
sudo pacman -S --needed nodejs npm plasma5support curl
```

Instala y autentica los proveedores que quieras monitorear.

Codex CLI:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex login
```

Claude Code:

```bash
npm install -g @anthropic-ai/claude-code
claude
```

En la primera ejecución de Claude Code, selecciona el inicio de sesión
correspondiente a tu suscripción. No uses `sudo npm install -g`.

### Debian y Ubuntu

Este widget requiere Plasma 6. Debian 13 o posterior es compatible. En Ubuntu,
usa una versión que incluya Plasma 6, como Kubuntu 25.10 o posterior. Ubuntu y
Kubuntu 24.04 incluyen Plasma 5 y no pueden ejecutar este widget.

Instala las dependencias de ejecución:

```bash
sudo apt update
sudo apt install nodejs npm curl qml6-module-org-kde-plasma-plasma5support
```

Instala y autentica los proveedores que quieras monitorear.

Codex CLI:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex login
```

Claude Code:

```bash
npm install -g @anthropic-ai/claude-code
claude
```

Si `node --version` muestra una versión anterior a 18, instala una versión
actual de Node.js antes de continuar.

## Instalar el widget

### KDE Store

1. Haz clic derecho en el panel y selecciona **Entrar al modo edición**.
2. Selecciona **Añadir widgets**.
3. Selecciona **Obtener nuevos widgets** y **Descargar nuevos widgets de Plasma**.
4. Busca **AI Usage** y selecciona **Instalar**.
5. Añade AI Usage al panel.

La primera lectura se inicia automáticamente. Usa **Actualizar ahora** en el
popup para reintentar después de iniciar sesión en Codex o Claude.

### Archivo `.plasmoid` local

```bash
kpackagetool6 --type Plasma/Applet --install ai-usage-kde-0.3.0.plasmoid
```

Para una actualización, usa `--upgrade` en lugar de `--install`.

## Instalación completa opcional

El instalador del repositorio añade un timer de systemd de usuario y un
fallback web opcional con Playwright. La edición de KDE Store no necesita esos
componentes.

Sistemas basados en Arch:

```bash
sudo pacman -S --needed nodejs npm plasma-sdk plasma5support qt6-tools
git clone https://github.com/brandonhc33/ai-usage-kde.git
cd ai-usage-kde
./install.sh
```

Debian/Ubuntu con Plasma 6:

```bash
sudo apt update
sudo apt install nodejs npm plasma-sdk \
  qml6-module-org-kde-plasma-plasma5support qt6-tools-dev-tools
git clone https://github.com/brandonhc33/ai-usage-kde.git
cd ai-usage-kde
./install.sh
```

Para el fallback web opcional, instala Google Chrome o Chromium y `xvfb`. Las
fuentes estructuradas de Codex y Claude siguen siendo el modo recomendado.

## Configuración

La primera lectura crea:

```text
~/.config/ai-usage-status/config.json
~/.cache/ai-usage-status/status.json
```

La configuración predeterminada habilita ambos proveedores. Para monitorear
solo uno, cambia a `false` el valor `enabled` del otro proveedor en
`config.json`.

Los valores de fuente compatibles son:

| Proveedor | Valores | Orden predeterminado |
|---|---|---|
| Codex | `auto`, `cli`, `web` | Codex CLI y luego fallback web opcional |
| Claude | `auto`, `oauth`, `web` | Claude OAuth y luego fallback web opcional |

El paquete de KDE Store siempre interpreta `auto` como fuentes estructuradas.
El modo web explícito solo está disponible con la instalación completa
opcional.

## Privacidad y seguridad

- La interfaz del widget nunca recibe tokens ni cookies; solo lee un snapshot
  JSON local.
- El colector lee las sesiones locales existentes de Codex CLI y Claude Code,
  y envía credenciales únicamente a sus servicios oficiales correspondientes.
- Los archivos de estado y registro no contienen tokens de acceso.
- Los archivos generados usan permisos restrictivos para el usuario.
- El código está publicado bajo la [licencia MIT](LICENSE).

## Diagnóstico

Comprueba las versiones instaladas y las sesiones de los proveedores:

```bash
node --version
codex --version
claude --version
```

Para la instalación completa:

```bash
ai-usage-doctor
systemctl --user status ai-usage-collector.timer
journalctl --user -u ai-usage-collector.service -n 100 --no-pager
```

Los errores detallados del colector están en:

```text
~/.cache/ai-usage-status/errors.log
```

## Desarrollo y empaquetado

```bash
just check
just run
just package-store
```

`just package-store` crea en `dist/` el archivo autónomo para KDE Store. El
archivo contiene `metadata.json` en la raíz e incluye únicamente el colector
estructurado; no incluye Playwright ni `node_modules`.

Errores y sugerencias: <https://github.com/brandonhc33/ai-usage-kde/issues>
