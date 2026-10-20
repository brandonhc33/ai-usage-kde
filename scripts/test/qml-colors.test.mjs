import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const query = spawnSync('qtpaths6', ['--query', 'QT_INSTALL_BINS'], { encoding: 'utf8' });
const candidates = [query.status === 0 ? query.stdout.trim() : '', '/usr/lib/qt6/bin', '/usr/lib64/qt6/bin']
  .filter(Boolean).map((dir) => path.join(dir, 'qmltestrunner'));
const runner = candidates.find((file) => fs.existsSync(file));
const ui = fileURLToPath(new URL('../../package/contents/ui/', import.meta.url));

test('Qt 6 creates the widget components and keeps semantic text readable after theme changes', { skip: !runner }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-qml-colors-'));
  try {
    fs.writeFileSync(path.join(temporary, 'tst_colors.qml'), `
import QtQuick
import QtTest
import org.kde.kirigami as Kirigami
import ${JSON.stringify('file://' + ui)} as Ui
import ${JSON.stringify('file://' + path.resolve(ui, '../code/colors.js'))} as Colors
TestCase {
    id: suite
    name: "ContrastBindings"
    width: 500; height: 300
    Component {
        id: sample
        Item {
            property color surface: "#ffffff"
            property alias label: value
            property alias bar: progress
            Kirigami.Theme.inherit: false
            Kirigami.Theme.backgroundColor: surface
            Ui.SeverityText { id: value; text: "76%"; severity: "critical" }
            Ui.UsageBar { id: progress; width: 200; value: 76; color: "#e62e38"; severity: value.severity }
        }
    }
    function test_binding_data() {
        var rows = [];
        ["#ffffff", "#202326", "#181b28", "#45464b", "#777777"].forEach(function(background) {
            ["normal", "warning", "critical", "muted", "login_required"].forEach(function(severity) {
                rows.push({tag: background+severity, background:background,severity:severity});
            });
        });
        return rows;
    }
    function test_binding(data) {
        var scope = createTemporaryObject(sample, suite, {surface: data.background});
        verify(scope !== null);
        scope.label.severity = data.severity;
        tryVerify(function() { return Colors.contrast(scope.label.color, scope.surface) >= 4.5; });
        compare(scope.label.opacity, 1);
        scope.label.color = scope.surface; // Simulate a panel themer recoloring Text.
        tryVerify(function() { return Colors.contrast(scope.label.color, scope.surface) >= 4.5; });
        verify(Colors.contrast(scope.bar.fillColor, scope.bar.barColors.track) >= 3);
        verify(Colors.contrast(scope.bar.fillColor, scope.surface) >= 3);
        scope.surface = data.background === "#ffffff" ? "#181b28" : "#ffffff";
        tryVerify(function() { return Colors.contrast(scope.label.color, scope.surface) >= 4.5; });
        verify(Colors.contrast(scope.bar.fillColor, scope.bar.barColors.track) >= 3);
        verify(Colors.contrast(scope.bar.fillColor, scope.surface) >= 3);
    }
    function test_components_data() {
        return ["ContrastPalette.qml","SeverityText.qml","MetricRow.qml","UsageBar.qml",
            "ProviderCard.qml","AccountCard.qml","main.qml","ConfigPanel.qml","PopupSettings.qml"]
            .map(function(file) { return {tag:file, file:file}; });
    }
    function test_components(data) {
        var component = Qt.createComponent(${JSON.stringify('file://' + ui)} + data.file);
        if (component.status === Component.Loading) tryCompare(component, "status", Component.Ready);
        compare(component.status, Component.Ready, component.errorString());
    }
}
`);
    const report = path.join(temporary, 'report.txt');
    const result = spawnSync(runner, ['-input', temporary, '-o', `${report},txt`], {
      env: { ...process.env, QT_QPA_PLATFORM: 'offscreen', QML_DISABLE_DISK_CACHE: '1' },
      encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : result.stderr);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
