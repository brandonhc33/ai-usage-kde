.pragma library
// Turns parsed status data into the strings and colors the UI renders.
// Started as a port of ai-usage/src/format.rs; the configurable panel
// formats, credits and countdowns are specific to this plasmoid (see
// docs/06-kde-plasmoid-ui.md).
//
// Every function that depends on the current time takes `nowMs` so QML can
// drive countdowns from a single timer, and so tests can pin the clock.

var WARNING_USED_PERCENT = 51;
var CRITICAL_USED_PERCENT = 76;

var COLOR_NORMAL = "#2ec059";
var COLOR_WARNING = "#f29c12";
var COLOR_CRITICAL = "#e62e38";
var COLOR_MUTED = "#8c9199";
var COLOR_LOGIN_REQUIRED = "#5c8aed";
var RESET_LABEL_COLOR = "#73adfa";

// Severity constants (mirrors the Severity enum in format.rs).
var Severity = {
    NORMAL: "normal",
    WARNING: "warning",
    CRITICAL: "critical",
    MUTED: "muted",
    LOGIN_REQUIRED: "login_required"
};

var WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

var PROVIDERS = [
    { key: "codex", name: "Codex", shortKey: "five_hour", shortLabel: "5 horas" },
    { key: "claude", name: "Claude", shortKey: "session", shortLabel: "Sesión" },
    { key: "antigravity", name: "Antigravity", shortKey: "quota", shortLabel: "Mayor uso" }
];

// Kept in sync with scripts/lib (structured-sources.mjs, antigravity.mjs).
var CLI_INSTALL = {
    codex: "npm install -g @openai/codex",
    antigravity: "curl -fsSL https://antigravity.google/cli/install.sh | bash"
};

var SOURCE_LABELS = {
    "codex-cli": "CLI",
    "claude-oauth": "OAuth",
    "antigravity-cli": "CLI",
    "antigravity-local": "App",
    "cli": "CLI",
    "oauth": "OAuth",
    "web": "web"
};

function severityColor(severity) {
    switch (severity) {
    case Severity.NORMAL: return COLOR_NORMAL;
    case Severity.WARNING: return COLOR_WARNING;
    case Severity.CRITICAL: return COLOR_CRITICAL;
    case Severity.MUTED: return COLOR_MUTED;
    case Severity.LOGIN_REQUIRED: return COLOR_LOGIN_REQUIRED;
    default: return COLOR_MUTED;
    }
}

function severityForPercent(usedPercent, thresholds) {
    if (usedPercent === null || usedPercent === undefined) return Severity.NORMAL;
    var critical = thresholds && thresholds.critical_used_percent !== undefined
        ? thresholds.critical_used_percent : CRITICAL_USED_PERCENT;
    var warning = thresholds && thresholds.warning_used_percent !== undefined
        ? thresholds.warning_used_percent : WARNING_USED_PERCENT;
    if (usedPercent >= critical) return Severity.CRITICAL;
    if (usedPercent >= warning) return Severity.WARNING;
    return Severity.NORMAL;
}

function hasValue(value) {
    return value !== null && value !== undefined;
}

function hasPercent(metric) {
    return !!metric && hasValue(metric.used_percent);
}

function remainingPercent(metric) {
    if (!hasPercent(metric)) return null;
    return hasValue(metric.remaining_percent)
        ? metric.remaining_percent : Math.max(0, 100 - metric.used_percent);
}

// A window that has not started yet (no usage and no reset time): it begins
// with the first message. Snapshots from schema v1 have no `state` field.
function isIdle(metric) {
    if (!hasPercent(metric)) return false;
    if (metric.state) return metric.state === "idle";
    return Number(metric.used_percent) === 0 && !hasValue(metric.reset_epoch) && !metric.reset_label;
}

function windowSeverity(metric, thresholds) {
    if (!hasPercent(metric) || isIdle(metric)) return Severity.MUTED;
    return severityForPercent(metric.used_percent, thresholds);
}

// --- Panel (compact representation) --------------------------------------

var DEFAULT_PANEL_OPTIONS = {
    preset: "used",
    resetTimeFormat: "duration",
    template: "{used}",
    showWeekly: false,
    showWeeklyReset: false,
    showMoney: false,
    idleWindow: "dim",
    twoLines: false,
    showCodex: true,
    showClaude: true,
    showAntigravity: true,
    hiddenAccountIds: [],
    showAccountNames: true,
    // Vertical panels: every " · " part on its own line.
    stacked: false
};

