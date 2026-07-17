# AI Usage para KDE Plasma 6

Widget de panel para ver los límites de uso de Codex y Claude en KDE Plasma 6.
Está pensado para Arch Linux y CachyOS, aunque solo depende de Plasma 6,
Node.js y systemd de usuario.

La versión actual evita el scraping siempre que puede:

1. **Codex:** consulta `account/rateLimits/read` mediante el `codex app-server`
   local.
2. **Claude:** consulta el endpoint OAuth de uso con las credenciales locales de
   Claude Code (`~/.claude/.credentials.json`).
3. **Fallback web:** si una fuente estructurada no está disponible, Playwright
   usa un perfil aislado de Chrome y parsea el panel web.
4. El colector escribe `~/.cache/ai-usage-status/status.json`; el plasmoide QML
   solo lo lee. Un timer de systemd actualiza el archivo cada dos minutos.

Esto reduce una actualización normal de dos navegadores automatizados a dos
consultas estructuradas cortas, elimina ventanas inesperadas y resiste mucho
mejor los cambios de texto/DOM de ChatGPT y Claude.

## Estado actual

- Plasma 6 nativo: `PlasmoidItem`, metadata JSON y imports QML sin versión.
- Codex admite cuentas con dos ventanas (5 horas + semanal) y el esquema nuevo
  que expone únicamente una ventana semanal.
- Claude admite sesión, semanal, límites extra y créditos de uso cuando la API
  los entrega.
- Se conserva el último snapshot válido si falla temporalmente un proveedor.
- El colector usa lock atómico, archivos con permiso `0600` y fallback web
  opcional.
- Incluye tests de los mapeos estructurados y de los parsers web actuales.

## Instalación rápida en Arch/CachyOS

Dependencias base:

```bash
sudo pacman -S --needed nodejs npm plasma-sdk plasma5support qt6-tools
```

Opcionales para el fallback web:

```bash
sudo pacman -S --needed xorg-server-xvfb
# Chrome estable suele instalarse desde AUR, por ejemplo con tu helper habitual.
```

Después:

```bash
./install.sh
```

El instalador es idempotente y hace lo siguiente:

- ejecuta `npm ci` dentro de `scripts/`;
- prepara `~/.config/ai-usage-status` y `~/.cache/ai-usage-status`;
- publica los comandos en `~/.local/bin`;
- crea un enlace estable al CLI `codex` cuando está disponible;
- instala o actualiza el plasmoide con `kpackagetool6`;
- intenta agregarlo al panel actual;
- instala y habilita `ai-usage-collector.timer` como servicio de usuario.

Verifica la instalación sin mostrar tokens ni cookies:

```bash
ai-usage-doctor
```

Si el widget no fue agregado automáticamente: click derecho en el panel →
**Entrar al modo edición** → **Añadir widgets** → buscar **AI Usage**.

## Autenticación

### Codex

La fuente preferida usa la sesión del CLI oficial:

```bash
codex login
codex --version
```

El instalador enlaza el `codex` encontrado en la terminal a
`~/.local/bin/codex`, porque el PATH de systemd/Plasma puede ser distinto. Si no
hay CLI o no está autenticado, `source: "auto"` cae al perfil web aislado.

### Claude

La fuente preferida lee `claudeAiOauth` desde:

```text
~/.claude/.credentials.json
```

El token debe estar vigente y tener el scope `user:profile`. El proyecto nunca
lo copia a `status.json`, al log ni al plasmoide. Si no existe, expiró o no tiene
ese scope, se usa el fallback web.

### Login del fallback web

Desde el popup del widget, pulsa **Iniciar sesión Codex** o **Iniciar sesión
Claude**. También puedes hacerlo por terminal:

```bash
ai-usage-auth codex
ai-usage-auth claude
```

Cada proveedor usa su propio perfil bajo
`~/.config/ai-usage-status/profiles/`. La ventana se cierra al detectar el panel
de uso. Xvfb permite que las actualizaciones posteriores se ejecuten en un
display virtual; el login inicial siempre es visible.

## Uso y diagnóstico

Forzar una actualización:

```bash
ai-usage-collect
# o
just collect
```

Revisar el resultado sin exponer credenciales:

```bash
jq '{ok, stale, primary, errors, codex: .codex.source, claude: .claude.source}' \
  ~/.cache/ai-usage-status/status.json
```

Comprobar el timer y su log:

```bash
systemctl --user status ai-usage-collector.timer
systemctl --user status ai-usage-collector.service
journalctl --user -u ai-usage-collector.service -n 100 --no-pager
```

Diagnóstico general:

```bash
just doctor
```

Los errores detallados del colector están en
`~/.cache/ai-usage-status/errors.log`. El popup permite abrirlos y limpiarlos.

## Configuración

La configuración se crea en:

```text
~/.config/ai-usage-status/config.json
```

La plantilla completa está en
[`templates/config.example.json`](templates/config.example.json). Las opciones
más importantes son:

