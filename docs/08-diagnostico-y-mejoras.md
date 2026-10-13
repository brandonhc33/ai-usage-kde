# 08 — Diagnóstico de errores y plan de mejoras

Revisión del 2026-10-09 sobre el árbol de trabajo actual (versión 0.3.0, con
los cambios sin commitear de Xvfb/headless). Este documento cubre:

1. por qué `errors.log` se llena de `page_changed` / `login_required` en Claude;
2. el caso de la ventana de sesión "en 0 %" hasta el primer uso;
3. cómo mostrar los créditos (dinero) disponibles de cada proveedor;
4. un selector en la configuración del widget para elegir qué valores se ven
   en el panel (porcentaje usado/restante, horas restantes, reset y % semanal);
5. el resto de mejoras detectadas en el proyecto, priorizadas por fases.

Los payloads citados se obtuvieron el mismo día con las dos fuentes
estructuradas que ya usa el colector (`codex app-server` →
`account/rateLimits/read` y `GET https://api.anthropic.com/api/oauth/usage`).
Ninguno de los dos endpoints está documentado públicamente; los campos pueden
cambiar sin aviso.

> **Estado:** las fases 1, 2 y 3 (§7) quedaron implementadas el mismo
> 2026-10-09. La sección 8 resume qué cambió y en qué se apartó del plan.

---

## 1. Diagnóstico de `errors.log`

### Qué dice el log

Entre `errors.log` y `errors.log.1` hay 615 entradas:

| Fecha | Proveedor | Código | Cantidad |
|---|---|---|---:|
| 2026-10-05 | claude | `page_changed` | 396 |
| 2026-10-06 | claude | `page_changed` | 72 |
| 2026-10-07 | claude / codex | `page_changed` | 26 / 1 |
| 2026-10-08 | claude / codex | `page_changed` | 77 / 2 |
| 2026-10-09 | claude | `login_required` | 41 |

Todas tienen `phase: "scrape"`: el error ocurre en el **fallback web**
(Playwright + Chrome), nunca en la fuente OAuth.

### Causa raíz: el token OAuth de Claude expira

El log no lo muestra, pero el journal de systemd sí:

```text
ai-usage-collect[…]: claude: oauth no disponible (oauth_expired); usando fallback web.
```

La secuencia es:

1. `fetchClaudeOAuth()` lee `~/.claude/.credentials.json`. Ese token lo
   administra **Claude Code** y tiene vida corta (en esta máquina, unas 8 h
   entre renovación y `expiresAt`).
2. Claude Code solo lo renueva cuando se usa. Si todavía no abriste Claude
   Code en el día (el "antes del primer commit" que describes), el token está
   vencido y `fetchClaudeOAuth()` lanza `oauth_expired`
   (`scripts/lib/structured-sources.mjs:297`).
3. Con `source: "auto"`, `collectProvider()` cae al scraping web
   (`scripts/ai-usage-collect.mjs:317`).
4. El scraping falla: del 5 al 8 de octubre la página no contenía los
   porcentajes que espera `parseClaude()` (`page_changed`,
   `scripts/lib/web-parsers.mjs:192`); desde el 9, el perfil de Chrome ya no
   tiene sesión en claude.ai (`login_required`).
5. Pasados `last_good_valid_minutes` (30 min) se descarta el último dato
   bueno y el widget muestra Claude sin datos o con valores viejos.

Prueba directa: hoy el último error es de las 16:06:15 UTC y el token actual
expira a las 00:06:48 UTC del día siguiente; es decir, los errores se
detuvieron exactamente cuando Claude Code se abrió y renovó el token.

### Factores que lo agravan

- **El log no guarda la causa raíz.** El motivo `oauth_expired` solo va a
  `console.warn` (journal). `errors.log` registra únicamente el síntoma del
  fallback, por eso parecía un problema de layout.
- **Se registra lo mismo cada 2 minutos.** No hay deduplicación ni backoff:
  cada corrida lanza Chrome, falla igual y agrega otra entrada con stack.
- **Dos planificadores en paralelo.** El timer de systemd
  (`OnUnitInactiveSec=2min`) y el `Timer` QML de `main.qml:219` disparan el
  colector cada uno por su cuenta. El lock evita que se solapen, pero no que
  se ejecute el doble de veces (se ve en los timestamps del log: dos series
  intercaladas).