var PANEL_PRESETS = {
    used: "{used}",
    remaining: "{left}",
    time: "{reset_in}",
    used_time: "{used} · {reset_in}",
    remaining_time: "{left} · {reset_in}"
};

// Presets that talk about what is left also show the weekly value as left.
var REMAINING_PRESETS = { remaining: true, remaining_time: true, time: true };

var TOKEN_PATTERN = /\{([a-z_]+)\}/g;

// Plasmoid.configuration (or a partial object) → complete options.
function panelOptions(raw) {
    var options = {};
    for (var key in DEFAULT_PANEL_OPTIONS) {
        var value = raw ? raw[key] : undefined;
        options[key] = value === undefined || value === null || value === ""
            ? DEFAULT_PANEL_OPTIONS[key] : value;
    }
    return options;
}

// Values each template token can take for one provider: `{ text, severity }`
// or null when the provider does not report it.
function panelValues(provider, spec, options, thresholds, nowMs) {
    var short = provider[spec.shortKey];
    var weekly = provider.weekly;
    var shortIsWeekly = false;

    // Codex accounts may only have a weekly window; an idle Claude session can
    // optionally be replaced by the weekly window too.
    if (!hasPercent(short) && hasPercent(weekly)) {
        short = weekly;
        shortIsWeekly = true;
    } else if (isIdle(short) && options.idleWindow === "weekly" && hasPercent(weekly)) {
        short = weekly;
        shortIsWeekly = true;
    }

    var shortIdle = isIdle(short);
    var shortSeverity = windowSeverity(short, thresholds);
    var weeklySeverity = windowSeverity(weekly, thresholds);

    function token(text, severity) {
        return text === null || text === undefined ? null : { text: text, severity: severity };
    }

    return {
        hasShort: hasPercent(short),
        shortIsWeekly: shortIsWeekly,
        tokens: {
            used: token(hasPercent(short) ? percent(short.used_percent) : null, shortSeverity),
            left: token(hasPercent(short) ? percent(remainingPercent(short)) : null, shortSeverity),
            reset_in: token(shortIdle ? "—" : compactDuration(metricRemainingMinutes(short, nowMs)), shortSeverity),
            reset_at: token(shortIdle ? "—" : clockLabel(short ? short.reset_epoch : null), shortSeverity),
            w_used: token(hasPercent(weekly) ? percent(weekly.used_percent) : null, weeklySeverity),
            w_left: token(hasPercent(weekly) ? percent(remainingPercent(weekly)) : null, weeklySeverity),
            w_reset_in: token(isIdle(weekly) ? null : compactDuration(metricRemainingMinutes(weekly, nowMs)), weeklySeverity),
            w_reset_day: token(weekly && !isIdle(weekly) ? weekdayClockLabel(weekly.reset_epoch) : null, weeklySeverity),
            money: panelMoney(provider, thresholds)
        }
    };
}

function providerTemplate(options, values) {
    if (options.preset === "custom") return options.template;

    var template = PANEL_PRESETS[options.preset] || PANEL_PRESETS.used;
    var resetTemplate = "{reset_in}";
    if (options.resetTimeFormat === "clock") {
        resetTemplate = "{reset_at}";
    } else if (options.resetTimeFormat === "both" && values.tokens.reset_at
        && values.tokens.reset_at.text !== "—") {
        // Idle sessions have no reset yet; do not repeat the placeholder.
        // Older snapshots can have a countdown without a clock time.
        resetTemplate = values.tokens.reset_in ? "{reset_in} · {reset_at}" : "{reset_at}";
    }
    template = template.replace("{reset_in}", resetTemplate);
    if (values.shortIsWeekly) template = "S " + template;

    var weekly = [];
    if (options.showWeekly && !values.shortIsWeekly && values.tokens.w_used) {
        weekly.push(REMAINING_PRESETS[options.preset] ? "S {w_left}" : "S {w_used}");
    }
    if (options.showWeeklyReset && values.tokens.w_reset_day) {
        weekly.push("{w_reset_day}");
    }
    if (weekly.length > 0) {
        template += (options.twoLines ? "\n" : " · ") + weekly.join(" ");
    }
    if (options.showMoney && values.tokens.money) {
        template += " · {money}";
    }
    return template;
}

function pushSegment(segments, text, severity) {
    if (!text) return;
    var previous = segments[segments.length - 1];
    if (previous && previous.severity === severity) {
        previous.text += text;
    } else {
        segments.push({ text: text, severity: severity });
    }
}

