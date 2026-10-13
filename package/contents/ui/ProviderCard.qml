// Card shared by Codex and Claude: heading with plan/source/age, an optional
// informational notice (e.g. expired Claude Code token), the provider's rows
// (declared as children) or its error message.
import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC2
import org.kde.kirigami as Kirigami
import org.kde.plasma.extras as PlasmaExtras

import "../code/format.js" as Format

Kirigami.AbstractCard {
    id: card

    property string title: ""
    property url iconSource
    property var provider: null
    property double nowMs: Date.now()
    default property alias rows: rowsColumn.data

    readonly property bool providerOk: !!provider && provider.ok === true
    readonly property string notice: Format.providerNotice(provider)

    contentItem: ColumnLayout {
        spacing: Kirigami.Units.smallSpacing

        RowLayout {
            Layout.fillWidth: true
            spacing: Kirigami.Units.smallSpacing

            Kirigami.Icon {
                source: card.iconSource
                Layout.preferredWidth: Kirigami.Units.iconSizes.smallMedium
                Layout.preferredHeight: Kirigami.Units.iconSizes.smallMedium
            }
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 0

                PlasmaExtras.Heading {
                    level: 5
                    text: card.title
                }
                QQC2.Label {
                    visible: text.length > 0
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                    opacity: 0.7
                    font: Kirigami.Theme.smallFont
                    text: Format.providerSubtitle(card.provider, card.nowMs)
                }
            }
            Kirigami.Icon {
                source: !card.providerOk ? "data-warning"
                    : card.provider.stale ? "data-information" : "emblem-success"
                Layout.preferredWidth: Kirigami.Units.iconSizes.small
                Layout.preferredHeight: Kirigami.Units.iconSizes.small
            }
        }

        Kirigami.Separator { Layout.fillWidth: true }

        QQC2.Label {
            visible: card.providerOk && card.notice.length > 0
            Layout.fillWidth: true
            wrapMode: Text.Wrap
            font: Kirigami.Theme.smallFont
            text: card.notice
        }

        ColumnLayout {
            id: rowsColumn
            visible: card.providerOk
            Layout.fillWidth: true
            spacing: Kirigami.Units.smallSpacing
        }

        QQC2.Label {
            visible: !!card.provider && !card.providerOk
            Layout.fillWidth: true
            wrapMode: Text.Wrap
            opacity: 0.7
            font: Kirigami.Theme.smallFont
            text: Format.providerErrorMessage(card.title, card.provider)
        }
    }
}