```json
{
  "providers": {
    "codex": {
      "enabled": true,
      "source": "auto",
      "cli_path": null
    },
    "claude": {
      "enabled": true,
      "source": "auto",
      "oauth_credentials_file": "~/.claude/.credentials.json"
    }
  }
}
```

Fuentes válidas:

| Proveedor | Valores | Orden de `auto` |
|---|---|---|
| Codex | `auto`, `cli`, `web` | app-server → web |
| Claude | `auto`, `oauth`, `web` | OAuth → web |

`cli_path` permite fijar un binario Codex concreto. `headless`, `wait_ms` y
`debug_text` solo afectan al fallback web.

## Arquitectura

```text
codex app-server ─┐
                  ├─ ai-usage-collect ── status.json ── plasmoide QML
Claude OAuth ─────┤          ▲
                  │          └─ systemd --user timer
Playwright web ───┘  (fallback)
```

El plasmoide no recibe tokens, no abre las bases de cookies y no hace llamadas
de red. Su responsabilidad es pequeña: leer el snapshot mediante el Data
Engine `executable` de KDE, formatearlo y lanzar acciones explícitas. Esta
separación también evita bloquear `plasmashell`; no requiere habilitar lecturas
`file://` globalmente en Qt.

Estructura del repositorio:

```text
package/                 plasmoide Plasma 6 (QML/JS/SVG)
scripts/                 colector, auth, doctor y tests
scripts/lib/             fuentes estructuradas, fallback y parsers
systemd/                 servicio y timer de usuario
templates/               configuración de ejemplo
docs/                    decisiones específicas de KDE
```

## Desarrollo

Validar todo:

```bash
just check
```

Previsualizar como widget de panel, siguiendo la guía de pruebas de KDE:

```bash
just run
```

Previsualizar la representación expandida:

```bash
just run-popup
```

Generar datos falsos:

```bash
just fake-status
```

Instalar solo la capa QML después de editarla:

```bash
just install-user
```

Para ver mensajes QML:

```bash
QT_LOGGING_RULES="qml.debug=true" \
  plasmoidviewer -a package -l topedge -f horizontal
```

Referencias oficiales de KDE:

- [Tutorial de widgets Plasma](https://develop.kde.org/docs/plasma/widget/)
- [Portar plasmoides a KF6/Plasma 6](https://develop.kde.org/docs/plasma/widget/porting_kf6/)
- [Pruebas con plasmoidviewer](https://develop.kde.org/docs/plasma/widget/testing/)

La integración de Codex sigue el protocolo JSONL/JSON-RPC documentado para
[`codex app-server`](https://developers.openai.com/codex/app-server/). Como
referencia de arquitectura multi-proveedor, [CodexBar](https://github.com/steipete/CodexBar)
también prioriza OAuth/CLI y deja el navegador como fallback.

## Problemas frecuentes

**El widget aparece, pero no cambia:** ejecuta `ai-usage-collect` y revisa que
`status.json` tenga una fecha nueva. Reejecuta `./install.sh` para actualizar la
copia instalada del QML y el timer.

**Codex muestra `--`:** la cuenta puede haber dejado de exponer la ventana de 5
horas. La versión 0.2 selecciona automáticamente la ventana semanal; una copia
antigua del plasmoide no lo hace.

**`page_changed`:** falló el fallback web. Primero confirma con
`ai-usage-doctor` si la fuente estructurada correspondiente está disponible.
Activa `debug_text` solo para depurar el parser; el archivo resultante puede
contener texto privado del panel.

**`profile_busy`:** otro Chrome usa ese perfil aislado o un proceso anterior no
terminó. Cierra la ventana de autenticación y vuelve a intentar.

**El timer no existe:** vuelve a ejecutar `./install.sh` o instala las unidades
manualmente como explica [`docs/07-installation-kde.md`](docs/07-installation-kde.md).

## Privacidad

- `~/.claude/.credentials.json` y `~/.codex/auth.json` se leen únicamente por
  sus herramientas/fuentes locales; su contenido no se imprime.
- Los perfiles web contienen cookies sensibles y quedan con directorios `0700`.
- Los snapshots, locks y logs se crean con permisos restrictivos.
- No borres perfiles ni credenciales desde scripts de limpieza genéricos.
- No publiques `debug-*-text.txt` ni `errors.log` sin revisarlos.

## Desinstalación

```bash
just uninstall-user
systemctl --user disable --now ai-usage-collector.timer
rm -f ~/.config/systemd/user/ai-usage-collector.{service,timer}
systemctl --user daemon-reload
rm -f ~/.local/bin/ai-usage-{auth,collect,clear-errors,doctor}
```

La configuración, el cache y los perfiles no se eliminan automáticamente para
evitar borrar sesiones. Si ya no los necesitas:

```bash
rm -rf ~/.cache/ai-usage-status ~/.config/ai-usage-status
```

## Licencia

MIT.