// "{used} · {reset_in}" → [[{ text: "3%", severity }, { text: " · ", … }, …]].
// Lines are split on a real newline or a literal "\n" typed in the config
// field. Unknown tokens are kept verbatim; known but unavailable ones show "--".
function renderTemplate(template, tokens) {
    var lines = String(template).split(/\\n|\n/).map(function (line) {
        var segments = [];
        var last = 0;
        line.replace(TOKEN_PATTERN, function (match, name, offset) {
            pushSegment(segments, line.slice(last, offset), Severity.MUTED);
            if (!tokens.hasOwnProperty(name)) {
                pushSegment(segments, match, Severity.MUTED);
            } else if (tokens[name]) {
                pushSegment(segments, tokens[name].text, tokens[name].severity);
            } else {
                pushSegment(segments, "--", Severity.MUTED);
            }
            last = offset + match.length;
            return match;
        });
        pushSegment(segments, line.slice(last), Severity.MUTED);
        return segments;
    }).filter(function (segments) { return segments.length > 0; });

    return lines.length > 0 ? lines : [[{ text: "--", severity: Severity.MUTED }]];
}

function lineText(segments) {
    return segments.map(function (segment) { return segment.text; }).join("");
}

function mapSegments(lines, mapper) {
    return lines.map(function (segments) {
        return segments.map(function (segment) {
            return { text: segment.text, severity: mapper(segment.severity) };
        });
    });
}

function simpleEntry(icon, label, severity, tooltip) {
    return {
        icon: icon,
        label: label,
        severity: severity,
        tooltip: tooltip,
        lines: [[{ text: label, severity: severity }]]
    };
}

function providerPanelEntry(spec, provider, options, thresholds, stale, nowMs) {
    if (provider.error_code === "login_required" || provider.error_code === "profile_missing") {
        return simpleEntry(spec.key, "login", Severity.LOGIN_REQUIRED,
            "AI Usage — " + spec.name + " requiere iniciar sesión (ai-usage-auth " + spec.key + ")");
    }

    var values = panelValues(provider, spec, options, thresholds, nowMs);
    if (!provider.ok || !values.hasShort) {
        return simpleEntry(spec.key, "--", Severity.MUTED,
            "AI Usage — " + spec.name + " sin datos disponibles");
    }

    var template = providerTemplate(options, values);
    if (options.stacked) template = template.split(" · ").join("\n");
    var lines = renderTemplate(template, values.tokens);
    if (provider.stale_reason === "oauth_expired") {
        // Known state, not an error: old data in gray, no "!".
        lines = mapSegments(lines, function () { return Severity.MUTED; });
    } else if (stale || provider.stale) {
        lines = mapSegments(lines, function (severity) {
            return severity === Severity.NORMAL ? Severity.WARNING : severity;
        });
        pushSegment(lines[lines.length - 1], "!", Severity.WARNING);
    }

    var first = values.tokens.used;
    return {
        icon: spec.key,
        label: lines.map(lineText).join(" / "),
        severity: first ? first.severity : Severity.MUTED,
        tooltip: "AI Usage — " + spec.name,
        lines: lines
    };
}

// One panel entry (icon + one or two lines of colored segments) per visible
// provider. `state` is the object returned by status.js::parseStatusFile.
function accountsOf(status) {
    if (!status) return [];
    if (Array.isArray(status.accounts)) return status.accounts;
    return PROVIDERS.filter(function (spec) { return !!status[spec.key]; }).map(function (spec) {
        var account = {};
        for (var key in status[spec.key]) account[key] = status[spec.key][key];
        account.id = spec.key + "-default";
        account.provider = spec.key;
        account.label = "Principal";
        return account;
    });
}

function accountSpec(account) {
    return PROVIDERS.filter(function (spec) { return spec.key === account.provider; })[0];
}

function accountEmail(account) {
    return account && !account.logged_out && account.enabled !== false
        && typeof account.account_email === "string" ? account.account_email.trim() : "";
}

