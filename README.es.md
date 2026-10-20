# AI Usage para KDE Plasma 6

**Español** | [English](README.md)

AI Usage es un widget de panel de solo lectura que monitorea los límites de
uso de Codex, Claude y Google Antigravity. No envía prompts, no consume créditos ni realiza
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

Codex también se detecta cuando viene incluido en Codex Desktop o en el agente
externo de Zed, aunque esas aplicaciones no hayan publicado `codex` en `PATH`.

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
kpackagetool6 --type Plasma/Applet --install ai-usage-kde-0.5.3.plasmoid
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
Si Chrome se cierra al iniciarse dentro de Xvfb, el colector reintenta en modo
headless y recuerda esa selección para la versión instalada del navegador. Al
actualizar Chrome se vuelve a comprobar automáticamente el modo preferido.

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

Claude Code solo renueva su token OAuth mientras se usa. Cuando está vencido
(normalmente antes del primer uso de Claude Code en el día), la opción por
defecto `"on_oauth_expired": "keep_last"` conserva los últimos datos de Claude,
en gris y con un aviso, en vez de leer claude.ai con el navegador. Usa `"web"`
para volver al fallback web.

### Cuentas y sesiones

Abre el widget y selecciona **Añadir cuenta**. Elige Codex o Claude, asigna
un nombre (por ejemplo, «Personal» o «Trabajo») y selecciona cómo conectarla:

- **Iniciar otra sesión:** abre Konsole y el inicio de sesión oficial de la CLI.
  Elige la cuenta correspondiente en el navegador. Requiere Codex CLI o Claude
  Code y Konsole (también admite `x-terminal-emulator` o `xterm`).
- **Importar la sesión actual de la CLI:** guarda una copia de las credenciales
  locales actuales. La sesión debe estar guardada en archivos; si Codex usa
  exclusivamente el llavero, utiliza el inicio de sesión nuevo.

Puedes añadir varias cuentas del mismo proveedor. Cada una tiene su propio
nombre, credenciales y datos de uso en `~/.config/ai-usage-status/accounts/`.
El menú **⋮** de cada tarjeta permite cambiar el nombre, volver a iniciar
sesión, **Cerrar sesión** o eliminar la cuenta del widget. Cerrar sesión borra
las credenciales guardadas por el widget y sus datos en caché; conserva la
tarjeta para poder reconectarla. Eliminar también quita la tarjeta.

Las cuentas de la configuración anterior siguen apareciendo automáticamente
como «Principal». Desconectarlas del widget no borra las sesiones de otras
aplicaciones. Las cuentas añadidas desde el widget usan un directorio propio
mediante `CODEX_HOME` o `CLAUDE_CONFIG_DIR`. Las credenciales de Claude pueden
expirar: usa **Iniciar sesión** en la tarjeta para renovarlas.

Usa la **chincheta** de cada tarjeta para elegir qué cuentas aparecen en la
barra. La selección se guarda por instancia del widget. **Al abrir el
widget siempre aparecen todas**, incluidas las que hayas ocultado o
desconectado. Si ocultas todas, queda el icono de AI Usage para abrirlo.

También puedes administrar las cuentas desde la instalación completa:

```bash
ai-usage-accounts list
ai-usage-accounts add claude Trabajo --login
ai-usage-accounts add codex Personal --import
ai-usage-accounts rename ID 'Trabajo'
ai-usage-accounts logout ID
ai-usage-accounts login ID --terminal
ai-usage-accounts remove ID
```

La configuración mantiene la compatibilidad con `providers`. Al administrar
cuentas se guarda una lista `accounts` con identificadores estables. Una lista
vacía indica que eliminaste todas las cuentas; no vuelve a detectarlas.

### Distribución y tamaño de la ventana

El desplegable agrupa las cuentas en columnas por agente. En modo automático,
el ancho depende de las columnas y el alto se ajusta al contenido. Si un agente
tiene muchas cuentas, continúa en otra columna. La ventana se limita al tamaño
de la pantalla y solo muestra desplazamiento cuando el contenido no cabe.

Abre **Diseño y tamaño** (icono de ajustes junto a actualizar) para elegir:

- Columnas automáticas o un máximo de 1 a 6.
- Filas automáticas o de 1 a 8 cuentas por columna.
- Ancho y alto automáticos, configurables de manera independiente.
- Ancho y alto manuales en píxeles.

Los mismos controles están en clic derecho > **Configurar AI Usage…** >
**Ventana**. Los cambios se guardan por instancia del widget.

Los colores del texto y del consumo se adaptan al fondo claro u oscuro. Los
porcentajes, los créditos y los textos informativos mantienen suficiente
contraste sin recurrir a transparencia; las barras tienen un contorno visible.

### Google Antigravity

Selecciona **Añadir cuenta** > **Google Antigravity**. Abre primero Antigravity
(la aplicación o el IDE), inicia sesión con Google y deja la aplicación abierta
para actualizar el consumo. El widget consulta únicamente el servicio local de
cuotas: no envía prompts ni copia tokens OAuth de Google. El token CSRF local
se mantiene en memoria y nunca se escribe en la configuración ni en el estado.

La cuenta se vincula a su identidad de Google. Si hay varias sesiones locales,
puedes escribir el correo para seleccionar la correcta. Cambiar de cuenta en
Antigravity no cambia la identidad de otra tarjeta; sus últimos datos se
conservan temporalmente y se avisa de la diferencia. **Desconectar del widget**
retira sus datos del widget y conserva el inicio de sesión de Antigravity.

Se muestran cuotas de sesión y semanales cuando el servicio las proporciona.
En versiones del IDE que solo informan cuotas por modelo, se muestran esos
límites sin inventar su duración. Los valores no informados aparecen como `--`.
El panel usa el mayor porcentaje de consumo conocido.

Esta integración es experimental porque la API local de Antigravity es interna.
No es una integración con Gemini CLI ni con la facturación de Gemini API.
Referencias: [planes de Google Antigravity](https://antigravity.google/docs/plans)
y [protocolo local documentado por CodexBar](https://github.com/steipete/CodexBar/blob/main/docs/antigravity.md).

```bash
ai-usage-accounts add antigravity Google --local
ai-usage-accounts add antigravity Trabajo --local --email nombre@example.com
```

### Opciones del widget

Clic derecho en el widget > **Configurar AI Usage…** > **Panel** para elegir
qué se ve en el panel: % usado o restante, reinicio de sesión, % semanal y
día del reinicio (opcionalmente en una segunda línea), crédito disponible o una
plantilla personalizada. También puedes mostrar los nombres cuando hay varias
cuentas del mismo proveedor. El tooltip siempre muestra todas las ventanas,
reinicios y créditos.

En los formatos con reinicio, **Mostrar reinicio como** permite elegir tiempo
restante (`3h56`), hora local (`17:24`) o ambos (`3h56 · 17:24`).

**Texto de la barra > Usar negrita** permite activar o desactivar la negrita
de nombres, porcentajes y reinicios. Viene activada por defecto.

El correo de la sesión aparece debajo del nombre de cada cuenta cuando está
disponible. Pasa el cursor sobre él para verlo completo si queda abreviado.
También aparece en el tooltip de la barra.

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
archivo contiene `metadata.json` en la raíz e incluye el colector
estructurado y el administrador de cuentas; no incluye Playwright ni `node_modules`.

Errores y sugerencias: <https://github.com/brandonhc33/ai-usage-kde/issues>
