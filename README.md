# AI Usage for KDE Plasma 6

[Español](README.es.md) | **English**

AI Usage is a read-only panel widget that monitors the usage limits of Codex,
Claude and Google Antigravity. It does not send prompts, consume credits, or make AI requests on
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
kpackagetool6 --type Plasma/Applet --install ai-usage-kde-0.5.3.plasmoid
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

### Accounts and sessions

Open the widget and select **Añadir cuenta** (Add account). Choose Codex or
Claude, give the account a name such as Personal or Work, and choose a connection:

- **Iniciar otra sesión** (Sign in): opens a terminal and the official CLI login.
  Select the intended account in your browser. Requires Codex CLI or Claude Code
  and Konsole (`x-terminal-emulator` and `xterm` are also supported).
- **Importar la sesión actual de la CLI** (Import current CLI session): copies
  the current local file credentials. For Codex sessions stored exclusively in
  the keyring, use a new sign-in instead.

You can add multiple accounts of the same provider. Each account has its own
name, credentials and usage snapshot. Widget credentials live under
`~/.config/ai-usage-status/accounts/`. The **⋮** menu on each card lets you
rename, reconnect, sign out or remove an account. Signing out deletes the
widget's saved credentials and cached usage, keeping the card for reconnection.
Removing an account also removes its card.

Existing provider configurations continue to appear as Principal accounts.
Disconnecting these from the widget preserves sessions used by other apps.
New accounts use separate `CODEX_HOME` or `CLAUDE_CONFIG_DIR` directories.
Claude credentials can expire; use the sign-in action on the account card to
renew them.

Use each card's **pin** to select which accounts appear in the panel. Selection
is saved per widget instance. **The expanded view always shows every account**,
including hidden and signed-out accounts. Hiding everything leaves the AI Usage
icon available to open the widget.

The full installation also provides account management commands:

```bash
ai-usage-accounts list
ai-usage-accounts add claude Work --login
ai-usage-accounts add codex Personal --import
ai-usage-accounts rename ID 'Work'
ai-usage-accounts logout ID
ai-usage-accounts login ID --terminal
ai-usage-accounts remove ID
```

The configuration remains compatible with `providers`. Managing accounts saves
an explicit `accounts` list with stable IDs. An empty list means all accounts
were removed and prevents automatic detection from bringing them back.

### Popup layout and sizing

Accounts are grouped into columns by agent. Automatic width follows the number
of columns, and automatic height follows the content. Large agent groups
continue in adjacent columns. The popup stays within the screen and only
scrolls when its content exceeds the available space.

Use **Diseño y tamaño** (the settings icon next to refresh) or right-click >
**Configure AI Usage…** > **Ventana** to choose automatic or manual columns
(up to 6), accounts per column (up to 8), and independent automatic or manual
width and height in pixels. Settings are saved per widget instance.

Text and usage colors adapt to light and dark backgrounds. Percentages,
credits, and informational labels retain contrast without opacity reductions;
usage tracks have visible outlines.

### Google Antigravity

Antigravity has no usage web page; its weekly quota is read from the official
`agy` CLI, which works with the desktop app closed. Install it and sign in with
Google once:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash   # installs ~/.local/bin/agy
agy                                                            # opens Google sign-in; then close the CLI
agy -p /usage                                                  # check your quota
```

Then choose **Añadir cuenta** > **Google Antigravity**. The collector runs
`agy -p /usage --output-format json`, which answers without an agent turn,
quota use, or a new conversation. If the CLI is signed out, the collector never
opens a browser: the card asks you to run `agy`. Without the CLI, the local
quota service of the app (or IDE) is the fallback, and it must remain open; if
it is closed too, the card shows the install command. The widget sends no
prompts and copies no Google OAuth credentials. Local CSRF tokens stay in
memory and are never stored in configuration or status files.

Each card is bound to the Google identity detected at connection time. If
multiple accounts are open, enter the account email to select one. Switching
accounts in Antigravity never substitutes another identity's usage. A mismatch
keeps the previous snapshot temporarily and displays a notice. Disconnecting
from the widget preserves the session in Antigravity.

Models share two independent weekly quotas (Gemini and Claude + GPT); an
unused quota shows as "Sin iniciar" because its week starts with the first
message. Session and weekly limits are shown when provided. Older IDE responses that
only expose model quotas retain those quotas without guessing their duration.
Unknown usage stays unavailable (`--`), and the panel shows the highest known
usage percentage.

This integration is experimental: the CLI account is identified from its run
log, and the app's local API is internal.
It does not monitor Gemini CLI or Gemini API billing. References:
[Google Antigravity plans](https://antigravity.google/docs/plans) and
[CodexBar's local protocol documentation](https://github.com/steipete/CodexBar/blob/main/docs/antigravity.md).

```bash
ai-usage-accounts add antigravity Google --local
ai-usage-accounts add antigravity Work --local --email name@example.com
```

### Widget settings

Right-click the widget > **Configure AI Usage…** > **Panel** to choose what
the panel shows: percent used or left, session reset, the weekly percent
and reset day (optionally on a second line), available credit, or a custom
template, and display account names when a provider has multiple accounts.
The tooltip always lists every account, window, reset and credit.

For reset presets, **Mostrar reinicio como** lets you choose the countdown
(`3h56`), the local reset time (`17:24`), or both (`3h56 · 17:24`).

**Texto de la barra > Usar negrita** toggles bold panel text, including account
names, percentages and resets. It is enabled by default.

The session email appears below each account name when available. Hover over
an abbreviated address to see it in full. Emails also appear in the panel tooltip.

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
structured collector and account manager; Playwright and `node_modules` are not included.

Bug reports: <https://github.com/brandonhc33/ai-usage-kde/issues>
