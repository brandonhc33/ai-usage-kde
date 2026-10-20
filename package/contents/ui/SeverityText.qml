// Panel text colored by usage severity.
//
// Panel Colorizer (and similar panel themers) assign `color` directly to every
// Text inside panel widgets when they restyle them, e.g. after the popup is
// opened. That drops the binding below and leaves every value in the theme's
// text color. Here the color is data (normal/warning/critical), not
// decoration, so the binding is put back whenever something overwrites it.
import QtQuick

Text {
    id: label

    property string severity: ""
    readonly property color severityColor: colors.forSeverity(severity)

    readonly property QtObject textColors: ContrastPalette { id: colors }

    color: severityColor

    onColorChanged: {
        if (!Qt.colorEqual(color, severityColor)) {
            color = Qt.binding(function () { return label.severityColor; });
        }
    }
}
