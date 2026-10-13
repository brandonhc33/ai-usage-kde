// Thin rounded progress bar used for quota windows and credit spend.
import QtQuick
import QtQuick.Layouts
import org.kde.kirigami as Kirigami

Item {
    id: bar

    property real value: 0
    property color color: Kirigami.Theme.highlightColor

    Layout.fillWidth: true
    Layout.preferredHeight: 5
    implicitHeight: 5

    Rectangle {
        anchors.fill: parent
        radius: height / 2
        color: Kirigami.Theme.disabledTextColor
        opacity: 0.22
    }

    Rectangle {
        width: parent.width * Math.max(0, Math.min(100, bar.value)) / 100
        height: parent.height
        radius: height / 2
        color: bar.color
    }
}
