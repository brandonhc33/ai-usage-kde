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
import QtQuick.Window
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
import "../code/layout.js" as PopupLayout

PlasmoidItem {
    id: root

    readonly property string codexUsageUrl: "https://chatgpt.com/codex/settings/usage"
    readonly property string claudeUsageUrl: "https://claude.ai/new#settings/usage"
    readonly property string antigravityUsageUrl: "https://antigravity.google/"

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
    readonly property bool isLoading: loading || autoCollecting || collectorRunningFlag || accountBusy
    readonly property bool errorLogHasEntries: errorLogSize > 0
    readonly property bool hasActiveErrors: statusState.kind === "loaded"
        && statusState.data.errors && statusState.data.errors.length > 0
    property int errorLogSize: 0

    // Single clock for every countdown ("3h56", "hace 2 min").
    property double nowMs: Date.now()

    readonly property var status: statusState.kind === "loaded" ? statusState.data : null
    readonly property var accounts: Format.accountsOf(status)
    readonly property var thresholds: status ? status.thresholds : null
    property bool accountBusy: false
    property string accountCommand: ""
    property string accountError: ""
    property string accountNotice: ""

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
        showAntigravity: Plasmoid.configuration.showAntigravity,
        hiddenAccountIds: Plasmoid.configuration.hiddenAccountIds,
        showAccountNames: Plasmoid.configuration.showAccountNames,
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
    readonly property string bundledAccountsPath: localFilePath(
        Qt.resolvedUrl("../tools/ai-usage-accounts.mjs"))
    readonly property string installedAccountsPath: localBinDir + "/ai-usage-accounts"
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
            } else if (sourceName === root.accountCommand) {
                root.accountBusy = false;
                root.accountCommand = "";
                if (Number(data["exit code"]) !== 0) {
                    root.accountError = String(data.stderr || "No se pudo completar la operación.").trim().slice(0, 500);
                    root.accountNotice = "";
                } else {
                    root.accountNotice = "";
                    root.runCollector();
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

    function manageAccount(args, notice) {
        if (root.isLoading) return;
        root.accountError = "";
        root.accountNotice = notice || "Guardando cambios…";
        var quotedArgs = args.map(shellQuote).join(" ");
        root.accountCommand = "/bin/sh -c " + shellQuote(
            "if [ -f " + shellQuote(bundledAccountsPath) + " ]; then "
            + "exec /usr/bin/env node " + shellQuote(bundledAccountsPath) + " " + quotedArgs + "; "
            + "elif [ -x " + shellQuote(installedAccountsPath) + " ]; then "
            + "exec " + shellQuote(installedAccountsPath) + " " + quotedArgs + "; "
            + "else exit 127; fi");
        root.accountBusy = true;
        executable.exec(root.accountCommand);
    }

    function isPinned(account) {
        return Plasmoid.configuration.hiddenAccountIds.indexOf(account.id) === -1
            && providerVisible(account.provider);
    }

    function providerVisible(provider) {
        return provider === "codex" ? Plasmoid.configuration.showCodex
            : provider === "claude" ? Plasmoid.configuration.showClaude : Plasmoid.configuration.showAntigravity;
    }

    function connectAccount(account) {
        if (account.provider === "antigravity") {
            manageAccount(["login", account.id], "Conectando con Antigravity…");
        } else {
            manageAccount(["login", account.id, "--terminal"], "Completa el inicio de sesión en la ventana abierta…");
        }
    }

    function togglePin(account) {
        var hidden = Array.prototype.slice.call(Plasmoid.configuration.hiddenAccountIds);
        var index = hidden.indexOf(account.id);
        if (isPinned(account)) {
            hidden.push(account.id);
        } else {
            if (index !== -1) hidden.splice(index, 1);
            // Keep the existing provider-wide settings compatible with pins.
            if (!providerVisible(account.provider)) {
                root.accounts.forEach(function (other) {
                    if (other.provider === account.provider && other.id !== account.id
                        && hidden.indexOf(other.id) === -1) hidden.push(other.id);
                });
            }
            if (account.provider === "codex") Plasmoid.configuration.showCodex = true;
            else if (account.provider === "claude") Plasmoid.configuration.showClaude = true;
            else Plasmoid.configuration.showAntigravity = true;
        }
        Plasmoid.configuration.hiddenAccountIds = hidden;
        Plasmoid.configuration.writeConfig();
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

    function iconSource(kind) {
        return Qt.resolvedUrl("../icons/" + kind + "-orb.svg");
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

                    readonly property bool compactFont: modelData.lines.length > 1 || !!modelData.showAccountName || compactRoot.vertical

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

                        SeverityText {
                            severity: "muted"
                            visible: !!modelData.showAccountName
                            text: modelData.accountLabel || ""
                            textFormat: Text.PlainText
                            elide: Text.ElideRight
                            Layout.maximumWidth: Kirigami.Units.gridUnit * 6
                            font.family: Kirigami.Theme.smallFont.family
                            font.pointSize: Kirigami.Theme.smallFont.pointSize
                            font.bold: Plasmoid.configuration.panelBold
                        }
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
                                        readonly property font baseFont: entry.compactFont
                                            ? Kirigami.Theme.smallFont : Kirigami.Theme.defaultFont
                                        font.family: baseFont.family
                                        font.pointSize: baseFont.pointSize
                                        font.bold: Plasmoid.configuration.panelBold
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

    fullRepresentation: QQC2.Control {
        id: fullRoot
        Kirigami.Theme.inherit: false
        Kirigami.Theme.colorSet: Kirigami.Theme.Window
        readonly property QtObject windowColors: ContrastPalette { id: popupColors }
        background: Rectangle { color: popupColors.surface }
        readonly property real outerPadding: Kirigami.Units.largeSpacing
        readonly property real laneGap: Kirigami.Units.largeSpacing * 1.5
        readonly property var arrangement: PopupLayout.plan(root.accounts, {
            screenWidth: Math.max(320, Screen.width - 48),
            screenHeight: Math.max(280, Screen.height - 96),
            cardWidth: Kirigami.Units.gridUnit * 20,
            minimumCardWidth: Kirigami.Units.gridUnit * 16,
            cardHeight: Kirigami.Units.gridUnit * 12,
            padding: outerPadding, gap: laneGap,
            columns: Plasmoid.configuration.popupColumns,
            rows: Plasmoid.configuration.popupRows,
            autoWidth: Plasmoid.configuration.popupAutoWidth,
            autoHeight: Plasmoid.configuration.popupAutoHeight,
            width: Plasmoid.configuration.popupWidth,
            height: Plasmoid.configuration.popupHeight
        })
        readonly property real fittedHeight: contentColumn.implicitHeight + header.implicitHeight
            + footer.implicitHeight + 4 * outerPadding + 4
        Layout.preferredWidth: arrangement.width
        Layout.minimumWidth: Math.min(arrangement.width, Kirigami.Units.gridUnit * 18)
        readonly property real dialogHeight: Math.max(
            layoutDialog.visible ? layoutDialog.implicitHeight : 0,
            addDialog.visible ? addDialog.implicitHeight : 0,
            renameDialog.visible ? renameDialog.implicitHeight : 0)
        Layout.preferredHeight: Math.min(arrangement.maxHeight, Math.max(dialogHeight > 0 ? dialogHeight + 24 : 0,
            arrangement.autoHeight ? Math.max(280, fittedHeight) : arrangement.height))
        Layout.minimumHeight: Math.min(280, Layout.preferredHeight)
        padding: 0
        contentItem: ColumnLayout {
            spacing: 0

            RowLayout {
                id: header
                Layout.fillWidth: true
                Layout.margins: Kirigami.Units.largeSpacing
                spacing: Kirigami.Units.largeSpacing
                Kirigami.Icon {
                    source: root.iconSource("ai")
                    Layout.preferredWidth: 32
                    Layout.preferredHeight: 32
                }
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2
                    PlasmaExtras.Heading { level: 3; text: "AI Usage"; color: popupColors.text }
                    QQC2.Label {
                        Layout.fillWidth: true
                        elide: Text.ElideRight
                        color: popupColors.secondary
                        font: Kirigami.Theme.smallFont
                        text: root.isLoading ? (root.accountNotice || "Actualizando tus cuentas…")
                            : root.accounts.length + (root.accounts.length === 1 ? " cuenta" : " cuentas")
                                + " · " + (root.status ? Format.updatedAtLine(root.status, root.nowMs) : "Esperando datos")
                    }
                }
                QQC2.ToolButton {
                    icon.name: "view-refresh"
                    enabled: !root.isLoading
                    Accessible.name: "Actualizar todas las cuentas"
                    QQC2.ToolTip.visible: hovered
                    QQC2.ToolTip.text: Accessible.name
                    onClicked: root.runCollector()
                }
                QQC2.ToolButton {
                    icon.name: "configure"
                    Accessible.name: "Diseño y tamaño"
                    QQC2.ToolTip.visible: hovered
                    QQC2.ToolTip.text: Accessible.name
                    onClicked: layoutDialog.open()
                }
                QQC2.ToolButton {
                    icon.name: "list-add-user"
                    enabled: !root.isLoading
                    Accessible.name: "Añadir cuenta"
                    QQC2.ToolTip.visible: hovered
                    QQC2.ToolTip.text: Accessible.name
                    onClicked: addDialog.open()
                }
            }

            QQC2.ProgressBar {
                Layout.fillWidth: true
                Layout.preferredHeight: 2
                indeterminate: root.isLoading
                visible: root.isLoading
            }
            Kirigami.Separator { Layout.fillWidth: true }

            QQC2.ScrollView {
                id: scrollView
                Layout.fillWidth: true
                Layout.fillHeight: true
                contentWidth: availableWidth
                clip: true
                QQC2.ScrollBar.horizontal.policy: QQC2.ScrollBar.AlwaysOff

                ColumnLayout {
                    id: contentColumn
                    width: scrollView.availableWidth
                    spacing: Kirigami.Units.largeSpacing

                    Kirigami.InlineMessage {
                        Layout.fillWidth: true
                        Layout.margins: Kirigami.Units.largeSpacing
                        visible: root.accountError.length > 0
                        text: root.accountError
                        type: Kirigami.MessageType.Error
                        showCloseButton: true
                        onVisibleChanged: if (!visible) root.accountError = ""
                    }

                    ColumnLayout {
                        Layout.fillWidth: true
                        Layout.margins: Kirigami.Units.largeSpacing
                        visible: root.accounts.length === 0
                        spacing: Kirigami.Units.largeSpacing
                        Kirigami.Icon {
                            source: root.statusState.kind === "invalid" ? "data-warning" : "system-users"
                            Layout.alignment: Qt.AlignHCenter
                            Layout.preferredWidth: 48
                            Layout.preferredHeight: 48
                            color: popupColors.secondary
                        }
                        PlasmaExtras.Heading {
                            Layout.alignment: Qt.AlignHCenter
                            level: 4
                            text: root.statusState.kind === "invalid" ? "No se pudieron leer los datos"
                                : root.isLoading ? "Buscando tus cuentas…" : "Todas tus cuentas, en un lugar"
                        }
                        QQC2.Label {
                            Layout.fillWidth: true
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.Wrap
                            color: popupColors.secondary
                            text: root.collectorLaunchFailed ? "No se pudo iniciar el colector. Comprueba que Node.js 18 o posterior esté instalado."
                                : "Conecta tus cuentas de Codex, Claude o Antigravity para ver su uso."
                        }
                        QQC2.Button {
                            Layout.alignment: Qt.AlignHCenter
                            text: "Añadir cuenta"
                            icon.name: "list-add"
                            highlighted: true
                            enabled: !root.isLoading
                            onClicked: addDialog.open()
                        }
                    }

                    GridLayout {
                        id: agentGrid
                        Layout.fillWidth: true
                        Layout.margins: fullRoot.outerPadding
                        columns: fullRoot.arrangement.columns
                        columnSpacing: fullRoot.laneGap
                        rowSpacing: fullRoot.laneGap

                        Repeater {
                            model: fullRoot.arrangement.lanes
                            delegate: ColumnLayout {
                                id: lane
                                required property var modelData
                                Layout.fillWidth: true
                                Layout.alignment: Qt.AlignTop
                                Layout.preferredWidth: (scrollView.availableWidth - 2 * fullRoot.outerPadding
                                    - (agentGrid.columns - 1) * fullRoot.laneGap) / agentGrid.columns
                                spacing: Kirigami.Units.largeSpacing

                                RowLayout {
                                    Layout.fillWidth: true
                                    spacing: Kirigami.Units.smallSpacing * 2
                                    Kirigami.Icon {
                                        source: root.iconSource(lane.modelData.provider)
                                        Layout.preferredWidth: 22
                                        Layout.preferredHeight: 22
                                    }
                                    PlasmaExtras.Heading {
                                        Layout.fillWidth: true
                                        level: 4
                                        color: popupColors.text
                                        text: lane.modelData.name
                                    }
                                    QQC2.Label {
                                        text: lane.modelData.parts > 1
                                            ? lane.modelData.part + "/" + lane.modelData.parts
                                            : lane.modelData.total + (lane.modelData.total === 1 ? " cuenta" : " cuentas")
                                        color: popupColors.secondary
                                        font: Kirigami.Theme.smallFont
                                    }
                                }

                                Repeater {
                                    model: lane.modelData.accounts
                                    delegate: AccountCard {
                                        required property var modelData
                                        Layout.fillWidth: true
                                        account: modelData
                                        thresholds: root.thresholds
                                        nowMs: root.nowMs
                                        pinned: root.isPinned(modelData)
                                        busy: root.isLoading
                                        iconSource: root.iconSource(modelData.provider)
                                        onPinRequested: root.togglePin(modelData)
                                        onLoginRequested: root.connectAccount(modelData)
                                        onLogoutRequested: root.manageAccount(["logout", modelData.id], "Cerrando sesión…")
                                        onRemoveRequested: root.manageAccount(["remove", modelData.id], "Eliminando cuenta…")
                                        onRenameRequested: {
                                            renameDialog.accountId = modelData.id;
                                            renameField.text = modelData.label;
                                            renameDialog.open();
                                        }
                                        onOpenRequested: root.openLink(modelData.provider === "codex" ? root.codexUsageUrl
                                            : modelData.provider === "claude" ? root.claudeUsageUrl : root.antigravityUsageUrl)
                                    }
                                }
                            }
                        }
                    }

                    Kirigami.InlineMessage {
                        visible: root.hasActiveErrors
                        Layout.fillWidth: true
                        Layout.margins: Kirigami.Units.largeSpacing
                        type: Kirigami.MessageType.Warning
                        text: "Algunas cuentas no pudieron actualizarse. Se conservaron los últimos datos disponibles."
                        actions: [
                            Kirigami.Action { text: "Ver detalles"; onTriggered: root.openErrorLog() },
                            Kirigami.Action { text: "Reintentar"; enabled: !root.isLoading; onTriggered: root.runCollector() },
                            Kirigami.Action { text: "Descartar"; enabled: !root.isLoading; onTriggered: root.clearErrors() }
                        ]
                    }
                    Item { Layout.preferredHeight: Kirigami.Units.smallSpacing }
                }
            }

            Kirigami.Separator { Layout.fillWidth: true }
            RowLayout {
                id: footer
                Layout.fillWidth: true
                Layout.margins: Kirigami.Units.largeSpacing
                QQC2.Label {
                    Layout.fillWidth: true
                    wrapMode: Text.Wrap
                    font: Kirigami.Theme.smallFont
                    color: popupColors.secondary
                    text: "Fija las cuentas que quieres ver en la barra."
                }
                QQC2.Button {
                    text: "Añadir cuenta"
                    icon.name: "list-add"
                    enabled: !root.isLoading
                    onClicked: addDialog.open()
                }
            }

            QQC2.Dialog {
                id: layoutDialog
                anchors.centerIn: parent
                width: Math.min(fullRoot.width - 24, Kirigami.Units.gridUnit * 27)
                padding: Kirigami.Units.gridUnit
                title: "Diseño y tamaño"
                modal: true
                standardButtons: QQC2.Dialog.Ok | QQC2.Dialog.Cancel
                onOpened: {
                    popupSettings.columnCount = Plasmoid.configuration.popupColumns;
                    popupSettings.rowCount = Plasmoid.configuration.popupRows;
                    popupSettings.autoWidth = Plasmoid.configuration.popupAutoWidth;
                    popupSettings.autoHeight = Plasmoid.configuration.popupAutoHeight;
                    popupSettings.widthPixels = Plasmoid.configuration.popupWidth;
                    popupSettings.heightPixels = Plasmoid.configuration.popupHeight;
                    standardButton(QQC2.Dialog.Ok).text = "Aplicar";
                    standardButton(QQC2.Dialog.Cancel).text = "Cancelar";
                }
                onAccepted: {
                    Plasmoid.configuration.popupColumns = popupSettings.columnCount;
                    Plasmoid.configuration.popupRows = popupSettings.rowCount;
                    Plasmoid.configuration.popupAutoWidth = popupSettings.autoWidth;
                    Plasmoid.configuration.popupAutoHeight = popupSettings.autoHeight;
                    Plasmoid.configuration.popupWidth = popupSettings.widthPixels;
                    Plasmoid.configuration.popupHeight = popupSettings.heightPixels;
                    Plasmoid.configuration.writeConfig();
                }
                contentItem: QQC2.ScrollView {
                    id: layoutScroll
                    implicitHeight: Math.min(popupSettings.implicitHeight,
                        fullRoot.arrangement.maxHeight - 140)
                    contentWidth: availableWidth
                    clip: true
                    QQC2.ScrollBar.horizontal.policy: QQC2.ScrollBar.AlwaysOff
                    PopupSettings { id: popupSettings; width: layoutScroll.availableWidth }
                }
            }

            QQC2.Dialog {
                id: addDialog
                anchors.centerIn: parent
                width: Math.min(fullRoot.width - 24, Kirigami.Units.gridUnit * 23)
                padding: Kirigami.Units.gridUnit
                title: "Añadir cuenta"
                modal: true
                standardButtons: QQC2.Dialog.Ok | QQC2.Dialog.Cancel
                footer: QQC2.DialogButtonBox {
                    padding: addDialog.padding
                }
                onOpened: {
                    accountName.text = "";
                    accountName.forceActiveFocus();
                    standardButton(QQC2.Dialog.Ok).text = "Añadir";
                    standardButton(QQC2.Dialog.Cancel).text = "Cancelar";
                }
                onAccepted: {
                    var args = ["add", providerCombo.currentValue, accountName.text.trim(),
                        providerCombo.currentValue === "antigravity" ? "--local"
                            : connectionCombo.currentIndex === 0 ? "--login" : "--import"];
                    if (providerCombo.currentValue === "antigravity" && googleEmail.text.trim())
                        args.push("--email", googleEmail.text.trim());
                    root.manageAccount(args, providerCombo.currentValue === "antigravity" ? "Conectando con Antigravity…"
                        : connectionCombo.currentIndex === 0 ? "Completa el inicio de sesión en la ventana abierta…" : "Importando sesión…");
                }
                Component.onCompleted: standardButton(QQC2.Dialog.Ok).enabled = Qt.binding(function () {
                    return accountName.text.trim().length > 0;
                })
                contentItem: QQC2.ScrollView {
                    id: addScroll
                    implicitHeight: Math.min(addForm.implicitHeight, fullRoot.arrangement.maxHeight - 140)
                    contentWidth: availableWidth
                    clip: true
                    QQC2.ScrollBar.horizontal.policy: QQC2.ScrollBar.AlwaysOff
                    ColumnLayout {
                        id: addForm
                        width: addScroll.availableWidth
                        spacing: Kirigami.Units.largeSpacing
                        QQC2.Label { text: "Proveedor" }
                        QQC2.ComboBox {
                            id: providerCombo
                            Layout.fillWidth: true
                            textRole: "text"
                            valueRole: "value"
                            model: [{ text: "Claude", value: "claude" }, { text: "Codex", value: "codex" },
                                { text: "Google Antigravity", value: "antigravity" }]
                        }
                        QQC2.Label { text: "Nombre de la cuenta" }
                        QQC2.TextField {
                            id: accountName
                            Layout.fillWidth: true
                            placeholderText: "Personal, trabajo…"
                            maximumLength: 60
                        }
                        QQC2.Label { text: "Conexión"; visible: providerCombo.currentValue !== "antigravity" }
                        QQC2.Label {
                            text: "Correo de Google (opcional)"
                            visible: providerCombo.currentValue === "antigravity"
                        }
                        QQC2.TextField {
                            id: googleEmail
                            Layout.fillWidth: true
                            visible: providerCombo.currentValue === "antigravity"
                            placeholderText: "Para elegir entre varias sesiones abiertas"
                            inputMethodHints: Qt.ImhEmailCharactersOnly
                        }
                        QQC2.ComboBox {
                            id: connectionCombo
                            visible: providerCombo.currentValue !== "antigravity"
                            Layout.fillWidth: true
                            model: ["Iniciar otra sesión", "Importar la sesión actual de la CLI"]
                        }
                        QQC2.Label {
                            Layout.fillWidth: true
                            wrapMode: Text.Wrap
                            color: popupColors.secondary
                            font: Kirigami.Theme.smallFont
                            text: providerCombo.currentValue === "antigravity"
                                ? "Abre Antigravity e inicia sesión con Google. Se conectará la cuenta activa y se mostrarán sus cuotas por modelo. Antigravity debe permanecer abierto para actualizar."
                                : connectionCombo.currentIndex === 0
                                ? "Se abrirá una terminal para iniciar sesión. Elige la cuenta que quieres añadir en el navegador."
                                : "Se guardará una copia independiente de la sesión actual. Asigna un nombre para reconocerla."
                        }
                    }
                }
            }

            QQC2.Dialog {
                id: renameDialog
                property string accountId: ""
                anchors.centerIn: parent
                width: Math.min(fullRoot.width - 24, Kirigami.Units.gridUnit * 20)
                title: "Cambiar nombre"
                modal: true
                standardButtons: QQC2.Dialog.Ok | QQC2.Dialog.Cancel
                onAccepted: root.manageAccount(["rename", accountId, renameField.text.trim()])
                onOpened: {
                    renameField.forceActiveFocus();
                    renameField.selectAll();
                    standardButton(QQC2.Dialog.Ok).text = "Guardar";
                    standardButton(QQC2.Dialog.Cancel).text = "Cancelar";
                }
                Component.onCompleted: standardButton(QQC2.Dialog.Ok).enabled = Qt.binding(function () {
                    return renameField.text.trim().length > 0;
                })
                QQC2.TextField {
                    id: renameField
                    width: parent.width
                    maximumLength: 60
                    placeholderText: "Nombre de la cuenta"
                }
            }
        }
    }
}
