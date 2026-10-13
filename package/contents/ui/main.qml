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
import org.kde.plasma.core as PlasmaCore
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
    // Raw status.json read; statusState is only replaced when it changes so
    // the UI does not rebuild every five seconds.
    property string statusReadKey: ""
    property bool collectorRunningFlag: false
    property bool loading: false
    property bool autoCollecting: false
    property bool collectorLaunchFailed: false
    readonly property bool isLoading: loading || collectorRunningFlag
    readonly property bool errorLogHasEntries: errorLogSize > 0
    readonly property bool hasActiveErrors: statusState.kind === "loaded"
        && statusState.data.errors && statusState.data.errors.length > 0
    property int errorLogSize: 0

    // Single clock for every countdown ("3h56", "hace 2 min").
    property double nowMs: Date.now()

    readonly property var status: statusState.kind === "loaded" ? statusState.data : null
    readonly property var codex: status && status.codex ? status.codex : null
    readonly property var claude: status && status.claude ? status.claude : null
    readonly property var thresholds: status ? status.thresholds : null
    readonly property var claudeBilling: Format.billingOf(claude)
    readonly property bool codexCreditsVisible: !!codex && codex.ok === true
        && (!!codex.credits || !!codex.reset_credits
            || (codex.credits_remaining !== null && codex.credits_remaining !== undefined))

    readonly property var panelOptions: ({
        preset: Plasmoid.configuration.panelPreset,
        resetTimeFormat: Plasmoid.configuration.resetTimeFormat,
        template: Plasmoid.configuration.panelTemplate,
        showWeekly: Plasmoid.configuration.showWeekly,
        showWeeklyReset: Plasmoid.configuration.showWeeklyReset,
        twoLines: Plasmoid.configuration.twoLines,
        showMoney: Plasmoid.configuration.showMoney,
        idleWindow: Plasmoid.configuration.idleWindow,
        showCodex: Plasmoid.configuration.showCodex,
        showClaude: Plasmoid.configuration.showClaude,
        stacked: Plasmoid.formFactor === PlasmaCore.Types.Vertical
    })
    readonly property var topbarEntries: Format.panelEntries(statusState, panelOptions, nowMs)

    toolTipMainText: "AI Usage"
    toolTipSubText: Format.tooltipText(statusState, nowMs)

    Plasmoid.icon: Qt.resolvedUrl("../icons/ai-orb.svg")

    // --- File I/O -------------------------------------------------------
    // Qt 6 blocks XMLHttpRequest against file:// unless plasmashell receives
    // QML_XHR_ALLOW_FILE_READ. Using KDE's executable Data Engine keeps the
    // widget self-contained and works with Plasma's normal environment.

    function shellQuote(value) {
        return "'" + String(value).replace(/'/g, "'\\''") + "'";
    }

    function localFilePath(url) {
        return decodeURIComponent(String(url).replace(/^file:\/\/(localhost)?/, ""));
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
                const key = (succeeded ? "1:" : "0:") + output;
                if (key !== root.statusReadKey) {
                    root.statusReadKey = key;
                    root.statusState = Status.parseStatusFile(succeeded, output);
                    root.nowMs = Date.now();
                }
            } else if (sourceName === root.readLockCmd) {
                root.collectorRunningFlag = Status.collectorRunning(succeeded, output);
            } else if (sourceName === root.readErrorSizeCmd) {
                const size = Number(output.trim());
                root.errorLogSize = succeeded && Number.isFinite(size) ? size : 0;
            }
        }

        function refresh() {
            // DataSource has no public updateAllSources() in Plasma 6. Force
            // an immediate refresh by reconnecting the three file commands;
            // the normal five-second interval remains active afterwards.
            var sources = [root.readStatusCmd, root.readLockCmd, root.readErrorSizeCmd];
            sources.forEach(function (source) { disconnectSource(source); });
            sources.forEach(function (source) { connectSource(source); });
        }
    }

    function reload() {
        fileReader.refresh();
    }

    // --- External processes --------------------------------------------
    // The plasmoid never scrapes or logs in itself; it only launches the
    // external collector/auth scripts, same boundary as the COSMIC applet
    // (see docs/02-architecture.md in the sibling ai-usage project).

    // The KDE Store archive bundles the dependency-free structured collector
    // under contents/tools. A source checkout installed with install.sh keeps
    // using ~/.local/bin, which additionally provides the Playwright fallback
    // and a systemd timer.
    readonly property string localBinDir: homeDir + "/.local/bin"
    readonly property string bundledCollectPath: localFilePath(
        Qt.resolvedUrl("../tools/ai-usage-collect.mjs"))
    readonly property string bundledClearErrorsPath: localFilePath(
        Qt.resolvedUrl("../tools/ai-usage-clear-errors.mjs"))
    readonly property string installedCollectPath: localBinDir + "/ai-usage-collect"
    readonly property string installedClearErrorsPath: localBinDir + "/ai-usage-clear-errors"

    function collectCommand(args) {
        return "/bin/sh -c " + shellQuote(
            "if [ -f " + shellQuote(bundledCollectPath) + " ]; then "
            + "exec /usr/bin/env AI_USAGE_STRUCTURED_ONLY=1 node " + shellQuote(bundledCollectPath) + " " + args + "; "
            + "elif [ -x " + shellQuote(installedCollectPath) + " ]; then "
            + "exec " + shellQuote(installedCollectPath) + " " + args + "; "
            + "else exit 127; fi");
    }

    readonly property int refreshMinutes: Plasmoid.configuration.refreshMinutes
    // Manual refresh ignores the web-fallback backoff. The periodic one does
    // nothing when status.json is newer than ~one interval, e.g. because the
    // systemd timer already ran, so both schedulers do not double the work.
    readonly property string collectForceCmd: collectCommand("--force")
    readonly property string collectAutoCmd: collectCommand(
        "--if-older-than " + Math.max(30, refreshMinutes * 60 - 30))
    readonly property string clearErrorsCmd: "/bin/sh -c " + shellQuote(
        "if [ -f " + shellQuote(bundledClearErrorsPath) + " ]; then "
        + "exec /usr/bin/env node " + shellQuote(bundledClearErrorsPath) + "; "
        + "elif [ -x " + shellQuote(installedClearErrorsPath) + " ]; then "
        + "exec " + shellQuote(installedClearErrorsPath) + "; "
        + "else exit 127; fi")

    P5Support.DataSource {
        id: executable
        engine: "executable"
        connectedSources: []
        onNewData: (sourceName, data) => {
            disconnectSource(sourceName);
            if (sourceName === root.collectForceCmd || sourceName === root.collectAutoCmd) {
                root.collectorLaunchFailed = Number(data["exit code"]) !== 0;
                if (sourceName === root.collectForceCmd) {
                    root.loading = false;
                } else {
                    root.autoCollecting = false;
                }
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
        root.collectorLaunchFailed = false;
        root.loading = true;
        executable.exec(root.collectForceCmd);
    }

    // Periodic run: no busy indicator unless the collector really works
    // (collector.lock), since it usually exits at once.
    function runAutoCollector() {
        if (root.isLoading || root.autoCollecting) return;
        root.autoCollecting = true;
        executable.exec(root.collectAutoCmd);
    }

    function runLogin(provider, url) {
        var installedAuthPath = root.localBinDir + "/ai-usage-auth";
        var command = "/bin/sh -c " + shellQuote(
            "if [ -x " + shellQuote(installedAuthPath) + " ]; then "
            + "exec " + shellQuote(installedAuthPath) + " " + shellQuote(provider) + "; "
            + "else exec xdg-open " + shellQuote(url) + "; fi");
        executable.exec(command);
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
        var data = root.status ? root.status[provider] : null;
        if (!data) return false;
        return Format.isSessionActive(data.ok, data.error_code);
    }

    function providerAction(provider, url) {
        if (sessionActive(provider)) {
            openLink(url);
        } else {
            runLogin(provider, url);
        }
    }

    function iconSource(kind) {
        return Qt.resolvedUrl("../icons/" + kind + "-orb.svg");
    }

    function failedProvidersLabel() {
        if (!root.hasActiveErrors) return "";
        var names = [];
        var seen = {};
        root.statusState.data.errors.forEach(function (error) {
            var name = error.provider === "codex" ? "Codex"
                : error.provider === "claude" ? "Claude" : "el colector";
            if (!seen[name]) {
                seen[name] = true;
                names.push(name);
            }
        });
        return names.length === 1
            ? "No se pudo actualizar " + names[0] + "."
            : "No se pudieron actualizar " + names.join(" y ") + ".";
    }

    Timer {
        interval: Math.max(1, root.refreshMinutes) * 60 * 1000
        repeat: true
        running: root.refreshMinutes > 0
        triggeredOnStart: true
        onTriggered: root.runAutoCollector()
    }

    Timer {
        interval: 30 * 1000
        repeat: true
        running: true
        onTriggered: root.nowMs = Date.now()
    }

    // --- Compact representation (panel button) --------------------------

    compactRepresentation: MouseArea {
        id: compactRoot

        readonly property bool vertical: Plasmoid.formFactor === PlasmaCore.Types.Vertical

        hoverEnabled: true
        Layout.minimumWidth: vertical ? -1 : compactGrid.implicitWidth + Kirigami.Units.smallSpacing * 2
        Layout.preferredWidth: Layout.minimumWidth
        Layout.minimumHeight: vertical
            ? compactGrid.implicitHeight + Kirigami.Units.smallSpacing * 2
            : Kirigami.Units.iconSizes.small + Kirigami.Units.smallSpacing * 2
        Layout.preferredHeight: vertical ? Layout.minimumHeight : -1

        onClicked: root.expanded = !root.expanded

        GridLayout {
            id: compactGrid
            anchors.centerIn: parent
            columns: compactRoot.vertical ? 1 : root.topbarEntries.length + 1
            columnSpacing: Kirigami.Units.smallSpacing
            rowSpacing: Kirigami.Units.smallSpacing

            Repeater {
                model: root.topbarEntries
                delegate: GridLayout {
                    id: entry

                    readonly property bool compactFont: modelData.lines.length > 1 || compactRoot.vertical

                    columns: compactRoot.vertical ? 1 : 2
                    columnSpacing: 4
                    rowSpacing: 0

                    Kirigami.Icon {
                        source: root.iconSource(modelData.icon)
                        Layout.alignment: Qt.AlignCenter
                        Layout.preferredWidth: Kirigami.Units.iconSizes.small
                        Layout.preferredHeight: Kirigami.Units.iconSizes.small
                    }

                    ColumnLayout {
                        spacing: 0
                        Layout.alignment: compactRoot.vertical ? Qt.AlignHCenter : Qt.AlignVCenter

                        Repeater {
                            model: modelData.lines
                            delegate: Row {
                                Layout.alignment: compactRoot.vertical ? Qt.AlignHCenter : Qt.AlignLeft

                                // SeverityText keeps its color even when a panel
                                // themer recolors the widget's text.
                                Repeater {
                                    model: modelData
                                    delegate: SeverityText {
                                        text: modelData.text
                                        severity: modelData.severity
                                        font: entry.compactFont
                                            ? Kirigami.Theme.smallFont : Kirigami.Theme.defaultFont
                                    }
                                }
                            }
                        }
                    }
                }
            }

            PlasmaComponents3.BusyIndicator {
                visible: root.isLoading
                running: visible
                Layout.alignment: Qt.AlignCenter
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

        RowLayout {
            Layout.fillWidth: true
            spacing: Kirigami.Units.largeSpacing

            Kirigami.Icon {
                source: root.iconSource("ai")
                Layout.preferredWidth: Kirigami.Units.iconSizes.medium
                Layout.preferredHeight: Kirigami.Units.iconSizes.medium
            }

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 0

                PlasmaExtras.Heading {
                    level: 3
                    text: "AI Usage"
                }
                QQC2.Label {
                    visible: root.statusState.kind === "loaded"
                    Layout.fillWidth: true
                    wrapMode: Text.Wrap
                    opacity: 0.7
                    font: Kirigami.Theme.smallFont
                    text: root.status ? Format.updatedAtLine(root.status, root.nowMs) : ""
                }
            }

            PlasmaComponents3.BusyIndicator {
                visible: root.isLoading
                running: visible
                Layout.preferredWidth: Kirigami.Units.iconSizes.smallMedium
                Layout.preferredHeight: Kirigami.Units.iconSizes.smallMedium
            }
        }

        // Missing status.json
        Kirigami.AbstractCard {
            visible: root.statusState.kind === "missing"
            Layout.fillWidth: true

            contentItem: ColumnLayout {
                spacing: Kirigami.Units.smallSpacing

                PlasmaExtras.Heading {
                    level: 5
                    text: "Esperando datos"
                }
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
                    text: root.collectorLaunchFailed
                        ? "No se pudo iniciar el colector. Instala Node.js 18 o posterior."
                        : "La primera lectura se generará automáticamente."
                }
            }
        }

        // Invalid status.json
        Kirigami.AbstractCard {
            visible: root.statusState.kind === "invalid"
            Layout.fillWidth: true

            contentItem: QQC2.Label {
                wrapMode: Text.Wrap
                text: "status.json existe pero no es válido."
            }
        }

        // Loaded status
        ColumnLayout {
            id: loadedColumn
            visible: root.statusState.kind === "loaded"
            Layout.fillWidth: true
            spacing: Kirigami.Units.largeSpacing

            ProviderCard {
                Layout.fillWidth: true
                visible: !!root.codex
                title: "Codex"
                iconSource: root.iconSource("codex")
                provider: root.codex
                nowMs: root.nowMs

                MetricRow {
                    visible: !!root.codex && !!root.codex.five_hour
                    Layout.fillWidth: true
                    label: "5 horas"
                    metric: root.codex ? root.codex.five_hour : null
                    thresholds: root.thresholds
                    nowMs: root.nowMs
                }
                MetricRow {
                    visible: !!root.codex && !!root.codex.weekly
                    Layout.fillWidth: true
                    label: "Semanal"
                    metric: root.codex ? root.codex.weekly : null
                    thresholds: root.thresholds
                    nowMs: root.nowMs
                }
                ColumnLayout {
                    visible: root.codexCreditsVisible
                    Layout.fillWidth: true
                    spacing: Kirigami.Units.smallSpacing

                    Kirigami.Separator { Layout.fillWidth: true }

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: Kirigami.Units.smallSpacing
                        QQC2.Label {
                            text: "Créditos"
                            font.weight: Font.DemiBold
                        }
                        Text {
                            Layout.fillWidth: true
                            horizontalAlignment: Text.AlignRight
                            wrapMode: Text.Wrap
                            font: Kirigami.Theme.defaultFont
                            color: Format.codexHasCredits(root.codex) ? Format.COLOR_NORMAL : Format.COLOR_MUTED
                            text: !root.codex ? ""
                                : root.codex.credits ? Format.codexCreditsLine(root.codex.credits)
                                : Format.codexCreditsLine({ balance: root.codex.credits_remaining })
                        }
                    }
                    Text {
                        visible: !!root.codex && !!root.codex.reset_credits
                        Layout.fillWidth: true
                        wrapMode: Text.Wrap
                        font: Kirigami.Theme.smallFont
                        color: Format.RESET_LABEL_COLOR
                        text: root.codex && root.codex.reset_credits
                            ? Format.resetCreditsLine(root.codex.reset_credits) : ""
                    }
                }
            }

            ProviderCard {
                Layout.fillWidth: true
                visible: !!root.claude
                title: "Claude"
                iconSource: root.iconSource("claude")
                provider: root.claude
                nowMs: root.nowMs

                MetricRow {
                    visible: !!root.claude && !!root.claude.session
                    Layout.fillWidth: true
                    label: "Sesión"
                    metric: root.claude ? root.claude.session : null
                    thresholds: root.thresholds
                    nowMs: root.nowMs
                }
                MetricRow {
                    visible: !!root.claude && !!root.claude.weekly
                    Layout.fillWidth: true
                    label: "Semanal"
                    metric: root.claude ? root.claude.weekly : null
                    thresholds: root.thresholds
                    nowMs: root.nowMs
                }
                RowLayout {
                    visible: !!root.claude && !!root.claude.daily_routines
                        && root.claude.daily_routines.used !== null
                        && root.claude.daily_routines.limit !== null
                    spacing: Kirigami.Units.smallSpacing
                    QQC2.Label {
                        text: "Rutinas"
                        Layout.preferredWidth: Kirigami.Units.gridUnit * 4
                    }
                    QQC2.Label {
                        text: root.claude ? Format.routines(root.claude.daily_routines) : "--"
                    }
                }
                MetricRow {
                    visible: !!root.claude && !!root.claude.routines
                    Layout.fillWidth: true
                    label: "Rutinas"
                    metric: root.claude ? root.claude.routines : null
                    thresholds: root.thresholds
                    nowMs: root.nowMs
                }
                QQC2.Label {
                    readonly property string breakdown: root.claude
                        ? Format.breakdownLine(root.claude.weekly_breakdown) : ""
                    visible: breakdown.length > 0
                    Layout.fillWidth: true
                    wrapMode: Text.Wrap
                    opacity: 0.7
                    font: Kirigami.Theme.smallFont
                    text: breakdown
                }
                ColumnLayout {
                    id: claudeCredits
                    visible: !!root.claudeBilling
                    Layout.fillWidth: true
                    spacing: Kirigami.Units.smallSpacing

                    // The headline is the money that can be spent; the
                    // bar is the monthly spending *limit*, which is a cap
                    // and not money.
                    readonly property color availableColor: Format.severityColor(
                        Format.availableSeverity(root.claudeBilling))
                    readonly property color limitColor: Format.severityColor(
                        Format.billingSeverity(root.claudeBilling, root.thresholds))

                    Kirigami.Separator { Layout.fillWidth: true }

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: Kirigami.Units.smallSpacing
                        QQC2.Label {
                            text: "Créditos"
                            font.weight: Font.DemiBold
                        }
                        Text {
                            Layout.fillWidth: true
                            horizontalAlignment: Text.AlignRight
                            wrapMode: Text.Wrap
                            font: Kirigami.Theme.defaultFont
                            color: claudeCredits.availableColor
                            text: root.claudeBilling ? Format.billingAvailableLine(root.claudeBilling) : ""
                        }
                    }
                    Text {
                        visible: !!root.claudeBilling && root.claudeBilling.limit !== null
                            && root.claudeBilling.limit !== undefined
                        Layout.fillWidth: true
                        wrapMode: Text.Wrap
                        font: Kirigami.Theme.smallFont
                        color: root.claudeBilling && root.claudeBilling.limit_reached
                            ? Format.COLOR_CRITICAL : Format.COLOR_MUTED
                        text: !root.claudeBilling ? ""
                            : root.claudeBilling.limit_reached
                                ? "Alcanzado · " + Format.billingSpentLine(root.claudeBilling)
                                : Format.billingSpentLine(root.claudeBilling)
                    }
                    UsageBar {
                        visible: !!root.claudeBilling && root.claudeBilling.percent !== null
                            && root.claudeBilling.percent !== undefined
                        value: root.claudeBilling ? Number(root.claudeBilling.percent) : 0
                        color: claudeCredits.limitColor
                    }
                }
            }

            // Error card
            Kirigami.AbstractCard {
                visible: root.hasActiveErrors
                Layout.fillWidth: true

                contentItem: ColumnLayout {
                    spacing: Kirigami.Units.smallSpacing

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: Kirigami.Units.smallSpacing

                        Kirigami.Icon {
                            source: "data-warning"
                            Layout.preferredWidth: Kirigami.Units.iconSizes.smallMedium
                            Layout.preferredHeight: Kirigami.Units.iconSizes.smallMedium
                        }
                        PlasmaExtras.Heading {
                            level: 5
                            text: "Actualización incompleta"
                        }
                    }
                    QQC2.Label {
                        Layout.fillWidth: true
                        wrapMode: Text.Wrap
                        text: root.failedProvidersLabel()
                            + " Los datos válidos de los demás servicios se conservaron."
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
                            icon.name: "documentinfo"
                            text: "Ver detalles"
                            onClicked: root.openErrorLog()
                        }
                        QQC2.Button {
                            Layout.fillWidth: true
                            icon.name: "view-refresh"
                            text: "Reintentar"
                            enabled: !root.isLoading
                            onClicked: root.runCollector()
                        }
                    }
                    QQC2.Button {
                        Layout.alignment: Qt.AlignHCenter
                        flat: true
                        text: "Descartar aviso"
                        enabled: !root.isLoading
                        onClicked: root.clearErrors()
                    }
                }
            }
        }

        // Actions card
        Kirigami.AbstractCard {
            Layout.fillWidth: true

            contentItem: ColumnLayout {
                spacing: Kirigami.Units.smallSpacing

                PlasmaExtras.Heading {
                    level: 5
                    text: "Acciones"
                }
                Kirigami.Separator { Layout.fillWidth: true }
                QQC2.Button {
                    visible: !root.hasActiveErrors
                    Layout.fillWidth: true
                    icon.name: "view-refresh"
                    text: root.isLoading ? "Actualizando…" : "Actualizar ahora"
                    enabled: !root.isLoading
                    highlighted: true
                    onClicked: root.runCollector()
                }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: Kirigami.Units.smallSpacing

                    QQC2.Button {
                        Layout.fillWidth: true
                        icon.source: root.iconSource("codex")
                        text: root.sessionActive("codex") ? "Ir a Codex" : "Configurar Codex"
                        onClicked: root.providerAction("codex", root.codexUsageUrl)
                    }
                    QQC2.Button {
                        Layout.fillWidth: true
                        icon.source: root.iconSource("claude")
                        text: root.sessionActive("claude") ? "Ir a Claude" : "Configurar Claude"
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
}
