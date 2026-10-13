# AI Usage for KDE Plasma 6

[Español](README.es.md) | **English**

AI Usage is a read-only panel widget that monitors the usage limits of Codex
and Claude. It does not send prompts, consume credits, or make AI requests on
the user's behalf.

The widget prefers local, structured sources:

- **Codex:** `account/rateLimits/read` from the local Codex app server.
- **Claude:** the official usage endpoint with the local Claude Code OAuth
  session.

The KDE Store package includes the collector and refreshes automatically every
two minutes. No background service, npm install, or browser automation is
required for normal use.

## Requirements

- KDE Plasma 6.0 or newer.
- Node.js 18 or newer.
- The Plasma 5 Support QML module used by Plasma 6.
- Codex CLI and/or Claude Code, depending on the accounts you want to monitor.

The widget works with either provider enabled. You do not need both.

Codex is also detected when it is bundled by Codex Desktop or Zed's external
agent, even when those applications have not published `codex` in `PATH`.

## Initial setup

### Arch Linux, CachyOS and Manjaro

Install the runtime dependencies:

```bash
sudo pacman -S --needed nodejs npm plasma5support curl
```

Install and authenticate the providers you want to monitor.

Codex CLI:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex login
```

Claude Code:

```bash
npm install -g @anthropic-ai/claude-code
claude
```

On the first Claude Code run, select the sign-in option for your Claude
subscription. Do not use `sudo npm install -g`.

### Debian and Ubuntu

This widget requires Plasma 6. Debian 13 or newer is supported. On Ubuntu,
use a release that ships Plasma 6, such as Kubuntu 25.10 or newer. Ubuntu and
Kubuntu 24.04 ship Plasma 5 and cannot run this widget.

Install the runtime dependencies:

```bash
sudo apt update
sudo apt install nodejs npm curl qml6-module-org-kde-plasma-plasma5support
```

Install and authenticate the providers you want to monitor.

Codex CLI:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex login
```

Claude Code:

```bash
npm install -g @anthropic-ai/claude-code
claude
```

If `node --version` reports a version older than 18, install a current Node.js
release before continuing.

## Install the widget

### KDE Store

1. Right-click the Plasma panel and select **Enter Edit Mode**.
2. Select **Add Widgets**.
3. Select **Get New Widgets** and then **Download New Plasma Widgets**.
4. Search for **AI Usage** and select **Install**.
5. Add AI Usage to the panel.

The first collection starts automatically. Use **Update now** in the popup to
retry after signing in to Codex or Claude.

### Local `.plasmoid` file

```bash
kpackagetool6 --type Plasma/Applet --install ai-usage-kde-0.3.0.plasmoid
```

For an update, use `--upgrade` instead of `--install`.

## Optional full installation

The repository installer adds a user systemd timer and an optional Playwright
web fallback. The KDE Store edition does not need these components.

Arch-based systems:

```bash
sudo pacman -S --needed nodejs npm plasma-sdk plasma5support qt6-tools
git clone https://github.com/brandonhc33/ai-usage-kde.git
cd ai-usage-kde
./install.sh
```

Debian/Ubuntu with Plasma 6:

```bash
sudo apt update
sudo apt install nodejs npm plasma-sdk \
  qml6-module-org-kde-plasma-plasma5support qt6-tools-dev-tools
git clone https://github.com/brandonhc33/ai-usage-kde.git
cd ai-usage-kde
./install.sh
```

For the optional web fallback, install Google Chrome or Chromium and `xvfb`.
The structured Codex and Claude sources remain the recommended mode.
If Chrome exits while starting inside Xvfb, the collector retries in headless
mode and remembers that choice for the installed browser version. A Chrome
upgrade automatically causes the preferred mode to be checked again.

## Configuration

The first collection creates:

```text
~/.config/ai-usage-status/config.json
~/.cache/ai-usage-status/status.json
```

The default configuration enables both providers. To monitor only one, set
the other provider's `enabled` value to `false` in `config.json`.

Supported source values are:

| Provider | Values | Default order |
|---|---|---|
| Codex | `auto`, `cli`, `web` | Codex CLI, then optional web fallback |
| Claude | `auto`, `oauth`, `web` | Claude OAuth, then optional web fallback |

The KDE Store package always treats `auto` as structured-only. Explicit web
mode is available only with the optional full installation.

Claude Code renews its OAuth token only while it is in use. When the token has
expired (typically before the first Claude Code use of the day), the default
`"on_oauth_expired": "keep_last"` keeps the last Claude data, shown in gray
with a notice, instead of scraping claude.ai. Set it to `"web"` to use the web
fallback instead.

### Widget settings

Right-click the widget > **Configure AI Usage…** > **Panel** to choose what
the panel shows: percent used or left, session reset, the weekly percent
and reset day (optionally on a second line), available credit, or a custom
template. The tooltip always lists every window, reset and credit.

For reset presets, **Mostrar reinicio como** lets you choose the countdown
(`3h56`), the local reset time (`17:24`), or both (`3h56 · 17:24`).

## Privacy and security

- The widget UI never receives tokens or cookies; it only reads a local JSON
  snapshot.
- The collector reads the existing local sessions of Codex CLI and Claude
  Code and sends credentials only to their corresponding official services.
- Status and log files do not contain access tokens.
- Generated files use restrictive user-only permissions.
- The source is licensed under the [MIT License](LICENSE).

## Troubleshooting

Check the installed versions and provider sessions:

```bash
node --version
codex --version
claude --version
```

For the full installation:

```bash
ai-usage-doctor
systemctl --user status ai-usage-collector.timer
journalctl --user -u ai-usage-collector.service -n 100 --no-pager
```

Detailed collector errors are stored in:

```text
~/.cache/ai-usage-status/errors.log
```

## Development and packaging

```bash
just check
just run
just package-store
```

`just package-store` creates the self-contained KDE Store upload in `dist/`.
The archive contains `metadata.json` at its root and bundles only the
structured collector; Playwright and `node_modules` are not included.

Bug reports: <https://github.com/brandonhc33/ai-usage-kde/issues>
