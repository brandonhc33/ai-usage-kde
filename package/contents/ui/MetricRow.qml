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

    spacing: 0

    RowLayout {
        spacing: Kirigami.Units.smallSpacing

        QQC2.Label {
            text: root.label
            Layout.preferredWidth: Kirigami.Units.gridUnit * 4
        }

        QQC2.Label {
            text: Format.usageSummary(root.metric)
            color: Format.severityColor(Format.metricSeverity(root.metric, root.thresholds))
        }
    }

    QQC2.Label {
        text: Format.resetLabelWithDuration(root.metric)
        color: Format.RESET_LABEL_COLOR
        font: Kirigami.Theme.smallFont
        opacity: 0.9
    }
}
