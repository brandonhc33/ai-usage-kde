// AI Usage — plasmoide KDE Plasma 6.
//
// Puerto de ai-usage/src/app.rs (applet COSMIC) a QML. Este archivo es la
// única capa "con estado": hace polling de status.json/collector.lock cada
// 5 s mediante el Data Engine de KDE y delega todo el
// formateo/severidad a las funciones puras de ../code/format.js y
// ../code/status.js. Nunca scrapea ni hace login: solo lee los snapshots y
// lanza ai-usage-collect / ai-usage-auth / ai-usage-clear-errors / xdg-open
// vía el motor "executable" de Plasma5Support (ver docs/06-kde-plasmoid-ui.md).
import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC2
import Qt.labs.platform as Platform
import org.kde.kirigami as Kirigami
import org.kde.plasma.plasmoid
import org.kde.plasma.components as PlasmaComponents3
import org.kde.plasma.extras as PlasmaExtras
import org.kde.plasma.plasma5support as P5Support

import "../code/format.js" as Format
import "../code/status.js" as Status

PlasmoidItem {
    id: root

    readonly property string codexUsageUrl: "https://chatgpt.com/codex/settings/usage"
    readonly property string claudeUsageUrl: "https://claude.ai/new#settings/usage"

    readonly property string homeDir: {
        var url = Platform.StandardPaths.writableLocation(Platform.StandardPaths.HomeLocation).toString();
        return decodeURIComponent(url.replace(/^file:\/\/(localhost)?/, ""));
    }
    readonly property string statusPath: homeDir + "/.cache/ai-usage-status/status.json"
    readonly property string lockPath: homeDir + "/.cache/ai-usage-status/collector.lock"
    readonly property string errorLogPath: homeDir + "/.cache/ai-usage-status/errors.log"

    property var statusState: ({ kind: "missing", data: null })
    property bool collectorRunningFlag: false
    property bool loading: false
    readonly property bool isLoading: loading || collectorRunningFlag
    readonly property bool errorLogHasEntries: errorLogSize > 0
    readonly property bool hasActiveErrors: statusState.kind === "loaded"
        && statusState.data.errors && statusState.data.errors.length > 0
    property int errorLogSize: 0

    readonly property var topbarEntries: Format.topbarEntries(statusState)

    toolTipMainText: "AI Usage"
    toolTipSubText: topbarEntries.map(function (e) { return e.tooltip; }).join("\n")

    Plasmoid.icon: Qt.resolvedUrl("../icons/ai-orb.svg")

    // --- File I/O -------------------------------------------------------
    // Qt 6 blocks XMLHttpRequest against file:// unless plasmashell receives
    // QML_XHR_ALLOW_FILE_READ. Using KDE's executable Data Engine keeps the
    // widget self-contained and works with Plasma's normal environment.

    function shellQuote(value) {
        return "'" + String(value).replace(/'/g, "'\\''") + "'";
    }

    readonly property string readStatusCmd: "/usr/bin/cat -- " + shellQuote(statusPath)
    readonly property string readLockCmd: "/usr/bin/cat -- " + shellQuote(lockPath)
    readonly property string readErrorSizeCmd: "/usr/bin/stat --format=%s -- " + shellQuote(errorLogPath)

    P5Support.DataSource {
        id: fileReader
        engine: "executable"
        interval: 5000
        connectedSources: [root.readStatusCmd, root.readLockCmd, root.readErrorSizeCmd]

        onNewData: (sourceName, data) => {
            const succeeded = Number(data["exit code"]) === 0;
            const output = data.stdout === undefined ? "" : String(data.stdout);

            if (sourceName === root.readStatusCmd) {
                root.statusState = Status.parseStatusFile(succeeded, output);
            } else if (sourceName === root.readLockCmd) {
                root.collectorRunningFlag = Status.collectorRunning(succeeded, output);
            } else if (sourceName === root.readErrorSizeCmd) {
                const size = Number(output.trim());
                root.errorLogSize = succeeded && Number.isFinite(size) ? size : 0;
            }
        }

        function refresh() {
            updateAllSources();
        }
    }

    function reload() {
        fileReader.refresh();
    }

    // --- External processes --------------------------------------------
    // The plasmoid never scrapes or logs in itself; it only launches the
    // external collector/auth scripts, same boundary as the COSMIC applet
    // (see docs/02-architecture.md in the sibling ai-usage project).

    // Plasma corre el motor "executable" con el PATH del propio proceso
    // plasmashell (normalmente sin ~/.local/bin), así que estos tres scripts
    // se invocan por ruta absoluta en vez de confiar en la resolución de PATH.
    readonly property string localBinDir: homeDir + "/.local/bin"
    readonly property string collectCmd: localBinDir + "/ai-usage-collect"
    readonly property string clearErrorsCmd: localBinDir + "/ai-usage-clear-errors"

    P5Support.DataSource {
        id: executable
        engine: "executable"
        connectedSources: []
        onNewData: (sourceName, data) => {
            disconnectSource(sourceName);
            if (sourceName === root.collectCmd) {
                root.loading = false;
                root.reload();
            } else if (sourceName === root.clearErrorsCmd) {
                root.reload();
            }
        }
        function exec(cmd) {
            connectSource(cmd);
        }
    }

    function runCollector() {
        if (root.isLoading) return;
        root.loading = true;
        executable.exec(root.collectCmd);
    }

    function runLogin(provider) {
        executable.exec(root.localBinDir + "/ai-usage-auth " + provider);
    }

    function openLink(url) {
        executable.exec("xdg-open " + shellQuote(url));
    }

    function openErrorLog() {
        executable.exec("xdg-open " + shellQuote(root.errorLogPath));
    }

    function clearErrors() {
        if (root.isLoading) return;
        executable.exec(root.clearErrorsCmd);
    }

    function sessionActive(provider) {
        if (root.statusState.kind !== "loaded") return false;
        var data = root.statusState.data[provider];
        if (!data) return false;
        return Format.isSessionActive(data.ok, data.error_code);
    }

    function providerAction(provider, url) {
        if (sessionActive(provider)) {
            openLink(url);
        } else {
            runLogin(provider);
        }
    }

    function iconSource(kind) {
        return Qt.resolvedUrl("../icons/" + kind + "-orb.svg");
    }

    // --- Compact representation (panel button) --------------------------

    compactRepresentation: MouseArea {
        id: compactRoot
        hoverEnabled: true
        Layout.minimumWidth: compactRow.implicitWidth + Kirigami.Units.smallSpacing * 2
        Layout.minimumHeight: Kirigami.Units.iconSizes.small + Kirigami.Units.smallSpacing * 2
        Layout.preferredWidth: compactRow.implicitWidth + Kirigami.Units.smallSpacing * 2

        onClicked: root.expanded = !root.expanded

        RowLayout {
            id: compactRow
            anchors.centerIn: parent
            spacing: Kirigami.Units.smallSpacing

            Repeater {
                model: root.topbarEntries
                delegate: RowLayout {
                    spacing: 4
                    Kirigami.Icon {
                        source: root.iconSource(modelData.icon)
                        Layout.preferredWidth: Kirigami.Units.iconSizes.small
                        Layout.preferredHeight: Kirigami.Units.iconSizes.small
                    }
                    QQC2.Label {
                        text: modelData.label
                        color: Format.severityColor(modelData.severity)
                    }
                }
            }

            PlasmaComponents3.BusyIndicator {
                visible: root.isLoading
                running: visible
                Layout.preferredWidth: Kirigami.Units.iconSizes.small
                Layout.preferredHeight: Kirigami.Units.iconSizes.small
            }
        }
    }

    // --- Full representation (popup) -------------------------------------

    fullRepresentation: ColumnLayout {
        id: fullRoot
        Layout.preferredWidth: Kirigami.Units.gridUnit * 22
        Layout.minimumWidth: Kirigami.Units.gridUnit * 20
        Layout.margins: Kirigami.Units.largeSpacing

        spacing: Kirigami.Units.largeSpacing

        PlasmaExtras.Heading {
            level: 3
            text: "AI Usage"
        }

        // Missing status.json
        ColumnLayout {
            visible: root.statusState.kind === "missing"
            Layout.fillWidth: true
            spacing: Kirigami.Units.smallSpacing

            QQC2.Label {
                Layout.fillWidth: true
                wrapMode: Text.Wrap
                text: "No se encontró ~/.cache/ai-usage-status/status.json"
            }
            QQC2.Label {
                Layout.fillWidth: true
                wrapMode: Text.Wrap
                opacity: 0.7
                font: Kirigami.Theme.smallFont
                text: "Ejecuta ai-usage-collect para generar datos."
            }
        }

        // Invalid status.json
        QQC2.Label {
            visible: root.statusState.kind === "invalid"
            Layout.fillWidth: true
            wrapMode: Text.Wrap
            text: "status.json existe pero no es válido."
        }

        // Loaded status
        ColumnLayout {
            id: loadedColumn
            visible: root.statusState.kind === "loaded"
            Layout.fillWidth: true
            spacing: Kirigami.Units.largeSpacing

            QQC2.Label {
                Layout.fillWidth: true
                wrapMode: Text.Wrap
                opacity: 0.7
                font: Kirigami.Theme.smallFont
                text: root.statusState.kind === "loaded" ? Format.updatedAtLine(root.statusState.data) : ""
            }

            // Codex card
            ColumnLayout {
                Layout.fillWidth: true
                visible: root.statusState.kind === "loaded" && !!root.statusState.data.codex
                spacing: Kirigami.Units.smallSpacing

                RowLayout {
                    spacing: Kirigami.Units.smallSpacing
                    Kirigami.Icon {
                        source: root.iconSource("codex")
                        Layout.preferredWidth: Kirigami.Units.iconSizes.small
                        Layout.preferredHeight: Kirigami.Units.iconSizes.small
                    }
                    PlasmaExtras.Heading {
                        level: 5
                        text: "Codex"
                    }
                }

                ColumnLayout {
                    visible: root.statusState.kind === "loaded" && !!root.statusState.data.codex && root.statusState.data.codex.ok
                    Layout.fillWidth: true
                    Layout.leftMargin: Kirigami.Units.largeSpacing
                    spacing: Kirigami.Units.smallSpacing

                    MetricRow {
                        visible: root.statusState.kind === "loaded" && !!root.statusState.data.codex
                            && !!root.statusState.data.codex.five_hour
                        Layout.fillWidth: true
                        label: "5 horas"
                        metric: root.statusState.kind === "loaded" && root.statusState.data.codex ? root.statusState.data.codex.five_hour : null
                        thresholds: root.statusState.kind === "loaded" ? root.statusState.data.thresholds : null
                    }
                    MetricRow {
                        visible: root.statusState.kind === "loaded" && !!root.statusState.data.codex
                            && !!root.statusState.data.codex.weekly
                        Layout.fillWidth: true
                        label: "Semanal"
                        metric: root.statusState.kind === "loaded" && root.statusState.data.codex ? root.statusState.data.codex.weekly : null
                        thresholds: root.statusState.kind === "loaded" ? root.statusState.data.thresholds : null
                    }
                    RowLayout {
                        visible: root.statusState.kind === "loaded" && !!root.statusState.data.codex
                            && root.statusState.data.codex.credits_remaining !== null
                            && root.statusState.data.codex.credits_remaining !== undefined
                        spacing: Kirigami.Units.smallSpacing
                        QQC2.Label { text: "Créditos"; Layout.preferredWidth: Kirigami.Units.gridUnit * 4 }
                        QQC2.Label {
                            text: root.statusState.kind === "loaded" && root.statusState.data.codex
                                ? Format.credits(root.statusState.data.codex.credits_remaining) : "--"
                        }
                    }
                }

                QQC2.Label {
                    visible: root.statusState.kind === "loaded" && !!root.statusState.data.codex && !root.statusState.data.codex.ok
                    Layout.leftMargin: Kirigami.Units.largeSpacing
                    opacity: 0.7
                    font: Kirigami.Theme.smallFont
                    text: "No se obtuvo la información."
                }
            }

            // Claude card
            ColumnLayout {
                Layout.fillWidth: true
                visible: root.statusState.kind === "loaded" && !!root.statusState.data.claude
                spacing: Kirigami.Units.smallSpacing

                RowLayout {
                    spacing: Kirigami.Units.smallSpacing
                    Kirigami.Icon {
                        source: root.iconSource("claude")
                        Layout.preferredWidth: Kirigami.Units.iconSizes.small
                        Layout.preferredHeight: Kirigami.Units.iconSizes.small
                    }
                    PlasmaExtras.Heading {
                        level: 5
                        text: "Claude"
                    }
                }

                ColumnLayout {
                    visible: root.statusState.kind === "loaded" && !!root.statusState.data.claude && root.statusState.data.claude.ok
                    Layout.fillWidth: true
                    Layout.leftMargin: Kirigami.Units.largeSpacing
                    spacing: Kirigami.Units.smallSpacing

                    MetricRow {
                        Layout.fillWidth: true
                        label: "Sesión"
                        metric: root.statusState.kind === "loaded" && root.statusState.data.claude ? root.statusState.data.claude.session : null
                        thresholds: root.statusState.kind === "loaded" ? root.statusState.data.thresholds : null
                    }
                    MetricRow {
                        Layout.fillWidth: true
                        label: "Semanal"
                        metric: root.statusState.kind === "loaded" && root.statusState.data.claude ? root.statusState.data.claude.weekly : null
                        thresholds: root.statusState.kind === "loaded" ? root.statusState.data.thresholds : null
                    }
                    RowLayout {
                        visible: root.statusState.kind === "loaded" && !!root.statusState.data.claude
                            && !!root.statusState.data.claude.daily_routines
                            && root.statusState.data.claude.daily_routines.used !== null
                            && root.statusState.data.claude.daily_routines.limit !== null
                        spacing: Kirigami.Units.smallSpacing
                        QQC2.Label { text: "Rutinas"; Layout.preferredWidth: Kirigami.Units.gridUnit * 4 }
                        QQC2.Label {
                            text: root.statusState.kind === "loaded" && root.statusState.data.claude
                                ? Format.routines(root.statusState.data.claude.daily_routines) : "--"
                        }
                    }
                    MetricRow {
                        visible: root.statusState.kind === "loaded" && !!root.statusState.data.claude
                            && !!root.statusState.data.claude.routines
                        Layout.fillWidth: true
                        label: "Rutinas"
                        metric: root.statusState.kind === "loaded" && root.statusState.data.claude
                            ? root.statusState.data.claude.routines : null
                        thresholds: root.statusState.kind === "loaded" ? root.statusState.data.thresholds : null
                    }

                    // "Créditos de uso" — solo si la cuenta tiene pago por uso habilitado.
                    ColumnLayout {
                        visible: root.statusState.kind === "loaded" && !!root.statusState.data.claude && !!root.statusState.data.claude.credits
                        Layout.fillWidth: true
                        spacing: Kirigami.Units.smallSpacing

                        Kirigami.Separator { Layout.fillWidth: true }
                        QQC2.Label {
                            opacity: 0.7
                            font: Kirigami.Theme.smallFont
                            text: "Créditos de uso"
                        }
                        RowLayout {
                            spacing: Kirigami.Units.smallSpacing
                            QQC2.Label { text: "Gasto"; Layout.preferredWidth: Kirigami.Units.gridUnit * 4 }
                            QQC2.Label {
                                text: root.statusState.kind === "loaded" && root.statusState.data.claude && root.statusState.data.claude.credits
                                    ? Format.creditsSpent(root.statusState.data.claude.credits) : "--"
                                color: root.statusState.kind === "loaded" && root.statusState.data.claude && root.statusState.data.claude.credits
                                    ? Format.severityColor(Format.creditsSeverity(root.statusState.data.claude.credits,
                                        root.statusState.data.thresholds)) : Format.COLOR_MUTED
                            }
                        }
                        RowLayout {
                            spacing: Kirigami.Units.smallSpacing
                            QQC2.Label { text: "Saldo/límite"; Layout.preferredWidth: Kirigami.Units.gridUnit * 4 }
                            QQC2.Label {
                                text: root.statusState.kind === "loaded" && root.statusState.data.claude && root.statusState.data.claude.credits
                                    ? Format.creditsBalance(root.statusState.data.claude.credits) : "--"
                            }
                        }
                        QQC2.Label {
                            visible: root.statusState.kind === "loaded" && !!root.statusState.data.claude && !!root.statusState.data.claude.credits
                                && !!root.statusState.data.claude.credits.reset_label
                            font: Kirigami.Theme.smallFont
                            color: Format.RESET_LABEL_COLOR
                            text: root.statusState.kind === "loaded" && root.statusState.data.claude && root.statusState.data.claude.credits
                                ? ("reinicia " + root.statusState.data.claude.credits.reset_label) : ""
                        }
                    }
                }

                QQC2.Label {
                    visible: root.statusState.kind === "loaded" && !!root.statusState.data.claude && !root.statusState.data.claude.ok
                    Layout.leftMargin: Kirigami.Units.largeSpacing
                    opacity: 0.7
                    font: Kirigami.Theme.smallFont
                    text: "No se obtuvo la información."
                }
            }

            // Error panel
            ColumnLayout {
                visible: root.hasActiveErrors
                Layout.fillWidth: true
                spacing: Kirigami.Units.smallSpacing

                QQC2.Label {
                    Layout.fillWidth: true
                    wrapMode: Text.Wrap
                    font: Kirigami.Theme.smallFont
                    text: "No se obtuvo la información. Se mantuvo la última lectura disponible."
                }
                QQC2.Label {
                    Layout.fillWidth: true
                    wrapMode: Text.Wrap
                    font: Kirigami.Theme.smallFont
                    opacity: 0.7
                    text: "Detalles: ~/.cache/ai-usage-status/errors.log"
                }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: Kirigami.Units.smallSpacing
                    QQC2.Button {
                        Layout.fillWidth: true
                        text: "Abrir registro"
                        onClicked: root.openErrorLog()
                    }
                    QQC2.Button {
                        Layout.fillWidth: true
                        text: "Limpiar error"
                        enabled: !root.isLoading
                        onClicked: root.clearErrors()
                    }
                }
            }
        }

        Kirigami.Separator { Layout.fillWidth: true }

        // Actions
        ColumnLayout {
            Layout.fillWidth: true
            spacing: Kirigami.Units.smallSpacing

            RowLayout {
                Layout.fillWidth: true
                spacing: Kirigami.Units.smallSpacing

                QQC2.Button {
                    Layout.fillWidth: true
                    text: root.isLoading ? "Actualizando…" : "Actualizar ahora"
                    enabled: !root.isLoading
                    onClicked: root.runCollector()
                }
                PlasmaComponents3.BusyIndicator {
                    visible: root.isLoading
                    running: visible
                    Layout.preferredWidth: Kirigami.Units.iconSizes.small
                    Layout.preferredHeight: Kirigami.Units.iconSizes.small
                }
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: Kirigami.Units.smallSpacing

                QQC2.Button {
                    Layout.fillWidth: true
                    text: root.sessionActive("codex") ? "Ir a Codex" : "Iniciar sesión Codex"
                    onClicked: root.providerAction("codex", root.codexUsageUrl)
                }
                QQC2.Button {
                    Layout.fillWidth: true
                    text: root.sessionActive("claude") ? "Ir a Claude" : "Iniciar sesión Claude"
                    onClicked: root.providerAction("claude", root.claudeUsageUrl)
                }
            }

            QQC2.Button {
                visible: root.errorLogHasEntries && !root.hasActiveErrors
                Layout.fillWidth: true
                flat: true
                text: "Ver historial de errores"
                onClicked: root.openErrorLog()
            }
        }
    }
}