- **Detección de login por texto.** `/iniciar sesión|log in|sign in|sign
  up/i` sobre todo el `innerText` puede dar falsos positivos (un footer, un
  botón "Sign up for Max") y falsos negativos.

### Caso "sesión en 0 %" hasta el primer mensaje

Cuando la ventana de 5 h de Claude no ha comenzado, OAuth devuelve
`five_hour.utilization: 0` y `resets_at: null`. El colector lo convierte en
`{ used_percent: 0, remaining_percent: 100, reset_label: null }` y el widget
muestra "0 % usado · 100 % restante" sin línea de reset (es lo que se ve en
la captura). Técnicamente es correcto, pero no distingue "no has empezado" de
"empezaste y no gastaste nada", y en el panel aparece un `0%` que no informa
nada.

---

## 2. Solución para token vencido y ventana no iniciada

### 2.1 Tratar `oauth_expired` como estado conocido, no como fallo

Nueva opción por proveedor en `config.json`:

```json
"claude": {
  "on_oauth_expired": "keep_last"
}
```

| Valor | Comportamiento |
|---|---|
| `keep_last` (por defecto) | No lanza Chrome. Conserva el último snapshot bueno sin límite de 30 min, marcado con `token_state: "expired"` y `stale_reason: "oauth_expired"`. |
| `web` | Comportamiento actual: intenta el scraping. |

Con `keep_last` el widget muestra Claude en gris neutro con un aviso
informativo, no de error:

```text
Claude · datos de las 09:12 — abre Claude Code para actualizar
```

Mientras no uses Claude Code el consumo **puede** seguir cambiando si usas
claude.ai en el navegador (comparten límites), por eso el dato se marca como
desactualizado en vez de presentarse como vigente.

**Renovar el token desde el colector no es recomendable.** Sería posible usar
el `refreshToken` de `.credentials.json`, pero si el servidor rota el refresh
token, el colector invalidaría la sesión de Claude Code o competiría con él al
escribir el archivo. Si algún día se implementa, debe ser opt-in, con lock,
relectura antes de escribir, escritura atómica y conservando el resto de
campos del JSON.

### 2.2 Registrar la causa raíz y deduplicar

- Cuando haya fallback, guardar el motivo original en la entrada:
  `{"phase":"scrape","fallback_from":{"source":"oauth","code":"oauth_expired"}}`.
- Registrar solo **cambios de estado** por proveedor: si el código es igual al
  de la entrada anterior, incrementar un contador en
  `~/.cache/ai-usage-status/provider-state.json` en vez de agregar otra línea
  con stack. El log pasaría de cientos de líneas por día a una por incidente.
- Backoff para el fallback web: tras 3 fallos consecutivos con el mismo código,
  esperar 4, 8, 16… hasta 30 min antes de volver a lanzar Chrome. Una
  corrida manual ("Actualizar ahora") ignora el backoff.

### 2.3 Ventana no iniciada (`idle`)

En `metric()` / `mapClaudeOAuthUsage()` (y en el equivalente de Codex):

```js
// Sin reset y sin consumo: la ventana todavía no empezó.
const idle = used === 0 && resetEpoch === null;
return { used_percent: used, remaining_percent: 100, reset_epoch: null,
         reset_label: null, state: idle ? 'idle' : 'active' };
```

UI propuesta:

- Popup: `Sesión — sin iniciar · empieza con tu primer mensaje (dura 5 h)`.
- Panel: la ventana `idle` se muestra atenuada (`—` o `0%` en gris, según
  preferencia) o se reemplaza por la semanal si el usuario lo configura
  (ver §4).

El array `limits[]` de la respuesta trae un campo `is_active`, pero en la
muestra la sesión con 6 % de uso tenía `is_active: false`; su significado no
es "ventana iniciada", así que no conviene usarlo para esto.

### 2.4 Endurecer el fallback web

- Detectar login por URL (`page.url()` redirigido a `/login`) o por un
  selector concreto, no por texto libre.
- Con `page_changed`, guardar automáticamente el último texto en
  `debug-<proveedor>-text.txt` (modo `0600`, un solo archivo, se sobrescribe)
  para poder agregar un fixture al test sin activar `debug_text` a mano. Ojo:
  el texto puede incluir nombre o correo de la cuenta.
