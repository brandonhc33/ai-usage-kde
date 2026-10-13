# 06 — UI y decisiones de arquitectura en KDE Plasma

## Modelo Plasma 6

El paquete sigue el formato actual de KDE:

- `KPackageStructure: "Plasma/Applet"`;
- `X-Plasma-API-Minimum-Version: "6.0"`;
- `contents/ui/main.qml` como entrypoint fijo;
- imports QML sin versión;
- `PlasmoidItem` como raíz;
- `compactRepresentation` para el panel y `fullRepresentation` para el popup.

Esto coincide con la [guía de portado a
KF6](https://develop.kde.org/docs/plasma/widget/porting_kf6/). Los Data Engines
que siguen siendo necesarios viven en `org.kde.plasma.plasma5support`; en este
proyecto se usa el engine `executable` para leer los snapshots y ejecutar las
acciones explícitas del usuario.

## Límite de responsabilidades

El QML no conoce credenciales ni consulta proveedores. La edición publicada
en KDE Store incluye el colector estructurado dentro del propio KPackage:

```text
Codex CLI / Claude OAuth ── colector Node incluido
                                      │
                                      ▼
status.json ── Data Engine executable ── QML
                                           │
                                           ├─ actualizar cada 2 minutos
                                           ├─ actualizar manualmente
                                           └─ abrir URL/log
```

El colector Node es responsable de red, OAuth, procesos CLI, Playwright, locks,
fallback y escritura atómica. Mantener ese trabajo fuera de `plasmashell`
reduce el riesgo de bloquear o derribar el panel.

En KDE Store se ejecuta con `AI_USAGE_STRUCTURED_ONLY=1`: no requiere
Playwright, navegador ni systemd. La instalación completa desde el repositorio
conserva el timer de systemd y el fallback web como opciones avanzadas.

## Lectura y refresco

QML no expone una API general de filesystem. Además, Qt 6 bloquea por defecto
`XMLHttpRequest` sobre `file://` salvo que todo `plasmashell` se inicie con
`QML_XHR_ALLOW_FILE_READ=1`. `main.qml` evita esa dependencia global y usa
`Plasma5Support.DataSource` con el motor `executable`:

- `cat` para `status.json`;
- `cat` para `collector.lock`;
- `stat` para saber si `errors.log` tiene historial.

El motor mantiene esas fuentes conectadas y las actualiza cada cinco segundos.
El colector reemplaza los JSON de manera atómica, así que la UI observa el
snapshot anterior o el nuevo, nunca uno parcialmente escrito.

Un `Timer` QML ejecuta `ai-usage-collect --if-older-than <s>` cada
`refreshMinutes` (2 por defecto, 0 lo desactiva). Si `status.json` se escribió
hace menos de un intervalo, por ejemplo porque ya corrió el timer de systemd,
el colector termina sin hacer nada; así dos planificadores no duplican el
trabajo. **Actualizar ahora** y **Reintentar** usan `--force`, que además
ignora la pausa del fallback web tras fallos repetidos. El lock del colector
sigue evitando ejecuciones simultáneas.

`status.json` solo se vuelve a interpretar cuando su contenido cambia. Las
cuentas regresivas ("3h56", "hace 2 min") dependen de un único reloj de 30 s
(`nowMs`) que `format.js` recibe como parámetro.

Un backend C++ con `QFileSystemWatcher` sería razonable si el widget creciera o
necesitara eventos instantáneos. Para tres archivos pequeños actualizados cada
dos minutos, implicaría toolchain, CMake y un plugin binario sin una mejora
operativa proporcional.

## Representación compacta

Muestra un icono y una o dos líneas de texto por proveedor. Lo que aparece se
elige en **Configurar AI Usage… > Panel** (`contents/config/main.xml` +
`ui/ConfigPanel.qml`):

| Opción | Valores |
|---|---|
| Mostrar en el panel | % usado (por defecto) · % restante · reinicio de sesión · % + reinicio · personalizado |
| Mostrar reinicio como | tiempo restante (`3h56`, por defecto) · hora local del reinicio (`17:24`) · ambos (`3h56 · 17:24`); aplica a los formatos con reinicio |
| Semanal | agregar `S 51%` y/o el día del reinicio (`mié 09:50`), opcionalmente en una segunda línea |
| Créditos | agregar el crédito disponible (`$4.71`) |
| Sesión sin iniciar | atenuada, o reemplazada por el semanal |
| Proveedores | Codex y/o Claude |
| Actualizar cada | minutos; 0 = solo el timer de systemd |

La plantilla personalizada acepta `{used}`, `{left}`, `{reset_in}`,
`{reset_at}`, `{w_used}`, `{w_left}`, `{w_reset_in}`, `{w_reset_day}` y
`{money}`; `\n` inicia una segunda línea. `format.js::panelEntries()` convierte
la plantilla en segmentos `{ text, severity }`, de modo que cada valor se
colorea según su propia ventana.

La ventana corta es 5 horas en Codex y la sesión en Claude. Si Codex solo
expone el límite semanal, se muestra ese valor con el prefijo `S`. Una ventana
sin iniciar (sin uso ni hora de reinicio) se muestra en gris. Un sufijo `!`
indica que el snapshot está marcado como stale o tiene más de 15 minutos;
Claude con el token de Claude Code vencido se muestra en gris, sin `!`, porque
es un estado conocido y no un error. En paneles verticales cada parte va en su
propia línea.

El tooltip lista todas las ventanas con su reinicio, los créditos y los avisos,
para no tener que abrir el popup.

Los valores del panel usan `SeverityText.qml`. Temas de panel como Panel
Colorizer asignan `color` directamente a cada `Text` de los widgets (por
ejemplo al abrir el popup), lo que borra el binding y deja todo en el color del
tema; `SeverityText` restaura el color de severidad cuando eso ocurre.

## Popup

El popup muestra únicamente métricas realmente disponibles. Cada proveedor
usa `ProviderCard.qml`: plan, fuente (CLI, OAuth o web) y antigüedad del dato,
más un aviso cuando el token de Claude Code venció. Los créditos aparecen al
final de la card de su proveedor: Claude muestra el saldo disponible y el
límite de gasto mensual (un tope, no dinero) con lo gastado contra él; Codex
muestra sus créditos y reinicios gratis de límites. No deja una fila
de “5 horas --” cuando la cuenta Codex solo tiene límite semanal, ni una fila de
rutinas vacía cuando Claude no entrega esa cuota.

Las cuotas de Codex y Claude, los créditos de uso, los avisos y las acciones se
agrupan en cards nativas de Kirigami. Los porcentajes semánticos se dibujan con
texto de color explícito para que la paleta activa del panel no los reemplace al
abrir el popup, y cada cuota incluye una barra de progreso para facilitar el
escaneo. Un error ofrece **Reintentar** como acción principal; **Descartar
aviso** solamente oculta el estado de error y no se presenta como una reparación.

Los colores de severidad están centralizados en
`package/contents/code/format.js`:

| Severidad | Umbral por defecto | Color |
|---|---:|---|
| Normal | 0–50 % | `#2ec059` |
| Advertencia | 51–75 % | `#f29c12` |
| Crítico | 76–100 % | `#e62e38` |
| Sin datos | — | `#8c9199` |
| Login | — | `#5c8aed` |

## Por qué no KSystemStats

KSystemStats y los sensores de Plasma son excelentes para CPU, memoria,
temperaturas y contadores locales. Los límites de Codex/Claude son estado de
cuenta remoto, con OAuth, ventanas de reset y autenticación. Convertirlos en un
sensor personalizado requeriría igualmente un proveedor/daemon propio y no
eliminaría el colector. Un plasmoide con snapshot local es una integración más
pequeña y fácil de distribuir para este caso.

## Pruebas visuales

La documentación de KDE recomienda `plasmoidviewer` para cargar un paquete sin
instalarlo. Este proyecto incluye:

```bash
just run        # panel horizontal
just run-popup  # representación planar/expandida
```

`qmllint` valida ambas fuentes QML dentro de `just check`.
