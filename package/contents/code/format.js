.pragma library
// Turns parsed status data into the strings and colors the UI renders.
// Direct port of ai-usage/src/format.rs (see docs/06-kde-plasmoid-ui.md for
// the small differences between the COSMIC applet and this plasmoid).

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

// One topbar icon/label/severity per enabled provider (mirrors
// format.rs::topbar_entries). `state` is the object returned by
// status.js::parseStatusFile.
function topbarEntries(state) {
    if (state.kind === "missing") {
        return [{
            icon: "ai",
            label: "--",
            severity: Severity.MUTED,
            tooltip: "AI Usage — ejecuta ai-usage-collect"
        }];
    }

    if (state.kind === "invalid") {
        return [{
            icon: "ai",
            label: "!",
            severity: Severity.CRITICAL,
            tooltip: "AI Usage — status.json inválido"
        }];
    }

    var status = state.data;
    var stale = status.stale || isStaleByAge(status);
    var entries = [];

    if (status.codex) {
        entries.push(providerTopbar("codex", "Codex", "codex",
            status.codex.ok, status.codex.error_code,
            preferredMetric(status.codex.five_hour, status.codex.weekly), stale,
            status.thresholds));
    }

    if (status.claude) {
        entries.push(providerTopbar("claude", "Claude", "claude",
            status.claude.ok, status.claude.error_code,
            preferredMetric(status.claude.session, status.claude.weekly), stale,
            status.thresholds));
    }

    if (entries.length === 0) {
        entries.push({
            icon: "ai",
            label: "--",
            severity: Severity.MUTED,
            tooltip: "AI Usage — sin datos disponibles"
        });
    }

    return entries;
}

// Codex accounts may expose a 5-hour + weekly pair or only a weekly window.
// Prefer the short window when it contains a percentage, otherwise use weekly.
function preferredMetric(primary, fallback) {
    if (primary && primary.used_percent !== null && primary.used_percent !== undefined) {
        return primary;
    }
    return fallback;
}

function providerTopbar(icon, name, provider, ok, errorCode, metric, stale, thresholds) {
    if (errorCode === "login_required" || errorCode === "profile_missing") {
        return {
            icon: icon,
            label: "login",
            severity: Severity.LOGIN_REQUIRED,
            tooltip: "AI Usage — " + name + " requiere iniciar sesión (ai-usage-auth " + provider + ")"
        };
    }

    var usedPercent = metric ? metric.used_percent : null;
    var hasUsed = usedPercent !== null && usedPercent !== undefined;

    if (!ok || !hasUsed) {
        return {
            icon: icon,
            label: "--",
            severity: Severity.MUTED,
            tooltip: "AI Usage — " + name + " sin datos disponibles"
        };
    }

    var severity = severityForPercent(usedPercent, thresholds);
    var label = percent(usedPercent);

    if (stale) {
        label += "!";
        if (severity === Severity.NORMAL) severity = Severity.WARNING;
    }

    var tooltip = "AI Usage — " + name + " " + label + (stale ? " (datos desactualizados)" : " usado");

    return { icon: icon, label: label, severity: severity, tooltip: tooltip };
}

// Whether a provider has an active session, so the popup can offer "Ir a X"
// instead of "Iniciar sesión X".
function isSessionActive(ok, errorCode) {
    return ok || !(errorCode === "login_required" || errorCode === "profile_missing");
}

function isStaleByAge(status) {
    var updatedAt = Date.parse(status.updated_at);
    if (isNaN(updatedAt)) return false;

    var reference = updatedAt;
    if (status.alert_cleared_at) {
        var clearedAt = Date.parse(status.alert_cleared_at);
        if (!isNaN(clearedAt) && clearedAt > updatedAt) reference = clearedAt;
    }

    var ageMs = Date.now() - reference;
    var staleMinutes = status.thresholds && status.thresholds.stale_after_minutes !== undefined
        ? status.thresholds.stale_after_minutes : 15;
    return ageMs > staleMinutes * 60 * 1000;
}

// "Actualizado 14:07 (hace 2 min)" / stale variant for the popup header.
function updatedAtLine(status) {
    var relative = formatRelative(status.updated_at) || "fecha desconocida";
    var localTime = formatLocalTime(status.updated_at) || "hora desconocida";
    var timestamp = localTime + " (" + relative + ")";

    if (status.stale || isStaleByAge(status)) {
        return "Datos desactualizados · última info " + timestamp;
    }
    return "Actualizado " + timestamp;
}

