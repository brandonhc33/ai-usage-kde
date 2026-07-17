.pragma library
// Parses `~/.cache/ai-usage-status/status.json` and `collector.lock` content.
// Direct port of ai-usage/src/status.rs, minus the actual file reads (done
// in main.qml through KDE's executable Data Engine — QML has no native
// filesystem API of its own) and minus the /proc/<pid> liveness check for
// collectorRunning (documented simplification, see docs/06-kde-plasmoid-ui.md).

var COLLECTOR_LOCK_STALE_MS = 10 * 60 * 1000;

// Turns the raw text read from status.json into a { kind, data } pair,
// mirroring the StatusState enum (Missing / Invalid / Loaded).
//
// `exists` is false when the file read itself failed (ENOENT); `text` is
// the file content when it succeeded.
function parseStatusFile(exists, text) {
    if (!exists) {
        return { kind: "missing", data: null };
    }

    try {
        var data = JSON.parse(text);
        if (typeof data !== "object" || data === null || typeof data.updated_at !== "string") {
            return { kind: "invalid", data: null };
        }
        return { kind: "loaded", data: data };
    } catch (e) {
        return { kind: "invalid", data: null };
    }
}

// True while an ai-usage-collect process is presumed to hold the lock,
// based purely on the lock's age (see module comment above for why this
// differs from the Rust version's /proc check).
function collectorRunning(exists, text) {
    if (!exists) return false;

    var lock;
    try {
        lock = JSON.parse(text);
    } catch (e) {
        return false;
    }

    var startedAt = Date.parse(lock.started_at);
    if (isNaN(startedAt)) return false;

    return (Date.now() - startedAt) <= COLLECTOR_LOCK_STALE_MS;
}
