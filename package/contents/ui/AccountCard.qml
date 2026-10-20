import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC2
import org.kde.kirigami as Kirigami

import "../code/format.js" as Format

ProviderCard {
    id: card
    readonly property QtObject creditColors: ContrastPalette { id: colors }
    property var thresholds: null
    readonly property var billing: account.provider === "claude" ? Format.billingOf(account) : null
    readonly property bool codexCreditsVisible: account.provider === "codex"
        && (!!account.credits || !!account.reset_credits
            || (account.credits_remaining !== null && account.credits_remaining !== undefined))

    RowLayout {
        visible: card.account.provider !== "antigravity"
        Layout.fillWidth: true
        spacing: Kirigami.Units.largeSpacing * 2
        MetricRow {
            Layout.fillWidth: true
            Layout.preferredWidth: 1
            visible: !!metric
            label: card.account.provider === "codex" ? "5 horas" : "Sesión"
            metric: card.account.provider === "codex" ? card.account.five_hour : card.account.session
            thresholds: card.thresholds
            nowMs: card.nowMs
        }
        MetricRow {
            Layout.fillWidth: true
            Layout.preferredWidth: 1
            visible: !!metric
            label: "Semanal"
            metric: card.account.weekly
            thresholds: card.thresholds
            nowMs: card.nowMs
        }
    }
    GridLayout {
        visible: card.account.provider === "antigravity"
        Layout.fillWidth: true
        columns: 2
        columnSpacing: Kirigami.Units.largeSpacing
        rowSpacing: Kirigami.Units.largeSpacing
        Repeater {
            model: card.account.quota_windows || []
            delegate: MetricRow {
                required property var modelData
                Layout.fillWidth: true
                Layout.preferredWidth: 1
                label: modelData.label
                metric: modelData.metric
                thresholds: card.thresholds
                nowMs: card.nowMs
            }
        }
    }
    MetricRow {
        visible: !!card.account.routines
        Layout.fillWidth: true
        label: "Rutinas"
        metric: card.account.routines
        thresholds: card.thresholds
        nowMs: card.nowMs
    }
    QQC2.Label {
        visible: !!card.account.daily_routines
        Layout.fillWidth: true
        text: "Rutinas: " + Format.routines(card.account.daily_routines)
        font: Kirigami.Theme.smallFont
    }
    QQC2.Label {
        visible: text.length > 0
        Layout.fillWidth: true
        wrapMode: Text.Wrap
        color: colors.secondary
        font: Kirigami.Theme.smallFont
        text: Format.breakdownLine(card.account.weekly_breakdown)
    }
    ColumnLayout {
        visible: card.codexCreditsVisible || !!card.billing
        Layout.fillWidth: true
        spacing: Kirigami.Units.smallSpacing
        Kirigami.Separator { Layout.fillWidth: true }
        RowLayout {
            Layout.fillWidth: true
            QQC2.Label {
                text: "Créditos"
                font: Kirigami.Theme.smallFont
                color: colors.secondary
            }
            SeverityText {
                Layout.fillWidth: true
                horizontalAlignment: Text.AlignRight
                wrapMode: Text.Wrap
                font: Kirigami.Theme.defaultFont
                severity: card.billing ? Format.availableSeverity(card.billing)
                    : Format.codexHasCredits(card.account) ? Format.Severity.NORMAL : Format.Severity.MUTED
                text: card.billing ? Format.billingAvailableLine(card.billing)
                    : Format.codexCreditsLine(card.account.credits || { balance: card.account.credits_remaining })
            }
        }
        Text {
            visible: text.length > 0
            Layout.fillWidth: true
            wrapMode: Text.Wrap
            font: Kirigami.Theme.smallFont
            color: colors.secondary
            text: card.billing ? Format.billingSpentLine(card.billing)
                : card.account.reset_credits ? Format.resetCreditsLine(card.account.reset_credits) : ""
        }
        UsageBar {
            visible: !!card.billing && card.billing.percent !== null && card.billing.percent !== undefined
            value: card.billing ? Number(card.billing.percent) : 0
            color: colors.forSeverity(Format.billingSeverity(card.billing, card.thresholds))
            severity: Format.billingSeverity(card.billing, card.thresholds)
        }
    }
}
