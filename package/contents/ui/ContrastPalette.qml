import QtQuick
import org.kde.kirigami as Kirigami

import "../code/colors.js" as Colors

QtObject {
    property color background: Kirigami.Theme.backgroundColor
    readonly property color surface: Colors.opaque(background)
    readonly property color text: Colors.ensureContrast(Kirigami.Theme.textColor, surface, 4.5)
    readonly property color secondary: Colors.ensureContrast(Kirigami.Theme.disabledTextColor, surface, 5)
    readonly property color positive: Colors.ensureContrast(Colors.SEMANTIC_COLORS.normal, surface, 4.5)
    readonly property color warning: Colors.ensureContrast(Colors.SEMANTIC_COLORS.warning, surface, 4.5)
    readonly property color negative: Colors.ensureContrast(Colors.SEMANTIC_COLORS.critical, surface, 4.5)
    readonly property color link: Colors.ensureContrast(Colors.SEMANTIC_COLORS.login_required, surface, 4.5)
    readonly property color track: Colors.blend("#000000", surface, 0.16)
    readonly property color outline: Colors.ensureContrast(Colors.blend(text, surface, 0.4), surface, 3)
    readonly property color border: Colors.blend(text, surface, 0.22)

    function forSeverity(severity) {
        switch (severity) {
        case "normal": return positive;
        case "warning": return warning;
        case "critical": return negative;
        case "login_required": return link;
        default: return secondary;
        }
    }
}