function panelEntries(state, rawOptions, nowMs) {
    if (state.kind === "missing") {
        return [simpleEntry("ai", "--", Severity.MUTED, "AI Usage — ejecuta ai-usage-collect")];
    }
    if (state.kind === "invalid") {
        return [simpleEntry("ai", "!", Severity.CRITICAL, "AI Usage — status.json inválido")];
    }

    var options = panelOptions(rawOptions);
    var status = state.data;
    var stale = status.stale || isStaleByAge(status, nowMs);
    var entries = [];

    var accounts = accountsOf(status);
    accounts.forEach(function (provider) {
        var spec = accountSpec(provider);
        if (!spec || provider.logged_out || provider.enabled === false) return;
        if (spec.key === "codex" && !options.showCodex) return;
        if (spec.key === "claude" && !options.showClaude) return;
        if (spec.key === "antigravity" && !options.showAntigravity) return;
        if (options.hiddenAccountIds.indexOf(provider.id) !== -1) return;
        var entry = providerPanelEntry(spec, provider, options, status.thresholds,
            (!Array.isArray(status.accounts) && stale) || provider.stale
                || (status.errors || []).some(function (error) { return error.account_id === provider.id; })
                || isStaleByAge({ updated_at: provider.updated_at || status.updated_at, thresholds: status.thresholds }, nowMs), nowMs);
        entry.accountId = provider.id;
        entry.accountLabel = provider.label || "Principal";
        entry.tooltip = spec.name + " · " + entry.accountLabel;
        var siblings = accounts.filter(function (account) { return account.provider === provider.provider; });
        entry.showAccountName = options.showAccountNames && siblings.length > 1;
        entries.push(entry);
    });

    if (entries.length === 0) {
        entries.push(simpleEntry("ai", "", Severity.MUTED, "AI Usage — abre para ver tus cuentas"));
    }
    return entries;
}

// Text-only preview of the panel for the configuration page, using a fixed
// sample account so every option has something to show.
function panelPreview(rawOptions, nowMs) {
    var nowSeconds = Math.floor(nowMs / 1000);
    var sample = {
        kind: "loaded",
        data: {
            updated_at: new Date(nowMs).toISOString(),
            codex: {
                ok: true,
                five_hour: { used_percent: 3, remaining_percent: 97, reset_epoch: nowSeconds + 236 * 60 },
                weekly: { used_percent: 51, remaining_percent: 49, reset_epoch: nowSeconds + 6982 * 60 }
            },
            claude: {
                ok: true,
                session: { used_percent: 0, remaining_percent: 100, reset_epoch: null, state: "idle" },
                weekly: { used_percent: 10, remaining_percent: 90, reset_epoch: nowSeconds + 7952 * 60 },
                billing: { currency: "USD", balance: 4.71, available: 4.71, spent: 0.29, limit: 100, percent: 0.29 }
            }
        }
    };
    return panelEntries(sample, rawOptions, nowMs).map(function (entry) {
        var spec = PROVIDERS.filter(function (p) { return p.key === entry.icon; })[0];
        return (spec ? spec.name + ": " : "") + entry.label;
    }).join("\n");
}

// --- Tooltip -------------------------------------------------------------

function metricLine(label, metric, nowMs) {
    if (isIdle(metric)) return label + ": sin iniciar";
    var reset = resetLine(metric, nowMs);
    return label + ": " + percent(metric.used_percent) + " usado" + (reset ? " · " + reset : "");
}

function providerTooltip(spec, provider, nowMs) {
    var lines = [spec.name + (provider.plan_type ? " · " + provider.plan_type : "")];
    var email = accountEmail(provider);
    if (email) lines.push("  " + email);
    if (!provider.ok) {
        lines.push("  " + providerErrorMessage(spec.name, provider));
        return lines.join("\n");
    }

    if (Array.isArray(provider.quota_windows)) {
        provider.quota_windows.forEach(function (window) {
            lines.push("  " + metricLine(window.label, window.metric, nowMs));
        });
    } else if (hasPercent(provider[spec.shortKey])) {
        lines.push("  " + metricLine(spec.shortLabel, provider[spec.shortKey], nowMs));
    }
    if (!provider.quota_windows && hasPercent(provider.weekly)) {
        lines.push("  " + metricLine("Semanal", provider.weekly, nowMs));
    }
    var billing = billingOf(provider);
    if (billing) {
        lines.push("  Créditos: " + billingAvailableLine(billing));
        if (hasValue(billing.limit)) lines.push("  " + billingSpentLine(billing));
    }
    if (codexHasCredits(provider)) lines.push("  " + codexCreditsLine(provider.credits));
    if (provider.reset_credits) lines.push("  " + resetCreditsLine(provider.reset_credits));
    var notice = providerNotice(provider);
    if (notice) lines.push("  " + notice);
    return lines.join("\n");
}

// Full detail on hover, so nothing requires opening the popup.
function tooltipText(state, nowMs) {
    if (state.kind !== "loaded") return panelEntries(state, null, nowMs)[0].tooltip;

    var status = state.data;
    var blocks = [];
    accountsOf(status).forEach(function (account) {
        var spec = accountSpec(account);
        if (!spec) return;
        var namedSpec = {};
        for (var key in spec) namedSpec[key] = spec[key];
        namedSpec.name = spec.name + " · " + (account.label || "Principal");
        blocks.push(providerTooltip(namedSpec, account, nowMs));
    });
    if (blocks.length === 0) return "AI Usage — sin datos disponibles";
    if (status.stale || isStaleByAge(status, nowMs)) blocks.push(updatedAtLine(status, nowMs));
    return blocks.join("\n");
}