- `parseClaude()` debería devolver un resultado parcial (solo semanal) cuando
  la sesión aparece como no iniciada, en vez de lanzar `page_changed`.

---

## 3. Créditos (dinero) disponibles

### 3.1 Qué entregan hoy las fuentes estructuradas

**Claude** (`/api/oauth/usage`, plan Pro con créditos de uso activados):

```json
"extra_usage": {
  "is_enabled": true, "monthly_limit": 10000, "used_credits": 29,
  "utilization": 0.29, "currency": "USD", "decimal_places": 2,
  "spend_limit_reached": false, "disabled_reason": null
},
"spend": {
  "used":  { "amount_minor": 29,    "currency": "USD", "exponent": 2 },
  "limit": { "amount_minor": 10000, "currency": "USD", "exponent": 2 },
  "balance": null, "auto_reload": null, "can_purchase_credits": false
},
"seven_day_breakdown": {
  "rows": [ { "key": "claude_code", "percent": 100 }, { "key": "chat", "percent": 0 }, … ]
},
"five_hour": { "utilization": 6, "limit_dollars": null, "remaining_dollars": null, … }
```

Ojo: `monthly_limit` / `spend.limit` (USD 100) es el **límite de gasto
mensual**, un tope configurable, no dinero. El saldo de créditos comprados
(USD 4.71 en esta cuenta) **no** viene en `/usage` (`spend.balance` es `null`).
Claude Code lo lee con un GET aparte, que el colector replica:

```json
// GET https://api.anthropic.com/api/oauth/organizations/<org>/prepaid/credits
{ "amount": 471, "currency": "USD",
  "balance": { "money": null, "credits": { "amount_minor": 471, "exponent": 2 } },
  "auto_reload_settings": null, "tranches": [ … ] }
```

`<org>` es `oauthAccount.organizationUuid` de `~/.claude.json`. El POST a
`…/contracts/prepaid/credits` **compra** créditos: el colector nunca lo usa.

**Codex** (`account/rateLimits/read`, plan Plus):

```json
"credits": { "hasCredits": false, "unlimited": false, "balance": "0" },
"spendControlReached": false,
"rateLimitReachedType": null,
"rateLimitResetCredits": {
  "availableCount": 3,
  "credits": [ { "title": "Full reset (Weekly + 5 hr)", "status": "available",
                 "expiresAt": 1792692811 }, … ]
}
```

### 3.2 Qué se pierde actualmente

| Dato | Estado actual | Problema |
|---|---|---|
| Claude: saldo de créditos | No se consulta | La card dice "USD 100.00 límite mensual", que es un tope, y no muestra el saldo real (USD 4.71). |
| Claude: % gastado | `Math.round(0.29)` → "0 % usado" | Valores pequeños se redondean a 0. |
| Claude: recarga automática | Ignorada | Viene en `prepaid/credits` (`auto_reload_settings`). |
| Claude: moneda/decimales | `/ 100` y "USD" fijos | Falla con otra moneda o exponente. |
| Claude: `spend_limit_reached` | Ignorado | No hay aviso cuando se agotan los créditos. |
| Claude: `seven_day_breakdown` | Ignorado | Útil para ver cuánto del semanal es Claude Code vs chat. |
| Codex: `credits.balance` | `null` si `hasCredits` es `false` | La fila "Créditos" desaparece; no se ve "0". |
| Codex: reinicios gratis | Se guarda `reset_credits_available: 3`, **la UI no lo muestra** | Tienes 3 "Full reset (Weekly + 5 hr)" con vencimiento, invisibles. |
| Codex: `spendControlReached`, `rateLimitReachedType` | Ignorados | No hay aviso de límite alcanzado. |

### 3.3 Esquema propuesto (`schema_version: 2`)

Un bloque `billing` común a ambos proveedores, con montos ya escalados:

```json
"billing": {
  "currency": "USD",
  "balance": 4.71,
  "available": 4.71,
  "spent": 0.29,
  "limit": 100.0,
  "limit_remaining": 99.71,
  "percent": 0.29,
  "period": "monthly",
  "limit_reached": false,
  "auto_reload": false
}
```

- `balance`: créditos comprados/otorgados.
- `limit`, `spent`, `limit_remaining`, `percent`: el límite de gasto mensual y
  lo gastado contra él. Nunca se presentan como dinero disponible.
