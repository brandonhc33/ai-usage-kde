import QtQuick
import org.kde.kcmutils as KCM

KCM.SimpleKCM {
    property alias cfg_popupColumns: settings.columnCount
    property alias cfg_popupRows: settings.rowCount
    property alias cfg_popupAutoWidth: settings.autoWidth
    property alias cfg_popupAutoHeight: settings.autoHeight
    property alias cfg_popupWidth: settings.widthPixels
    property alias cfg_popupHeight: settings.heightPixels

    PopupSettings { id: settings }
}
