// Thin rounded progress bar used for quota windows and credit spend.
import QtQuick
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import "../code/colors.js" as Colors

Item {
    id: bar

    property real value: 0
    property color color: Kirigami.Theme.highlightColor
    property string severity: ""
    readonly property color fillColor: Colors.ensureContrast(
        Colors.SEMANTIC_COLORS[severity] || color, colors.surface, 3, colors.track)

    readonly property QtObject barColors: ContrastPalette { id: colors }

    Layout.fillWidth: true
    Layout.preferredHeight: 6
    implicitHeight: 6

    Rectangle {
        anchors.fill: parent
        radius: height / 2
        color: colors.track
        border.width: 1
        border.color: colors.outline
    }

    Rectangle {
        width: parent.width * Math.max(0, Math.min(100, bar.value)) / 100
        height: parent.height
        radius: height / 2
        color: bar.fillColor
    }
}