function formatRelative(updatedAt) {
    var parsed = Date.parse(updatedAt);
    if (isNaN(parsed)) return null;

    var minutes = Math.floor((Date.now() - parsed) / 60000);
    if (minutes <= 0) return "hace instantes";
    if (minutes === 1) return "hace 1 min";
    if (minutes < 60) return "hace " + minutes + " min";

    var hours = Math.floor(minutes / 60);
    return hours === 1 ? "hace 1 h" : ("hace " + hours + " h");
}

function formatLocalTime(updatedAt) {
    var parsed = Date.parse(updatedAt);
    if (isNaN(parsed)) return null;

    var date = new Date(parsed);
    var now = new Date();
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    var sameDay = date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();

    if (sameDay) {
        return pad(date.getHours()) + ":" + pad(date.getMinutes());
    }
    return pad(date.getDate()) + "/" + pad(date.getMonth() + 1) + " " +
        pad(date.getHours()) + ":" + pad(date.getMinutes());
}

// `26%` / `--` for a raw percentage.
function percent(value) {
    if (value === null || value === undefined) return "--";
    return Math.round(value) + "%";
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
function metricRemainingMinutes(metric) {
    if (metric.reset_epoch !== null && metric.reset_epoch !== undefined) {
        var mins = Math.floor((metric.reset_epoch - Math.floor(Date.now() / 1000)) / 60);
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

// Reset label with a days/hours/minutes breakdown.
function resetLabelWithDuration(metric) {
    var label = resetLabel(metric);
    if (metric) {
        var mins = metricRemainingMinutes(metric);
        if (mins !== null) {
            return "reinicia " + label + " (" + durationBreakdown(mins) + ")";
        }
    }
    return "reinicia " + label;
}

function resetLabel(metric) {
    if (metric && metric.reset_label) return metric.reset_label;
    return "--";
}

// Severity of a metric's used_percent, for coloring popup values.
function metricSeverity(metric, thresholds) {
    if (metric && metric.used_percent !== null && metric.used_percent !== undefined) {
        return severityForPercent(metric.used_percent, thresholds);
    }
    return Severity.MUTED;
}

// `100% usado · 0% restante`.
function usageSummary(metric) {
    var used = metric ? metric.used_percent : null;
    var remaining = metric ? metric.remaining_percent : null;
    return percent(used) + " usado · " + percent(remaining) + " restante";
}

// Remaining Codex credits, e.g. `128` or `--`.
function credits(value) {
    return (value === null || value === undefined) ? "--" : String(value);
}

// `0 / 5` for Claude's included daily routine runs.
function routines(routinesObj) {
    if (routinesObj && routinesObj.used !== null && routinesObj.used !== undefined &&
        routinesObj.limit !== null && routinesObj.limit !== undefined) {
        return routinesObj.used + " / " + routinesObj.limit;
    }
    return "--";
}

// `USD 3.24` / `--` for a dollar amount.
function usd(value) {
    if (value === null || value === undefined) return "--";
    return "USD " + value.toFixed(2);
}

// `USD 3.24 gastado · 16% usado`.
function creditsSpent(creditsObj) {
    var spent = usd(creditsObj.spent_usd);
    if (creditsObj.spent_percent !== null && creditsObj.spent_percent !== undefined) {
        return spent + " gastado · " + Math.round(creditsObj.spent_percent) + "% usado";
    }
    return spent + " gastado";
}

// `USD 9.51 saldo · USD 20 límite`.
function creditsBalance(creditsObj) {
    if (creditsObj.balance_usd === null || creditsObj.balance_usd === undefined) {
        return usd(creditsObj.limit_usd) + " límite mensual";
    }
    return usd(creditsObj.balance_usd) + " saldo · " + usd(creditsObj.limit_usd) + " límite";
}

function creditsSeverity(creditsObj, thresholds) {
    if (creditsObj.spent_percent !== null && creditsObj.spent_percent !== undefined) {
        return severityForPercent(creditsObj.spent_percent, thresholds);
    }
    return Severity.MUTED;
}

// Human-readable hint shown under an error entry.
function errorHint(error) {
    switch (error.code) {
    case "login_required":
    case "profile_missing":
        return "Ejecuta: ai-usage-auth " + error.provider;
    case "page_changed":
        return "El layout pudo haber cambiado. Revisa el collector con debug_text activado.";
    case "network_error":
        return "Sin conexión o la página no respondió a tiempo.";
    case "profile_busy":
        return "Ya hay una sesión de Chrome en uso para este proveedor. Esperá a que termine.";
    default:
        return "Revisa el collector con: ai-usage-collect";
    }
}
