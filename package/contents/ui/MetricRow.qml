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
    readonly property color severityColor: Format.severityColor(
        Format.metricSeverity(metric, thresholds))
    readonly property string resetText: Format.resetLine(metric, nowMs)

    spacing: Kirigami.Units.smallSpacing

    RowLayout {
        Layout.fillWidth: true
        spacing: Kirigami.Units.smallSpacing

        QQC2.Label {
            text: root.label
            font.weight: Font.DemiBold
        }

        // Qt Quick Controls can replace a Label's palette when the plasmoid
        // becomes active. Plain Text keeps this semantic color binding intact.
        Text {
            text: Format.usageSummary(root.metric)
            color: root.severityColor
            font: Kirigami.Theme.defaultFont
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignRight
            verticalAlignment: Text.AlignVCenter
        }
    }

    UsageBar {
        value: root.idle ? 0 : root.usedPercent
        color: root.severityColor
    }

    Text {
        visible: root.resetText.length > 0
        text: root.resetText
        color: root.idle ? Format.COLOR_MUTED : Format.RESET_LABEL_COLOR
        font: Kirigami.Theme.smallFont
        opacity: 0.85
        Layout.fillWidth: true
        wrapMode: Text.Wrap
    }
}