- `available`: lo que realmente se puede gastar, `min(balance,
  limit_remaining)`; `null` si no se conoce el saldo.

Y para Codex, además:

```json
"credits": { "balance": 0, "has_credits": false, "unlimited": false },
"reset_credits": {
  "available": 3,
  "title": "Full reset (Weekly + 5 hr)",
  "next_expiry_epoch": 1792692811
}
```

Notas:

- Los "créditos" de Codex no son dólares; mostrarlos como "créditos", no USD.
- Escalar con `amount_minor / 10 ** exponent` y tomar la moneda del payload.
- Mantener `credits_remaining`, `credits.spent_usd` y `credits.limit_usd`
  durante una versión para que un widget viejo siga funcionando con un
  colector nuevo, y viceversa.
- Formatear porcentajes pequeños con un decimal: `< 10` → `0.3 %`.

### 3.4 Presentación

Card "Créditos" con una fila por proveedor:

```text
Créditos
  Claude   USD 4.71 disponibles
           Límite de gasto mensual: USD 0.29 de USD 100.00 (0.3%)
  Codex    0 créditos · 3 reinicios completos (el primero vence el 22-10)
```

Opcionalmente, un segmento en el panel (`$4.71`), ver §4.

---

## 4. Selector de formato en la configuración del widget

Hoy el paquete no tiene `contents/config/`, así que "Configurar AI Usage…" no
ofrece opciones y el panel siempre muestra `icono + % usado` de la ventana
corta.

### 4.1 Archivos nuevos

```text
package/contents/config/main.xml      # esquema KConfigXT (claves y defaults)
package/contents/config/config.qml    # categorías del diálogo de configuración
package/contents/ui/ConfigPanel.qml   # formulario (Kirigami.FormLayout)
```

`config.qml`:

```qml
import QtQuick
import org.kde.plasma.configuration

ConfigModel {
    ConfigCategory {
        name: "Panel"
        icon: "preferences-desktop-display"
        source: "ConfigPanel.qml"
    }
}
```

`main.xml` (extracto):

```xml
<kcfg xmlns="http://www.kde.org/standards/kcfg/1.0">
  <kcfgfile name=""/>
  <group name="General">
    <entry name="panelPreset" type="String"><default>used</default></entry>
    <entry name="panelTemplate" type="String"><default>{used}</default></entry>
    <entry name="showWeekly" type="Bool"><default>false</default></entry>
    <entry name="showWeeklyReset" type="Bool"><default>false</default></entry>
    <entry name="idleWindow" type="String"><default>dim</default></entry>
    <entry name="showCodex" type="Bool"><default>true</default></entry>
    <entry name="showClaude" type="Bool"><default>true</default></entry>
    <entry name="twoLines" type="Bool"><default>false</default></entry>
    <entry name="refreshMinutes" type="Int"><default>2</default></entry>
  </group>
</kcfg>
```

En `ConfigPanel.qml` cada clave se enlaza con una propiedad `cfg_<clave>`
(por ejemplo `property string cfg_panelPreset`) y en `main.qml` se lee con
`Plasmoid.configuration.panelPreset`.

### 4.2 Opciones

| Opción | Valores |
|---|---|
| **Formato del panel** | % usado · % restante · Tiempo restante · % usado + tiempo · Personalizado |
| **Mostrar también el semanal** | sí/no — agrega `S 49%` (restante) |
| **Mostrar el reset semanal** | sí/no — agrega `mié 09:50` |
| **Sesión sin iniciar** | Mostrarla atenuada · Mostrar el semanal en su lugar |
| **Proveedores visibles** | Codex / Claude |
| **Dos líneas** | pone el semanal en una segunda línea (paneles gruesos) |
| **Intervalo de actualización** | minutos; 0 = dejarlo solo al timer de systemd |

Vista previa de cada formato (Codex 3 % con reset en 3 h 56 min y semanal 51
%; Claude 6 %, semanal 10 %):

```text
% usado                 [codex] 3%            [claude] 6%
% restante              [codex] 97%           [claude] 94%
Tiempo restante         [codex] 3h56          [claude] 4h50
% usado + tiempo        [codex] 3% · 3h56     [claude] 6% · 4h50
+ semanal               [codex] 3% · S 49%    [claude] 6% · S 90%
+ semanal y reset       [codex] 3% · S 49% mié 09:50
Dos líneas              [codex] 3% · 3h56
                                S 49% · mié 09:50
```

