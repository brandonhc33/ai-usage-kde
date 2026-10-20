// "Configurar AI Usage… > Panel": what the panel shows next to each icon.
// Keys are declared in ../config/main.xml; Plasma binds every cfg_<key>
// property below and saves it when the dialog is applied.
import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC2
import org.kde.kirigami as Kirigami
import org.kde.kcmutils as KCM

import "../code/format.js" as Format

KCM.SimpleKCM {
    id: page
    readonly property QtObject formColors: ContrastPalette { id: colors }

    property string cfg_panelPreset
    property string cfg_resetTimeFormat
    property alias cfg_panelTemplate: templateField.text
    property alias cfg_showWeekly: showWeeklyBox.checked
    property alias cfg_showWeeklyReset: showWeeklyResetBox.checked
    property alias cfg_twoLines: twoLinesBox.checked
    property alias cfg_panelBold: panelBoldBox.checked
    property alias cfg_showMoney: showMoneyBox.checked
    property string cfg_idleWindow
    property alias cfg_showCodex: showCodexBox.checked
    property alias cfg_showClaude: showClaudeBox.checked
    property alias cfg_showAntigravity: showAntigravityBox.checked
    property alias cfg_showAccountNames: showAccountNamesBox.checked
    property alias cfg_refreshMinutes: refreshSpin.value

    readonly property bool custom: cfg_panelPreset === "custom"
    readonly property bool showsReset: cfg_panelPreset === "time"
        || cfg_panelPreset === "used_time" || cfg_panelPreset === "remaining_time"
    readonly property string preview: Format.panelPreview({
        preset: cfg_panelPreset,
        resetTimeFormat: cfg_resetTimeFormat,
        template: cfg_panelTemplate,
        showWeekly: cfg_showWeekly,
        showWeeklyReset: cfg_showWeeklyReset,
        twoLines: cfg_twoLines,
        showMoney: cfg_showMoney,
        idleWindow: cfg_idleWindow,
        showCodex: cfg_showCodex,
        showClaude: cfg_showClaude
    }, Date.now())

    Kirigami.FormLayout {
        QQC2.ComboBox {
            id: presetCombo
            Kirigami.FormData.label: "Mostrar en el panel:"
            textRole: "text"
            valueRole: "value"
            model: [
                { value: "used", text: "% usado" },
                { value: "remaining", text: "% restante" },
                { value: "time", text: "Reinicio de sesión" },
                { value: "used_time", text: "% usado + reinicio" },
                { value: "remaining_time", text: "% restante + reinicio" },
                { value: "custom", text: "Personalizado" }
            ]
            onActivated: page.cfg_panelPreset = currentValue
            Component.onCompleted: currentIndex = Math.max(0, indexOfValue(page.cfg_panelPreset))
        }

        QQC2.ComboBox {
            id: resetTimeCombo
            visible: !page.custom
            enabled: page.showsReset
            Kirigami.FormData.label: "Mostrar reinicio como:"
            textRole: "text"
            valueRole: "value"
            model: [
                { value: "duration", text: "Tiempo restante (3h56)" },
                { value: "clock", text: "Hora del reinicio (17:24)" },
                { value: "both", text: "Tiempo + hora (3h56 · 17:24)" }
            ]
            currentIndex: Math.max(0, indexOfValue(page.cfg_resetTimeFormat))
            onActivated: page.cfg_resetTimeFormat = currentValue
        }

        QQC2.TextField {
            id: templateField
            visible: page.custom
            Kirigami.FormData.label: "Plantilla:"
            Layout.fillWidth: true
            placeholderText: "{used} · {reset_in}"
        }
        QQC2.Label {
            visible: page.custom
            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 24
            wrapMode: Text.Wrap
            font: Kirigami.Theme.smallFont
            color: colors.secondary
            text: "Ventana corta (5 h / sesión): {used} {left} {reset_in} {reset_at}\n"
                + "Semanal: {w_used} {w_left} {w_reset_in} {w_reset_day}\n"
                + "Créditos: {money} · Segunda línea: \\n"
        }

        QQC2.CheckBox {
            id: showWeeklyBox
            enabled: !page.custom
            Kirigami.FormData.label: "Semanal:"
            text: "Mostrar también el % semanal"
        }
        QQC2.CheckBox {
            id: showWeeklyResetBox
            enabled: !page.custom
            text: "Mostrar día y hora del reinicio semanal"
        }
        QQC2.CheckBox {
            id: twoLinesBox
            enabled: !page.custom && (showWeeklyBox.checked || showWeeklyResetBox.checked)
            text: "Usar una segunda línea para el semanal"
        }

        QQC2.CheckBox {
            id: panelBoldBox
            Kirigami.FormData.label: "Texto de la barra:"
            text: "Usar negrita"
        }

        QQC2.CheckBox {
            id: showMoneyBox
            enabled: !page.custom
            Kirigami.FormData.label: "Créditos:"
            text: "Mostrar crédito disponible"
        }

        QQC2.ComboBox {
            id: idleCombo
            Kirigami.FormData.label: "Sesión sin iniciar:"
            textRole: "text"
            valueRole: "value"
            model: [
                { value: "dim", text: "Mostrarla atenuada" },
                { value: "weekly", text: "Mostrar el semanal en su lugar" }
            ]
            onActivated: page.cfg_idleWindow = currentValue
            Component.onCompleted: currentIndex = Math.max(0, indexOfValue(page.cfg_idleWindow))
        }

        QQC2.Label {
            Kirigami.FormData.label: "Vista previa:"
            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 24
            wrapMode: Text.Wrap
            font.family: "monospace"
            font.bold: page.cfg_panelBold
            text: page.preview
        }

        Kirigami.Separator {
            Kirigami.FormData.isSection: true
        }

        QQC2.CheckBox {
            id: showCodexBox
            Kirigami.FormData.label: "Proveedores:"
            text: "Codex"
        }
        QQC2.CheckBox {
            id: showClaudeBox
            text: "Claude"
        }
        QQC2.CheckBox {
            id: showAntigravityBox
            text: "Google Antigravity"
        }
        QQC2.CheckBox {
            id: showAccountNamesBox
            Kirigami.FormData.label: "Cuentas:"
            text: "Mostrar el nombre cuando haya varias del mismo proveedor"
        }
        QQC2.Label {
            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 24
            wrapMode: Text.Wrap
            font: Kirigami.Theme.smallFont
            text: "Abre el widget y usa la chincheta de cada cuenta para elegir cuáles aparecen en la barra. El desplegable siempre muestra todas."
        }

        RowLayout {
            Kirigami.FormData.label: "Actualizar cada:"
            QQC2.SpinBox {
                id: refreshSpin
                from: 0
                to: 60
            }
            QQC2.Label {
                text: refreshSpin.value === 0 ? "solo el timer de systemd" : "min"
            }
        }
    }
}
