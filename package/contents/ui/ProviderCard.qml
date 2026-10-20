import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC2
import org.kde.kirigami as Kirigami

import "../code/format.js" as Format
import "../code/colors.js" as Colors

Kirigami.AbstractCard {
    id: card

    property var account: ({})
    property url iconSource
    property bool pinned: true
    property bool busy: false
    property double nowMs: Date.now()
    default property alias rows: rowsColumn.data
    signal pinRequested()
    signal loginRequested()
    signal logoutRequested()
    signal removeRequested()
    signal renameRequested()
    signal openRequested()

    readonly property bool providerOk: account.ok === true
    readonly property string providerName: Format.providerName(account.provider)
    readonly property string accountEmail: Format.accountEmail(account)
    readonly property color accent: Colors.ensureContrast(account.provider === "codex" ? "#18c7a1"
        : account.provider === "claude" ? "#f47b4b" : "#668bff", colors.surface, 3)
    readonly property string notice: Format.providerNotice(account)

    Kirigami.Theme.inherit: false
    Kirigami.Theme.colorSet: Kirigami.Theme.View
    readonly property QtObject cardColors: ContrastPalette { id: colors }

    padding: Kirigami.Units.largeSpacing
    background: Rectangle {
        radius: 12
        color: colors.surface
        border.width: 1
        border.color: colors.border
        Rectangle {
            width: 3
            height: Math.min(38, parent.height - 24)
            anchors.left: parent.left
            anchors.top: parent.top
            anchors.topMargin: 18
            radius: 2
            color: card.accent
            opacity: card.account.logged_out ? 0.35 : 1
        }
    }

    contentItem: ColumnLayout {
        spacing: Kirigami.Units.largeSpacing

        RowLayout {
            Layout.fillWidth: true
            spacing: Kirigami.Units.smallSpacing * 2

            Rectangle {
                Layout.preferredWidth: 38
                Layout.preferredHeight: 38
                radius: 10
                color: Qt.rgba(card.accent.r, card.accent.g, card.accent.b, 0.12)
                Kirigami.Icon {
                    anchors.centerIn: parent
                    source: card.iconSource
                    width: 24
                    height: 24
                }
            }
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 1
                QQC2.Label {
                    Layout.fillWidth: true
                    text: card.account.label || "Principal"
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    font.weight: Font.DemiBold
                    color: colors.text
                    font.pointSize: Kirigami.Theme.defaultFont.pointSize + 1
                }
                QQC2.Label {
                    id: emailLabel
                    visible: card.accountEmail.length > 0
                    Layout.fillWidth: true
                    text: card.accountEmail
                    textFormat: Text.PlainText
                    color: colors.secondary
                    font: Kirigami.Theme.smallFont
                    elide: Text.ElideMiddle
                    HoverHandler { id: emailHover }
                    QQC2.ToolTip.visible: emailHover.hovered
                    QQC2.ToolTip.text: emailLabel.text
                }
                QQC2.Label {
                    Layout.fillWidth: true
                    text: card.providerName + (card.account.plan_type ? " · " + card.account.plan_type : "")
                    color: colors.secondary
                    font: Kirigami.Theme.smallFont
                    elide: Text.ElideRight
                }
            }
            QQC2.ToolButton {
                icon.name: card.pinned ? "window-pin" : "window-unpin"
                checkable: true
                checked: card.pinned
                enabled: !card.account.logged_out && card.account.enabled !== false
                Accessible.name: card.pinned ? "Ocultar en la barra" : "Mostrar en la barra"
                QQC2.ToolTip.visible: hovered
                QQC2.ToolTip.text: Accessible.name
                onClicked: card.pinRequested()
            }
            QQC2.ToolButton {
                icon.name: "overflow-menu"
                enabled: !card.busy
                Accessible.name: "Opciones de " + (card.account.label || card.providerName)
                onClicked: accountMenu.popup()
                QQC2.Menu {
                    id: accountMenu
                    QQC2.MenuItem {
                        text: "Abrir página de uso"
                        icon.name: "internet-services"
                        onTriggered: card.openRequested()
                    }
                    QQC2.MenuItem {
                        text: "Cambiar nombre"
                        icon.name: "edit-rename"
                        onTriggered: card.renameRequested()
                    }
                    QQC2.MenuItem {
                        text: card.account.provider === "antigravity" ? "Conectar con Antigravity"
                            : card.account.logged_out ? "Iniciar sesión" : "Volver a iniciar sesión"
                        icon.name: "system-switch-user"
                        onTriggered: card.loginRequested()
                    }
                    QQC2.MenuSeparator {}
                    QQC2.MenuItem {
                        visible: !card.account.logged_out
                        text: card.account.provider === "antigravity" ? "Desconectar del widget" : "Cerrar sesión"
                        icon.name: "system-log-out"
                        onTriggered: card.logoutRequested()
                    }
                    QQC2.MenuItem {
                        text: "Eliminar cuenta del widget"
                        icon.name: "edit-delete"
                        onTriggered: card.removeRequested()
                    }
                }
            }
        }

        ColumnLayout {
            id: rowsColumn
            visible: card.providerOk
            Layout.fillWidth: true
            spacing: Kirigami.Units.largeSpacing
        }

        QQC2.Label {
            visible: card.notice.length > 0 || !card.providerOk
            Layout.fillWidth: true
            wrapMode: Text.Wrap
            font: Kirigami.Theme.smallFont
            color: colors.secondary
            text: card.providerOk ? card.notice : Format.providerErrorMessage(card.providerName, card.account)
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: Kirigami.Units.smallSpacing
            Rectangle {
                Layout.preferredWidth: 6
                Layout.preferredHeight: 6
                radius: 3
                color: !card.providerOk ? colors.secondary
                    : card.account.stale ? colors.warning : colors.positive
            }
            QQC2.Label {
                Layout.fillWidth: true
                elide: Text.ElideRight
                font: Kirigami.Theme.smallFont
                color: colors.secondary
                text: card.account.logged_out ? "Sesión cerrada"
                    : card.providerOk ? Format.providerSubtitle(card.account, card.nowMs) : "Sin conexión"
            }
            QQC2.Label {
                visible: card.pinned && !card.account.logged_out
                text: "En la barra"
                font: Kirigami.Theme.smallFont
                color: colors.secondary
            }
            QQC2.Button {
                visible: !card.providerOk || card.account.stale_reason === "oauth_expired"
                    || (card.account.provider === "antigravity" && !!card.account.stale)
                text: card.account.provider === "antigravity" ? "Reconectar"
                    : card.account.logged_out ? "Conectar" : "Iniciar sesión"
                icon.name: "system-switch-user"
                enabled: !card.busy
                onClicked: card.loginRequested()
            }
        }
    }
}
