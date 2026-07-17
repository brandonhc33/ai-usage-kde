appid := 'com.github.brandonhc33.ai-usage-kde'

# Default recipe: validate the complete project
default: check

# Preview the plasmoid as a horizontal panel widget
run:
    plasmoidviewer -a package -l topedge -f horizontal

# Preview the expanded/desktop representation
run-popup:
    plasmoidviewer -a package -l floating -f planar

# Lint QML and run the collector unit tests
check:
    qmllint package/contents/ui/*.qml
    cd scripts && npm test
    find scripts -path '*/node_modules' -prune -o -name '*.mjs' -print0 | xargs -0 -n1 node --check

# Install the widget, collector and user timer
setup:
    ./install.sh

# Run one real collection
collect:
    node scripts/ai-usage-collect.mjs

# Safe environment/status diagnostic (does not print credentials)
doctor:
    node scripts/ai-usage-doctor.mjs

# Installs the plasmoid for the current user (or upgrades it if present)
install-user:
    #!/usr/bin/env bash
    set -euo pipefail
    if kpackagetool6 --type Plasma/Applet --show {{appid}} >/dev/null 2>&1; then
        kpackagetool6 --type Plasma/Applet --upgrade package
    else
        kpackagetool6 --type Plasma/Applet --install package
    fi

# Removes the installed plasmoid for the current user
uninstall-user:
    kpackagetool6 --type Plasma/Applet --remove {{appid}}

# Generates a fake ~/.cache/ai-usage-status/status.json for local testing
fake-status:
    mkdir -p ~/.cache/ai-usage-status
    cd scripts && node merge-status.mjs
