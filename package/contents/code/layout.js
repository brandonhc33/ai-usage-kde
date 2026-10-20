.pragma library

var AGENTS = [
    { key: "codex", name: "Codex" },
    { key: "claude", name: "Claude" },
    { key: "antigravity", name: "Antigravity" }
];

function numberInRange(value, fallback, minimum, maximum) {
    var number = Number(value);
    return isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.floor(number))) : fallback;
}

// Separate lanes preserve account order within each agent. A large agent
// continues in adjacent lanes instead of forcing every account into one stack.
function plan(accounts, options) {
    options = options || {};
    var cardWidth = options.cardWidth || 352;
    var minimumCardWidth = options.minimumCardWidth || 290;
    var gap = options.gap || 16;
    var padding = options.padding || 16;
    var maxWidth = Math.max(minimumCardWidth + 2 * padding, options.screenWidth || 1280);
    var maxHeight = Math.max(300, options.screenHeight || 800);
    var autoWidth = options.autoWidth !== false;
    var autoHeight = options.autoHeight !== false;
    var requestedWidth = numberInRange(options.width, 900, 320, 3840);
    var requestedHeight = numberInRange(options.height, 650, 260, 2160);
    var availableWidth = autoWidth ? maxWidth : Math.min(maxWidth, requestedWidth);
    var availableHeight = autoHeight ? maxHeight : Math.min(maxHeight, requestedHeight);
    var groups = AGENTS.map(function (agent) {
        return { provider: agent.key, name: agent.name, accounts: accounts.filter(function (account) {
            return account.provider === agent.key;
        }) };
    }).filter(function (group) { return group.accounts.length > 0; });
    var automaticRows = Math.max(1, Math.floor((availableHeight - 164) / (options.cardHeight || 220)));
    var requestedRows = numberInRange(options.rows, 0, 0, 8);
    var rows = requestedRows || automaticRows;
    var lanes = [];
    groups.forEach(function (group) {
        var chunks = [];
        var chunk = [];
        var height = 0;
        group.accounts.forEach(function (account) {
            var estimate = options.cardHeight || 220;
            if (account.account_email) estimate += 20;
            if (account.quota_windows) estimate += Math.max(0, Math.ceil(account.quota_windows.length / 2) - 1) * 104;
            if (account.credits || account.billing) estimate += 42;
            if (account.routines) estimate += 104;
            if (account.stale) estimate += 40;
            if (chunk.length && (chunk.length >= rows
                || (!requestedRows && height + gap + estimate > availableHeight - 164))) {
                chunks.push(chunk);
                chunk = [];
                height = 0;
            }
            height += (chunk.length ? gap : 0) + estimate;
            chunk.push(account);
        });
        if (chunk.length) chunks.push(chunk);
        for (var part = 0; part < chunks.length; part++) {
            lanes.push({
                provider: group.provider, name: group.name, total: group.accounts.length,
                part: part + 1, parts: chunks.length, accounts: chunks[part]
            });
        }
    });
    var widthForFit = autoWidth ? cardWidth : minimumCardWidth;
    var columnsThatFit = Math.max(1, Math.floor((availableWidth - 2 * padding + gap) / (widthForFit + gap)));
    var requestedColumns = numberInRange(options.columns, 0, 0, 6);
    var columns = Math.min(requestedColumns || lanes.length || 1, columnsThatFit, Math.max(1, lanes.length));
    var width = autoWidth ? Math.min(maxWidth, columns * cardWidth + (columns - 1) * gap + 2 * padding)
        : Math.min(maxWidth, Math.max(minimumCardWidth + 2 * padding, requestedWidth));
    return {
        lanes: lanes, columns: columns, rows: rows, width: width,
        maxHeight: maxHeight, height: autoHeight ? 0 : Math.min(maxHeight, requestedHeight),
        autoHeight: autoHeight
    };
}