### 4.3 Plantilla personalizada

El modo "Personalizado" usa una plantilla con tokens; los presets son
simplemente plantillas predefinidas:

| Token | Ejemplo | Significado |
|---|---|---|
| `{used}` / `{left}` | `3%` / `97%` | ventana corta |
| `{reset_in}` | `3h56` | tiempo hasta el reset de la ventana corta |
| `{reset_at}` | `17:24` | hora del reset |
| `{w_used}` / `{w_left}` | `51%` / `49%` | semanal |
| `{w_reset_in}` | `4d20h` | tiempo hasta el reset semanal |
| `{w_reset_day}` | `mié 09:50` | día y hora del reset semanal |
| `{money}` | `$4.71` | crédito disponible (saldo) |

### 4.4 Implementación

- Mover la construcción de la etiqueta a una función pura en `format.js`:
  `panelEntries(state, options, nowMs)` → por proveedor, líneas de segmentos
  `{ text, severity }`. Cada segmento se colorea con su propia severidad (el
  `S 49%` naranja aunque la ventana corta esté verde). `compactRepresentation`
  hace un `Repeater` sobre esos segmentos.
- Los contadores ("3h56") necesitan reloj: agregar
  `property double nowMs` actualizado por un `Timer` de 30 s y pasarlo a la
  función, en vez de depender de que `statusState` se reasigne cada 5 s.
- Formatear las fechas en el widget a partir de `reset_epoch` ("hoy 17:24",
  "mié 14 09:50"). Hoy el colector genera
  `reset_label` con `es-CL` fijo (`structured-sources.mjs:28`), lo que mezcla
  presentación con datos y produce textos como "09-10-26, 5:24 p. m.".
- **Tooltip completo siempre**: aunque el panel muestre poco, al pasar el
  mouse debe verse todo sin hacer clic:

  ```text
  Codex (plus) — 5 h: 3 % usado, reinicia 17:24 (3 h 56 min)
                 Semanal: 51 % usado, reinicia mié 14 09:50 (4 d 20 h)
                 3 reinicios completos disponibles
  Claude (pro) — Sesión: 6 % usado, reinicia 18:19 (4 h 50 min)
                 Semanal: 10 % usado, reinicia jue 15 01:00
                 Créditos: USD 4.71 disponibles
  ```

- En paneles verticales (`Plasmoid.formFactor === PlasmaCore.Types.Vertical`)
  cada parte va en su propia línea con fuente pequeña.

---

## 5. Mejoras del popup

- Estado `idle` para ventanas no iniciadas (§2.3).
- Card de créditos con "disponible" y porcentaje con decimal (§3.4).
- Reinicios gratis de Codex y aviso de `spend_limit_reached` /
  `spendControlReached`.
- Desglose semanal de Claude por producto (`seven_day_breakdown`): "Claude
  Code 100 % · Chats 0 %".
- En la cabecera de cada card: plan (`plus`, `pro`), fuente (`CLI`, `OAuth`,
  `web`) y antigüedad del dato por proveedor; con OAuth, "token válido hasta
  21:06".
- **Ritmo de consumo**: con un historial mínimo (ver §6) se puede estimar "a
  este ritmo el semanal se agota el sábado" o "vas por debajo del ritmo
  uniforme (51 % usado con 31 % de la semana transcurrida)". Lo segundo no
  necesita historial: basta comparar `used_percent` con la fracción de la
  ventana ya transcurrida.

---

## 6. Revisión general del proyecto

### Robustez del colector

1. **Planificador duplicado** (§1). Opciones: que el `Timer` QML invoque
   `ai-usage-collect --if-older-than 90` (el colector termina sin hacer nada
   si `status.json` es reciente) y que "Actualizar ahora" use `--force`; o
   desactivar el timer QML cuando `refreshMinutes` sea 0 y exista el de
   systemd.
2. **Backoff y deduplicación de errores** (§2.2).
3. **Endpoint OAuth no documentado**: `User-Agent: claude-code/2.1.0` y el
   header beta están fijos. Agregar un fixture sanitizado del payload real a
   los tests y, si desaparecieran `five_hour` / `seven_day`, usar `limits[]`
   (que trae `kind`, `percent`, `resets_at` y `severity`) como respaldo.
