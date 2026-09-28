function show(enabled, useSettingsInsteadOfPreferences) {
    if (useSettingsInsteadOfPreferences) {
        document.getElementsByClassName('state-on')[0].innerText = "Heran Borsa X Taslakları Safari'de etkin.";
        document.getElementsByClassName('state-off')[0].innerText = "Heran Borsa X Taslakları Safari'de kapalı.";
        document.getElementsByClassName('state-unknown')[0].innerText = "Safari Ayarları > Uzantılar bölümünden Heran Borsa X Taslakları'nı etkinleştirin.";
        document.getElementsByClassName('open-preferences')[0].innerText = "Safari Uzantı Ayarlarını Aç";
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);
