// [SwyCapture] capture-menu.js
document.documentElement.lang = chrome.i18n.getUILanguage();
document.querySelectorAll("[data-i18n]").forEach((el) => {
  el.textContent = chrome.i18n.getMessage(el.dataset.i18n);
});

document.querySelectorAll(".swyshot-menu-item").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const mode = btn.dataset.mode;
    console.log("[SwyCapture] 메뉴 클릭:", mode);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      console.error("[SwyCapture] 활성 탭을 찾을 수 없습니다.");
      window.close();
      return;
    }
    try {
      // 응답을 기다리지 않고 팝업을 바로 닫으면, 서비스 워커가 잠들어 있던 경우
      // 메시지가 배경 스크립트에 전달되기 전에 팝업 컨텍스트가 사라져 캡쳐가
      // 시작되지 않을 수 있다. 백그라운드가 처리를 시작했다는 응답을 받은 뒤 닫는다.
      await chrome.runtime.sendMessage({
        type: "swyshot-start-capture",
        mode,
        tabId: tab.id,
        windowId: tab.windowId
      });
      console.log("[SwyCapture] 백그라운드로 캡쳐 요청 전달 완료:", mode);
    } catch (err) {
      console.error("[SwyCapture] 백그라운드로 캡쳐 요청 전달 실패:", err);
    }
    window.close();
  });
});
