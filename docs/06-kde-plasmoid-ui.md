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

Un `Timer` QML solicita una nueva lectura cada dos minutos. El lock del
colector evita carreras si existen varias instancias del widget o también está
habilitado el timer opcional de systemd.

Un backend C++ con `QFileSystemWatcher` sería razonable si el widget creciera o
necesitara eventos instantáneos. Para tres archivos pequeños actualizados cada
dos minutos, implicaría toolchain, CMake y un plugin binario sin una mejora
operativa proporcional.

## Representación compacta

Muestra un par icono + porcentaje por proveedor. Codex puede exponer:

- 5 horas y semanal: se prefiere 5 horas;
- solo semanal: se muestra semanal;
- ninguna ventana: se muestra `--`.

Claude prefiere la sesión y cae a semanal si fuera necesario. Un sufijo `!`
indica que el snapshot está marcado como stale o tiene más de 15 minutos.

## Popup

El popup muestra únicamente métricas realmente disponibles. No deja una fila
de “5 horas --” cuando la cuenta Codex solo tiene límite semanal, ni una fila de
rutinas vacía cuando Claude no entrega esa cuota.

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