4. **Lógica del colector no testeable**: `mergeProviderResult`,
   `buildPrimary`, `lastGoodSnapshot` y compañía viven dentro del CLI. Moverlas
   a `scripts/lib/merge.mjs` permite testear los casos de fallback y
   snapshots viejos.
5. `buildPrimary()` / `config.primary` se calculan pero el widget no los usa
   (`format.js` elige la métrica por su cuenta). La nueva configuración del
   panel (§4) los reemplaza; conviene eliminarlos o usarlos de verdad.
6. `ai-usage-clear-errors` **borra** `errors.log`; mejor rotarlo o escribir
   una marca, para no perder historial al descartar un aviso.

### Widget (QML)

7. `main.qml` tiene 724 líneas y las cards de Codex y Claude están
   duplicadas. Extraer `ProviderCard.qml` y `CreditsCard.qml`, y definir
   `readonly property var codex: statusState.kind === "loaded" ?
   statusState.data.codex : null` para eliminar las decenas de guardas
   `root.statusState.kind === "loaded" && root.statusState.data.codex`.
8. Cada 5 s se lanzan 3 procesos (`cat`, `cat`, `stat`): 36 procesos por
   minuto con el widget cerrado. Un solo comando que devuelva los tres datos,
   o leer `status.json` solo cuando cambie su `mtime`, reduce eso a uno.
9. `statusState` se reasigna en cada lectura aunque el contenido sea igual,
   lo que reevalúa todos los bindings. Comparar el texto crudo antes de
   reasignar.
10. Textos fijos en español: usar `i18n()` y un dominio de traducción
    (`X-KDE-Translation-Domain`) para publicar también en inglés en KDE Store.

### Pruebas y desarrollo

11. `format.js` no tiene tests. Se puede cargar desde Node con `vm`
    (quitando `.pragma library`) y probar `panelSegments`, `percent`,
    `durationBreakdown`, créditos, etc.
12. `just fake-status` **sobrescribe el `status.json` real**. Mejor tener
    escenarios en `scripts/fixtures/` (`idle`, `oauth-expired`, `credits`,
    `errors`, `codex-weekly-only`) y que el comando respalde el archivo real.
13. Versión `0.3.0` repetida en `metadata.json`, `package.json` y el
    `clientInfo` de `structured-sources.mjs`; leerla de un solo lugar.
14. `ai-usage-doctor`: agregar tiempo restante del token de Claude, si están
    activos a la vez el timer de systemd y el del widget, y el último error por
    proveedor con su contador.

### Funcionalidad nueva (opcional)

15. **Notificaciones** (`notify-send` desde el colector o
    `org.kde.notification` en QML) al cruzar 75 % / 90 %, al reiniciarse una
    ventana o cuando un reinicio gratis de Codex está por vencer.
16. **Historial**: `history.jsonl` con un punto por corrida (rotado a 7 días)
    para un sparkline en el popup y la proyección de §5.

---

## 7. Plan por fases

| Fase | Contenido | Archivos principales | Estado |
|---|---|---|---|
| **1. Ruido y errores** | `on_oauth_expired: keep_last`, causa raíz en el log, deduplicación, backoff, `--if-older-than`, estado `idle`, login por URL | `ai-usage-collect.mjs`, `structured-sources.mjs`, `web-parsers.mjs`, `main.qml`, tests | Hecha |
| **2. Datos de créditos** | `billing` v2, créditos y reinicios de Codex, desglose semanal, moneda/exponente, compatibilidad con v1 | `structured-sources.mjs`, `format.js`, créditos en cada card de proveedor, fixtures | Hecha |
| **3. Configuración del panel** | `config/main.xml`, `config.qml`, `ConfigPanel.qml`, `panelEntries()`, reloj de 30 s, tooltip completo, formato de fechas en el widget | `package/contents/config/*`, `format.js`, `main.qml` | Hecha |
| **4. Calidad** | Extraer componentes QML, lecturas más baratas, `i18n()`, tests de `format.js`, `lib/merge.mjs`, fixtures de `fake-status`, doctor | `package/contents/ui/*`, `scripts/lib/*`, `justfile` | Parcial |
| **5. Extras** | Notificaciones, historial, proyección de ritmo | colector + popup | Pendiente |

