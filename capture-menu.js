// [SwyShot] capture-menu.js
document.documentElement.lang = chrome.i18n.getUILanguage();
document.querySelectorAll("[data-i18n]").forEach((el) => {
  el.textContent = chrome.i18n.getMessage(el.dataset.i18n);
});

document.querySelectorAll(".swyshot-menu-item").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const mode = btn.dataset.mode;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      window.close();
      return;
    }
    chrome.runtime.sendMessage({
      type: "swyshot-start-capture",
      mode,
      tabId: tab.id,
      windowId: tab.windowId
    });
    window.close();
  });
});