// --- Provider cards --------------------------------------------------------

// Whether a provider has an active session, so the popup can offer "Ir a X"
// instead of "Iniciar sesión X".
function isSessionActive(ok, errorCode) {
    return ok || !(errorCode === "login_required" || errorCode === "profile_missing");
}

// "Plan pro · OAuth · hace 1 min".
function providerSubtitle(provider, nowMs) {
    if (!provider) return "";
    var parts = [];
    if (provider.plan_type) parts.push("Plan " + provider.plan_type);
    if (SOURCE_LABELS[provider.source]) parts.push(SOURCE_LABELS[provider.source]);
    var relative = formatRelative(provider.updated_at, nowMs);
    if (relative) parts.push(relative);
    return parts.join(" · ");
}

function providerName(key) {
    var spec = PROVIDERS.filter(function (provider) { return provider.key === key; })[0];
    return spec ? spec.name : key;
}

// Informational (non-error) notice shown under the provider heading.
function providerNotice(provider) {
    if (!provider) return "";
    if (/^antigravity-/.test(provider.source) && provider.stale) {
        return providerErrorMessage("Antigravity", { provider: "antigravity", error_code: provider.stale_reason })
            + " Se conservan los últimos datos de esta cuenta.";
    }
    if (provider.stale_reason === "oauth_expired") {
        var time = formatLocalTime(provider.updated_at);
        if (provider.managed) return "La sesión expiró: datos de las " + (time || "--") + ". Vuelve a iniciar sesión para actualizar.";
        return "Token de Claude Code expirado: datos de las " + (time || "--")
            + ". Abre Claude Code para actualizar.";
    }
    if (provider.limit_reached === true) {
        return "Límite de uso alcanzado.";
    }
    return "";
}

function providerErrorMessage(name, provider) {
    switch (provider ? provider.error_code : null) {
    case "logged_out":
        return "Sesión cerrada. Conecta esta cuenta para volver a ver su uso.";
    case "account_disabled":
        return "Cuenta desactivada.";
    case "cli_missing":
        return provider.provider === "antigravity"
            ? "Instala el CLI de Antigravity para ver tu cuota sin abrir la app: " + CLI_INSTALL.antigravity
            : "Instala el CLI de " + name + " para leer el uso sin navegador: " + CLI_INSTALL.codex;
    case "app_not_running":
        return "Abre Antigravity e inicia sesión con Google para consultar su uso.";
    case "account_mismatch":
        return "El CLI y la app de Antigravity tienen abierta otra cuenta de Google.";
    case "quota_unavailable":
        return "Antigravity todavía no informó sus cuotas. Actualiza la aplicación y vuelve a intentar.";
    case "login_required":
    case "profile_missing":
        if (provider.provider === "antigravity") return "Inicia sesión en el CLI de Antigravity: ejecuta agy en una terminal.";
        return "La sesión de " + name + " venció o todavía no está configurada.";
    case "oauth_expired":
        return provider.managed ? "La sesión expiró. Vuelve a iniciar sesión para actualizar esta cuenta."
            : "El token de Claude Code expiró. Abre Claude Code para renovarlo.";
    default:
        return name + " no pudo actualizarse. Reintenta o revisa los detalles del aviso.";
    }
}

// "Uso semanal: Claude Code 100% · Chats 12%" (only products with usage).
function breakdownLine(rows) {
    if (!rows || !rows.length) return "";
    var used = rows.filter(function (row) { return row.percent > 0; });
    if (used.length === 0) return "";
    return "Uso semanal: " + used.map(function (row) {
        return row.name + " " + percent(row.percent);
    }).join(" · ");
}

// --- Dates and durations ---------------------------------------------------

function isStaleByAge(status, nowMs) {
    var now = hasValue(nowMs) ? nowMs : Date.now();
    var updatedAt = Date.parse(status.updated_at);
    if (isNaN(updatedAt)) return false;

    var reference = updatedAt;
    if (status.alert_cleared_at) {
        var clearedAt = Date.parse(status.alert_cleared_at);
        if (!isNaN(clearedAt) && clearedAt > updatedAt) reference = clearedAt;
    }

    var ageMs = now - reference;
    var staleMinutes = status.thresholds && status.thresholds.stale_after_minutes !== undefined
        ? status.thresholds.stale_after_minutes : 15;
    return ageMs > staleMinutes * 60 * 1000;
}

