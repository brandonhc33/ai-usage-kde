.pragma library

// Stable, saturated status colors; a desktop theme may use pastel accents.
// Contrast correction below adapts these hues to each actual background.
var SEMANTIC_COLORS = {
    normal: "#22e37d",
    warning: "#ffb020",
    critical: "#ff4969",
    login_required: "#3da9ff"
};

// WCAG relative luminance in sRGB. All returned colors are opaque so text
// cannot lose its contrast through a second opacity multiplier.
function channels(value) {
    if (value && typeof value === "object" && value.r !== undefined) {
        return [value.r, value.g, value.b, value.a === undefined ? 1 : value.a];
    }
    var hex = String(value).replace(/^#/, "");
    if (hex.length === 3) hex = hex.replace(/./g, function (digit) { return digit + digit; });
    var alpha = hex.length === 8 ? parseInt(hex.slice(0, 2), 16) / 255 : 1;
    if (hex.length === 8) hex = hex.slice(2);
    return [parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255, alpha];
}

function hexColor(rgb) {
    return "#" + rgb.slice(0, 3).map(function (channel) {
        return ("0" + Math.round(Math.max(0, Math.min(1, channel)) * 255).toString(16)).slice(-2);
    }).join("");
}

function opaque(value) {
    return hexColor(channels(value));
}

function blend(foreground, background, amount) {
    var front = channels(foreground);
    var back = channels(background);
    var alpha = amount === undefined ? front[3] : amount;
    return hexColor([0, 1, 2].map(function (i) { return front[i] * alpha + back[i] * (1 - alpha); }));
}

function luminance(value) {
    var rgb = channels(value).slice(0, 3).map(function (channel) {
        return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrast(foreground, background) {
    var front = luminance(blend(foreground, background));
    var back = luminance(background);
    return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
}

function ensureContrast(foreground, background, minimum, additionalBackground) {
    var surface = opaque(background);
    var color = blend(foreground, surface);
    var target = minimum || 4.5;
    // A bar must contrast with both its track and the card. Choosing one
    // direction for both avoids undoing the first correction on mid-gray themes.
    function score(candidate) {
        var primary = contrast(candidate, surface);
        return additionalBackground ? Math.min(primary, contrast(candidate, additionalBackground)) : primary;
    }
    if (score(color) >= target) return color;
    var endpoint = score("#000000") >= score("#ffffff") ? "#000000" : "#ffffff";
    var low = 0;
    var high = 1;
    // Search the smallest adjustment, retaining the theme's semantic hue.
    // Quantization is part of the comparison: 4.499 must never pass as 4.5.
    for (var i = 0; i < 20; i++) {
        var middle = (low + high) / 2;
        if (score(blend(endpoint, color, middle)) >= target) high = middle;
        else low = middle;
    }
    return blend(endpoint, color, high);
}
