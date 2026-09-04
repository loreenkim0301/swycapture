// [SwyShot] capture-menu.js
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
