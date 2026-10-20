import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC2
import org.kde.kirigami as Kirigami

Kirigami.FormLayout {
    id: form
    readonly property QtObject formColors: ContrastPalette { id: colors }
    property int columnCount: 0
    property int rowCount: 0
    property alias autoWidth: autoWidthBox.checked
    property alias autoHeight: autoHeightBox.checked
    property alias widthPixels: widthSpin.value
    property alias heightPixels: heightSpin.value

    QQC2.ComboBox {
        Kirigami.FormData.label: "Columnas:"
        textRole: "text"
        valueRole: "value"
        model: [
            { text: "Automáticas", value: 0 }, { text: "1", value: 1 },
            { text: "2", value: 2 }, { text: "3", value: 3 },
            { text: "4", value: 4 }, { text: "5", value: 5 }, { text: "6", value: 6 }
        ]
        currentIndex: Math.max(0, indexOfValue(form.columnCount))
        onActivated: form.columnCount = currentValue
    }
    QQC2.ComboBox {
        Kirigami.FormData.label: "Filas por columna:"
        textRole: "text"
        valueRole: "value"
        model: [
            { text: "Automáticas", value: 0 }, { text: "1", value: 1 },
            { text: "2", value: 2 }, { text: "3", value: 3 }, { text: "4", value: 4 },
            { text: "5", value: 5 }, { text: "6", value: 6 }, { text: "7", value: 7 }, { text: "8", value: 8 }
        ]
        currentIndex: Math.max(0, indexOfValue(form.rowCount))
        onActivated: form.rowCount = currentValue
    }
    QQC2.Label {
        Layout.fillWidth: true
        Layout.maximumWidth: Kirigami.Units.gridUnit * 23
        wrapMode: Text.Wrap
        color: colors.secondary
        font: Kirigami.Theme.smallFont
        text: "Cada fila muestra una cuenta. Las cuentas se agrupan por agente; si un grupo supera las filas elegidas, continúa en otra columna."
    }
    QQC2.CheckBox {
        id: autoWidthBox
        Kirigami.FormData.label: "Ancho:"
        text: "Ajustar automáticamente"
    }
    QQC2.SpinBox {
        id: widthSpin
        enabled: !autoWidthBox.checked
        from: 320
        to: 3840
        stepSize: 20
        editable: true
        Kirigami.FormData.label: "Ancho manual (px):"
    }
    QQC2.CheckBox {
        id: autoHeightBox
        Kirigami.FormData.label: "Alto:"
        text: "Ajustar automáticamente"
    }
    QQC2.SpinBox {
        id: heightSpin
        enabled: !autoHeightBox.checked
        from: 260
        to: 2160
        stepSize: 20
        editable: true
        Kirigami.FormData.label: "Alto manual (px):"
    }
    QQC2.Label {
        Layout.fillWidth: true
        Layout.maximumWidth: Kirigami.Units.gridUnit * 23
        wrapMode: Text.Wrap
        color: colors.secondary
        font: Kirigami.Theme.smallFont
        text: "El tamaño automático sigue al contenido. La ventana se limita a tu pantalla; el desplazamiento aparece solo cuando hace falta."
    }
}