Las fases 1 y 2 no cambian la interfaz de configuración y se pueden publicar
juntas. Para validar la fase 3, revisar el panel con `just run` y una captura
real (`spectacle -b -n -o /tmp/x.png`), no solo el log de `plasmoidviewer`:
los errores de carga de QML se ven en la ventana, no en la salida estándar.

---

## 8. Estado de implementación (2026-10-09)

### Colector

- `on_oauth_expired: "keep_last"` (por defecto) conserva el último snapshot de
  Claude con `stale: true` y `stale_reason: "oauth_expired"`, sin abrir Chrome.
  Las ventanas cuyo reset ya pasó se muestran como `idle` (también al reusar
  datos dentro de `last_good_valid_minutes`). Si no hay datos previos, se
  reporta el error `oauth_expired`.
- `scripts/lib/provider-state.mjs` + `~/.cache/ai-usage-status/provider-state.json`:
  una línea en `errors.log` por incidente, contador de repeticiones y backoff
  del fallback web (3 fallos → 4, 8, 16 y luego 30 min). `ai-usage-clear-errors`
  borra también este archivo.
- Las entradas del fallback web guardan `fallback_from` con la causa original.
- Login detectado por URL o por texto solo si la página no muestra uso; el texto
  de una página que no se pudo parsear queda en `debug-<proveedor>-text.txt`.
- `--force` (botones del popup) y `--if-older-than <s>` (timer del widget).
- `schema_version: 2`: `state` en cada ventana, `billing`, `weekly_breakdown`,
  `token_expires_at` (Claude); `credits`, `reset_credits`, `limit_reached`
  (Codex). Los campos v1 se mantienen, así que un widget viejo sigue
  funcionando con el colector nuevo y viceversa.
- `ai-usage-doctor` muestra el tiempo restante del token y los incidentes
  activos.
- Corrección posterior: la primera versión mostraba "USD 99.71 disponibles de
  USD 100.00", calculado como límite menos gasto. Ese límite es un tope, no
  dinero. Ahora el saldo sale de `prepaid/credits` (ver §3.1) y el límite se
  muestra aparte.

### Widget

- Página **Configurar AI Usage… > Panel** con formato, semanal, reinicio
  semanal, segunda línea, crédito disponible, sesión sin iniciar, proveedores e
  intervalo, más una vista previa.
- Los formatos con reinicio de sesión permiten elegir tiempo restante, hora
  local del reinicio o ambos mediante **Mostrar reinicio como**.
- Tooltip con todas las ventanas, reinicios y créditos.
- `ProviderCard.qml` (cabecera con plan, fuente y antigüedad; aviso de token
  vencido) y `UsageBar.qml`; créditos al final de la card de Claude y Codex.
- Reloj único de 30 s para las cuentas regresivas; `status.json` solo se vuelve
  a interpretar cuando cambia.

### Diferencias con el plan

- La opción "Ocultar" para una sesión sin iniciar no se implementó: "atenuada"
  ya comunica lo mismo sin dejar el icono sin valor.
- Las fechas usan nombres de día en español fijos, no `Qt.locale()`, para
  poder testear `format.js` en Node; cambiará con `i18n()` (fase 4).
- La cabecera del proveedor no muestra todavía "token válido hasta"; el dato
  ya está en `status.json` (`token_expires_at`).

### Verificación

- `npm test`: 31 tests (parsers, mapeo con payloads reales sanitizados,
  incidentes/backoff y `format.js` cargado con `vm`). `qmllint` sin avisos.
- Corrida real del colector y simulación de token vencido en un `HOME`
  temporal: una sola línea en el log, snapshot conservado y sesión vencida
  mostrada como "sin iniciar".
- Capturas reales con `plasmoidviewer` del panel horizontal (formatos por
  defecto, completo y dos líneas), panel vertical, popup con datos reales y con
  token vencido, y de `ConfigPanel.qml` cargado con `qml6`.

### Pendiente

Fase 4 (salvo lo ya hecho: tests de `format.js`, `ProviderCard`, comparar el
texto antes de reasignar, doctor) y fase 5. También el respaldo con `limits[]`
si cambiara la respuesta OAuth.