// "Actualizado 14:07 (hace 2 min)" / stale variant for the popup header.
function updatedAtLine(status, nowMs) {
    var relative = formatRelative(status.updated_at, nowMs) || "fecha desconocida";
    var localTime = formatLocalTime(status.updated_at, nowMs) || "hora desconocida";
    var timestamp = localTime + " (" + relative + ")";

    if (status.stale || isStaleByAge(status, nowMs)) {
        return "Datos desactualizados · última info " + timestamp;
    }
    return "Actualizado " + timestamp;
}

function formatRelative(updatedAt, nowMs) {
    var parsed = Date.parse(updatedAt);
    if (isNaN(parsed)) return null;

    var now = hasValue(nowMs) ? nowMs : Date.now();
    var minutes = Math.floor((now - parsed) / 60000);
    if (minutes <= 0) return "hace instantes";
    if (minutes === 1) return "hace 1 min";
    if (minutes < 60) return "hace " + minutes + " min";

    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours === 1 ? "hace 1 h" : ("hace " + hours + " h");
    var days = Math.floor(hours / 24);
    return days === 1 ? "hace 1 d" : ("hace " + days + " d");
}

function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
}

function formatLocalTime(updatedAt, nowMs) {
    var parsed = Date.parse(updatedAt);
    if (isNaN(parsed)) return null;

    var date = new Date(parsed);
    var now = new Date(hasValue(nowMs) ? nowMs : Date.now());
    var sameDay = date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();

    if (sameDay) {
        return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
    }
    return pad2(date.getDate()) + "/" + pad2(date.getMonth() + 1) + " " +
        pad2(date.getHours()) + ":" + pad2(date.getMinutes());
}

// "17:24".
function clockLabel(epochSeconds) {
    if (!hasValue(epochSeconds)) return null;
    var date = new Date(epochSeconds * 1000);
    return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
}

// "mié 09:50".
function weekdayClockLabel(epochSeconds) {
    if (!hasValue(epochSeconds)) return null;
    return WEEKDAYS[new Date(epochSeconds * 1000).getDay()] + " " + clockLabel(epochSeconds);
}

