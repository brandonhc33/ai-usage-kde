// Label + usage percentage (colored by severity) + reset caption below it.
// Reused by the Codex and Claude cards in main.qml for their 5h/weekly/
// session metrics, mirroring `metric_row()` in ai-usage/src/app.rs.
import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC2
import org.kde.kirigami as Kirigami

import "../code/format.js" as Format

ColumnLayout {
    id: root

    property string label: ""
    property var metric: null
    property var thresholds: null
    // Driven by main.qml's clock so the countdown stays current.
    property double nowMs: Date.now()

    readonly property bool idle: Format.isIdle(metric)
    readonly property real usedPercent: metric && metric.used_percent !== null
        && metric.used_percent !== undefined ? Number(metric.used_percent) : 0
    readonly property string severity: Format.metricSeverity(metric, thresholds)
    readonly property color severityColor: colors.forSeverity(severity)
    readonly property string resetText: Format.resetLine(metric, nowMs)

    readonly property QtObject metricColors: ContrastPalette { id: colors }

    spacing: Kirigami.Units.smallSpacing

    QQC2.Label {
        Layout.fillWidth: true
        text: root.label
        wrapMode: Text.Wrap
        font: Kirigami.Theme.smallFont
        color: colors.secondary
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: Kirigami.Units.smallSpacing

        // Qt Quick Controls can replace a Label's palette when the plasmoid
        // becomes active. Plain Text keeps this semantic color binding intact.
        SeverityText {
            text: root.idle ? "Sin iniciar" : Format.percent(root.metric ? root.metric.used_percent : null)
            severity: root.severity
            font.pointSize: Kirigami.Theme.defaultFont.pointSize + 6
            font.weight: Font.DemiBold
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignLeft
            verticalAlignment: Text.AlignVCenter
        }
    }

    QQC2.Label {
        text: root.idle ? "100% disponible" : Format.percent(Format.remainingPercent(root.metric)) + " disponible"
        font: Kirigami.Theme.smallFont
        color: colors.secondary
    }

    UsageBar {
        value: root.idle ? 0 : root.usedPercent
        color: root.severityColor
        severity: root.severity
    }

    Text {
        visible: root.resetText.length > 0
        text: root.resetText
        color: colors.secondary
        font: Kirigami.Theme.smallFont
        Layout.fillWidth: true
        wrapMode: Text.Wrap
    }
}
