import QtQuick
import org.kde.plasma.configuration

ConfigModel {
    ConfigCategory {
        name: "Panel"
        icon: "preferences-desktop-display"
        source: "ConfigPanel.qml"
    }
    ConfigCategory {
        name: "Ventana"
        icon: "view-grid"
        source: "ConfigPopup.qml"
    }
}