// "hoy 17:24" / "mañana 01:00" / "mié 14 09:50" / "22/10 15:13".
function dayClockLabel(epochSeconds, nowMs) {
    var date = new Date(epochSeconds * 1000);
    var now = new Date(hasValue(nowMs) ? nowMs : Date.now());
    var startOfDay = function (d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
    var days = Math.round((startOfDay(date) - startOfDay(now)) / 86400000);
    var clock = clockLabel(epochSeconds);

    if (days === 0) return "hoy " + clock;
    if (days === 1) return "mañana " + clock;
    if (days > 1 && days < 7) return WEEKDAYS[date.getDay()] + " " + date.getDate() + " " + clock;
    return pad2(date.getDate()) + "/" + pad2(date.getMonth() + 1) + " " + clock;
}

// "22/10".
function dayMonthLabel(epochSeconds) {
    var date = new Date(epochSeconds * 1000);
    return pad2(date.getDate()) + "/" + pad2(date.getMonth() + 1);
}

// `26%` / `--` for a raw percentage.
function percent(value) {
    if (value === null || value === undefined) return "--";
    return Math.round(value) + "%";
}

// Like percent() but keeps one decimal for small non-integer values, so a
// USD 0.29 spend over USD 100 reads 0.3% instead of 0%.
function percentPrecise(value) {
    if (value === null || value === undefined) return "--";
    var number = Number(value);
    if (number > 0 && number < 10 && Math.round(number) !== number) {
        return number.toFixed(1) + "%";
    }
    return Math.round(number) + "%";
}

var UNIT_MINUTES = {
    "min": 1, "mins": 1, "minuto": 1, "minutos": 1,
    "h": 60, "hr": 60, "hrs": 60, "hora": 60, "horas": 60, "hour": 60, "hours": 60,
    "d": 1440, "día": 1440, "dia": 1440, "días": 1440, "dias": 1440, "day": 1440, "days": 1440,
    "sem": 10080, "semana": 10080, "semanas": 10080, "week": 10080, "weeks": 10080
};

// Total remaining minutes inferred from a *duration* reset_label (e.g.
// "en 2 h 33 min" → 153). Returns null for absolute date/time labels.
function remainingMinutes(label) {
    var lower = label.toLowerCase();
    var tokens = lower.split(/[^a-z0-9áéíóúñ]+/i).filter(function (s) { return s.length > 0; });

    var total = 0;
    var found = false;
    var i = 0;
    while (i < tokens.length) {
        var num = parseInt(tokens[i], 10);
        if (!isNaN(num) && String(num) === tokens[i] && UNIT_MINUTES.hasOwnProperty(tokens[i + 1])) {
            total += num * UNIT_MINUTES[tokens[i + 1]];
            found = true;
            i += 2;
            continue;
        }
        i += 1;
    }

    return found ? total : null;
}

// Minutes remaining until a metric's reset. Prefers reset_epoch (live
// countdown) over parsing the duration out of reset_label.
function metricRemainingMinutes(metric, nowMs) {
    if (!metric) return null;
    if (hasValue(metric.reset_epoch)) {
        var now = hasValue(nowMs) ? nowMs : Date.now();
        var mins = Math.floor((metric.reset_epoch * 1000 - now) / 60000);
        return mins >= 0 ? mins : null;
    }
    if (metric.reset_label) {
        return remainingMinutes(metric.reset_label);
    }
    return null;
}

function durationBreakdown(totalMinutes) {
    var days = Math.floor(totalMinutes / 1440);
    var hours = Math.floor((totalMinutes % 1440) / 60);
    var minutes = totalMinutes % 60;

    if (days > 0) {
        return days + " d " + hours + " h " + minutes + " min";
    }
    return hours + " h " + minutes + " min";
}

// Panel-sized duration: "45m", "3h56", "4d20h".
function compactDuration(totalMinutes) {
    if (!hasValue(totalMinutes)) return null;
    if (totalMinutes < 60) return totalMinutes + "m";
    if (totalMinutes < 1440) return Math.floor(totalMinutes / 60) + "h" + pad2(totalMinutes % 60);
    return Math.floor(totalMinutes / 1440) + "d" + Math.floor((totalMinutes % 1440) / 60) + "h";
}

// "reinicia hoy 17:24 (3 h 56 min)"; "" when the metric has no reset info.
function resetLine(metric, nowMs) {
    if (!metric) return "";
    if (isIdle(metric)) return "Empieza con tu primer mensaje.";

    var mins = metricRemainingMinutes(metric, nowMs);
    var suffix = mins !== null ? " (" + durationBreakdown(mins) + ")" : "";
    if (hasValue(metric.reset_epoch)) {
        return "reinicia " + dayClockLabel(metric.reset_epoch, nowMs) + suffix;
    }
    if (metric.reset_label) {
        return "reinicia " + metric.reset_label + suffix;
    }
    return "";
}

// Severity of a metric's used_percent, for coloring popup values.
function metricSeverity(metric, thresholds) {
    return windowSeverity(metric, thresholds);
}

// `100% usado · 0% restante` / `sin iniciar`.
function usageSummary(metric) {
    if (isIdle(metric)) return "sin iniciar · 100% disponible";
    var used = metric ? metric.used_percent : null;
    return percent(used) + " usado · " + percent(remainingPercent(metric)) + " restante";
}

// `0 / 5` for Claude's included daily routine runs.
function routines(routinesObj) {
    if (routinesObj && routinesObj.used !== null && routinesObj.used !== undefined &&
        routinesObj.limit !== null && routinesObj.limit !== undefined) {
        return routinesObj.used + " / " + routinesObj.limit;
    }
    return "--";
}

// --- Credits ---------------------------------------------------------------

// Normalized money block (see billingSummary() in the collector): `balance`
// is the prepaid credit, `limit` only the monthly spending cap, `available`
// the balance capped by what is left of that limit. Snapshots from schema v1
// only have the legacy `credits` object (spent_usd/limit_usd/…), so derive
// the same shape.
function billingOf(provider) {
    if (!provider) return null;
    if (provider.billing) return provider.billing;

    var legacy = provider.credits;
    if (!legacy || (!hasValue(legacy.spent_usd) && !hasValue(legacy.limit_usd) && !hasValue(legacy.balance_usd))) {
        return null;
    }
    var spent = hasValue(legacy.spent_usd) ? legacy.spent_usd : null;
    var limit = hasValue(legacy.limit_usd) ? legacy.limit_usd : null;
    var balance = hasValue(legacy.balance_usd) ? legacy.balance_usd : null;
    var limitRemaining = limit !== null && spent !== null
        ? Math.round(Math.max(0, limit - spent) * 100) / 100 : null;
    return {
        currency: "USD",
        balance: balance,
        available: balance === null ? null
            : limitRemaining === null ? balance : Math.min(balance, limitRemaining),
        spent: spent,
        limit: limit,
        limit_remaining: limitRemaining,
        percent: hasValue(legacy.spent_percent) ? legacy.spent_percent : null,
        limit_reached: false
    };
}

// `USD 3.24` / `--`.
function money(amount, currency) {
    if (!hasValue(amount)) return "--";
    return (currency || "USD") + " " + Number(amount).toFixed(2);
}

// `$99.71` for the panel.
function shortMoney(amount, currency) {
    if (!hasValue(amount)) return null;
    if (!currency || currency === "USD") return "$" + Number(amount).toFixed(2);
    return Number(amount).toFixed(2) + " " + currency;
}

// `USD 4.71 disponibles`; when the monthly limit leaves less than the
// balance, `USD 2.00 disponibles (saldo USD 4.71)`. The spending limit is
// never presented as money.
function billingAvailableLine(billing) {
    if (!hasValue(billing.available)) return "saldo no informado";
    var line = money(billing.available, billing.currency) + " disponibles";
    if (hasValue(billing.balance) && billing.balance !== billing.available) {
        line += " (saldo " + money(billing.balance, billing.currency) + ")";
    }
    return line;
}

// `Límite de gasto mensual: USD 0.29 de USD 100.00 (0.3%)`.
function billingSpentLine(billing) {
    if (!hasValue(billing.limit)) {
        return money(billing.spent, billing.currency) + " gastado este mes";
    }
    var line = "Límite de gasto mensual: " + money(billing.spent, billing.currency)
        + " de " + money(billing.limit, billing.currency);
    if (hasValue(billing.percent)) line += " (" + percentPrecise(billing.percent) + ")";
    return line;
}

// Color of the available amount: nothing left (or limit reached) is critical.
function availableSeverity(billing) {
    if (!billing || !hasValue(billing.available)) return Severity.MUTED;
    if (billing.limit_reached === true || billing.available <= 0) return Severity.CRITICAL;
    return Severity.NORMAL;
}

// Color of the monthly spending-limit bar.
function billingSeverity(billing, thresholds) {
    if (!billing) return Severity.MUTED;
    if (billing.limit_reached === true) return Severity.CRITICAL;
    if (hasValue(billing.percent)) return severityForPercent(billing.percent, thresholds);
    return Severity.MUTED;
}

function codexHasCredits(provider) {
    var credits = provider ? provider.credits : null;
    return !!credits && hasValue(credits.has_credits) && (credits.has_credits || credits.unlimited);
}

function creditUnits(value) {
    return String(Math.round(Number(value || 0) * 100) / 100);
}

// `12.5 créditos` / `Créditos ilimitados` for Codex (units, not money).
function codexCreditsLine(credits) {
    if (!credits) return "--";
    if (credits.unlimited) return "Créditos ilimitados";
    return creditUnits(credits.balance) + " créditos";
}

// `3 reinicios gratis de límites · el primero vence el 22/10`.
function resetCreditsLine(resetCredits) {
    var count = resetCredits.available;
    var line = count + (count === 1 ? " reinicio gratis" : " reinicios gratis") + " de límites";
    if (hasValue(resetCredits.next_expiry_epoch)) {
        line += " · " + (count === 1 ? "vence" : "el primero vence") + " el "
            + dayMonthLabel(resetCredits.next_expiry_epoch);
    }
    return line;
}

// Money/credits token for the panel, or null when there is nothing to show.
function panelMoney(provider, thresholds) {
    var billing = billingOf(provider);
    if (billing && hasValue(billing.available)) {
        return {
            text: shortMoney(billing.available, billing.currency),
            severity: availableSeverity(billing)
        };
    }
    if (codexHasCredits(provider)) {
        var credits = provider.credits;
        return {
            text: credits.unlimited ? "∞ cr" : creditUnits(credits.balance) + " cr",
            severity: Severity.NORMAL
        };
    }
    return null;
}

// Human-readable hint shown under an error entry.
function errorHint(error) {
    switch (error.code) {
    case "login_required":
    case "profile_missing":
        return "Ejecuta: ai-usage-auth " + error.provider;
    case "oauth_expired":
        return "Abre Claude Code: renueva el token automáticamente.";
    case "page_changed":
        return "El layout pudo haber cambiado. Revisa ~/.cache/ai-usage-status/debug-<proveedor>-text.txt.";
    case "network_error":
        return "Sin conexión o la página no respondió a tiempo.";
    case "profile_busy":
        return "Ya hay una sesión de Chrome en uso para este proveedor. Esperá a que termine.";
    case "browser_crashed":
        return "Chrome se cerró al iniciar. El colector probará automáticamente el modo compatible.";
    default:
        return "Revisa el collector con: ai-usage-collect";
    }
}
