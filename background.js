// [SwyCapture] background.js — v1.0.0
// 캡쳐 모드 3가지: 현재 화면 / 전체 페이지(스크롤 전체 스티칭) / 영역 선택(드래그 후 크롭)
// 트리거: 툴바 아이콘 클릭(팝업 메뉴, capture-menu.html) / 우클릭 서브메뉴 / 단축키(현재 화면은 기본 배정)

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "swyshot-root",
    title: chrome.i18n.getMessage("ctxRoot"),
    contexts: ["page", "image", "selection"]
  });
  chrome.contextMenus.create({
    id: "swyshot-visible",
    parentId: "swyshot-root",
    title: chrome.i18n.getMessage("ctxVisible")
  });
  chrome.contextMenus.create({
    id: "swyshot-fullpage",
    parentId: "swyshot-root",
    title: chrome.i18n.getMessage("ctxFullpage")
  });
  chrome.contextMenus.create({
    id: "swyshot-region",
    parentId: "swyshot-root",
    title: chrome.i18n.getMessage("ctxRegion")
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  if (info.menuItemId === "swyshot-visible") startCapture("visible", tab.id, tab.windowId);
  if (info.menuItemId === "swyshot-fullpage") startCapture("fullpage", tab.id, tab.windowId);
  if (info.menuItemId === "swyshot-region") startCapture("region", tab.id, tab.windowId);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab) return;
  if (command === "capture-visible-tab") startCapture("visible", tab.id, tab.windowId);
  if (command === "capture-full-page") startCapture("fullpage", tab.id, tab.windowId);
  if (command === "capture-region") startCapture("region", tab.id, tab.windowId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "swyshot-start-capture") {
    console.log("[SwyCapture] 메시지 수신: swyshot-start-capture", msg);
    startCapture(msg.mode, msg.tabId, msg.windowId).finally(() => sendResponse({ ok: true }));
    return true; // 비동기 응답을 위해 채널을 열어둔다 (팝업의 sendMessage가 끊기지 않도록)
  }

  if (msg.type === "swyshot-region-selected") {
    console.log("[SwyCapture] 메시지 수신: swyshot-region-selected", msg);
    const tab = sender.tab;
    if (tab) finishRegionCapture(tab.id, tab.windowId, msg.rect, msg.devicePixelRatio);
    return;
  }

  if (msg.type === "swyshot-region-cancelled") {
    console.log("[SwyCapture] 영역 선택이 취소되었습니다.");
    return;
  }
});

async function startCapture(mode, tabId, windowId) {
  console.log("[SwyCapture] startCapture 호출:", { mode, tabId, windowId });

  const restricted = await isRestrictedTab(tabId);
  if (restricted) {
    console.error("[SwyCapture] 캡쳐할 수 없는 페이지입니다:", restricted);
    notify(
      chrome.i18n.getMessage("notifyErrorTitle"),
      chrome.i18n.getMessage("errRestrictedPage")
    );
    return;
  }

  // 이전에 "영역 선택"을 시작해놓고 드래그/Esc 없이 다른 캡쳐를 눌렀다면
  // 오버레이(반투명 배경 + 십자 커서)가 페이지에 그대로 남아있을 수 있다.
  // 그 상태로 현재 화면/전체 페이지를 캡쳐하면 오버레이까지 같이 찍혀버리므로
  // 어떤 모드든 캡쳐를 새로 시작하기 전에 항상 정리한다.
  if (mode !== "region") {
    await removeStraySelectionOverlay(tabId);
    await delay(50); // 오버레이 제거 후 리페인트 대기
  }

  if (mode === "visible") return captureVisible(windowId);
  if (mode === "fullpage") return captureFullPage(tabId, windowId);
  if (mode === "region") return startRegionSelection(tabId);
  console.error("[SwyCapture] 알 수 없는 캡쳐 모드:", mode);
}

function removeSelectionOverlayInPage() {
  const overlay = document.getElementById("__swyshot_overlay__");
  if (overlay) overlay.remove();
}

async function removeStraySelectionOverlay(tabId) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: removeSelectionOverlayInPage });
  } catch (err) {
    // 스크립트 주입 자체가 안 되는 페이지(제한된 페이지)라면 위쪽의
    // isRestrictedTab 검사에서 이미 걸러졌을 것이므로 여기선 조용히 무시한다.
    console.log("[SwyCapture] 이전 오버레이 정리 스킵:", err.message);
  }
}

// chrome://, 확장 프로그램 관리 페이지, Chrome 웹 스토어 등은 정책상 어떤 확장도
// 캡쳐/스크립트 주입을 할 수 없다. 시도 전에 감지해서 명확한 안내를 준다.
async function isRestrictedTab(tabId) {
  if (!tabId) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || "";
    const isRestricted =
      /^(chrome|edge|about|chrome-extension|devtools):/i.test(url) ||
      url.startsWith("https://chrome.google.com/webstore") ||
      url.startsWith("https://chromewebstore.google.com");
    return isRestricted ? url : null;
  } catch (err) {
    console.error("[SwyCapture] 탭 정보 조회 실패:", err);
    return null;
  }
}

// ---------- 공통 유틸 ----------
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureVisibleTabRaw(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : "캡쳐 실패"));
        return;
      }
      resolve(dataUrl);
    });
  });
}

async function captureVisibleTabSafe(windowId, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await captureVisibleTabRaw(windowId);
    } catch (err) {
      lastErr = err;
      await delay(350); // captureVisibleTab 초당 호출 제한 회피
    }
  }
  throw lastErr;
}

async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return "data:image/png;base64," + btoa(binary);
}

function saveAndOpen(dataUrl) {
  chrome.storage.local.set({ swyshotImage: dataUrl, swyshotCapturedAt: Date.now() }, () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("annotator.html") });
    notifySuccess();
  });
}

// 페이지에 스크립트를 주입해 alert()을 띄우는 방식은 chrome://, 웹스토어 등
// 제한된 페이지에서는 그 자체가 실패해 사용자에게 아무 반응도 보이지 않는 문제가 있었다.
// chrome.notifications는 페이지 종류와 무관하게 항상 표시되므로 이걸로 대체한다.
let notifyIdSeq = 0;
function notify(title, message) {
  const id = "swyshot-" + Date.now() + "-" + notifyIdSeq++;
  try {
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message
    });
  } catch (err) {
    console.error("[SwyCapture] 알림 표시 실패:", err);
  }
}

function notifySuccess() {
  console.log("[SwyCapture] 캡쳐 완료");
  notify(chrome.i18n.getMessage("notifySuccessTitle"), chrome.i18n.getMessage("notifySuccessMessage"));
}

function notifyError(messageKey, ...substitutions) {
  const message = chrome.i18n.getMessage(messageKey, substitutions);
  console.error("[SwyCapture]", message);
  notify(chrome.i18n.getMessage("notifyErrorTitle"), message);
}

// ---------- 모드 1: 현재 화면 ----------
async function captureVisible(windowId) {
  console.log("[SwyCapture] 현재 화면 캡쳐 시작");
  try {
    const dataUrl = await captureVisibleTabSafe(windowId);
    saveAndOpen(dataUrl);
  } catch (err) {
    console.error("[SwyCapture] 현재 화면 캡쳐 실패:", err);
    notifyError("errVisibleFailed", err.message);
  }
}

// ---------- 모드 2: 전체 페이지 (스크롤 전체 스티칭) ----------
function getPageMetrics() {
  const doc = document.documentElement;
  const body = document.body;
  return {
    scrollHeight: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0),
    scrollWidth: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0),
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
    devicePixelRatio: window.devicePixelRatio || 1,
    originalScrollY: window.scrollY
  };
}

function scrollAndReport(y) {
  window.scrollTo(0, y);
  return window.scrollY;
}

async function execInTab(tabId, func, args) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: args || []
  });
  return result;
}

async function captureFullPage(tabId, windowId) {
  console.log("[SwyCapture] 전체 페이지 캡쳐 시작");
  try {
    const metrics = await execInTab(tabId, getPageMetrics);
    const dpr = metrics.devicePixelRatio;
    const canvasW = Math.round(metrics.scrollWidth * dpr);
    const canvasH = Math.round(metrics.scrollHeight * dpr);

    if (canvasW > 32000 || canvasH > 32000) {
      notify(chrome.i18n.getMessage("notifyErrorTitle"), chrome.i18n.getMessage("errFullPageTooLarge"));
      console.error("[SwyCapture] 전체 페이지가 너무 큽니다:", canvasW, canvasH);
      return;
    }

    const lastY = Math.max(0, metrics.scrollHeight - metrics.viewportHeight);
    const positions = [];
    for (let y = 0; y < metrics.scrollHeight; y += metrics.viewportHeight) {
      positions.push(Math.min(y, lastY));
      if (y >= lastY) break;
    }
    if (positions.length === 0) positions.push(0);
    if (positions[positions.length - 1] !== lastY) positions.push(lastY);

    const offscreen = new OffscreenCanvas(canvasW, canvasH);
    const ctx = offscreen.getContext("2d");

    const done = new Set();
    for (const pos of positions) {
      if (done.has(pos)) continue;
      done.add(pos);

      const actualY = await execInTab(tabId, scrollAndReport, [pos]);
      await delay(220); // 스크롤 후 리페인트/지연로딩 대기
      const dataUrl = await captureVisibleTabSafe(windowId);
      const blob = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);
      ctx.drawImage(bitmap, 0, Math.round(actualY * dpr));
      bitmap.close();
    }

    await execInTab(tabId, scrollAndReport, [metrics.originalScrollY]);

    const outBlob = await offscreen.convertToBlob({ type: "image/png" });
    const dataUrl = await blobToDataUrl(outBlob);
    saveAndOpen(dataUrl);
  } catch (err) {
    console.error("[SwyCapture] 전체 페이지 캡쳐 실패:", err);
    notifyError("errFullPageFailed", err.message);
  }
}

// ---------- 모드 3: 영역 선택 (드래그 → 크롭) ----------
function injectSelectionOverlay() {
  const existing = document.getElementById("__swyshot_overlay__");
  if (existing) existing.remove(); // 이전 시도가 남아있다면 새로 시작

  const overlay = document.createElement("div");
  overlay.id = "__swyshot_overlay__";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.15);";

  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;border:2px solid #2B4EE6;background:rgba(43,78,230,0.15);display:none;pointer-events:none;";
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  let startX = 0;
  let startY = 0;
  let dragging = false;

  function onDown(e) {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    box.style.left = startX + "px";
    box.style.top = startY + "px";
    box.style.width = "0px";
    box.style.height = "0px";
    box.style.display = "block";
  }

  function onMove(e) {
    if (!dragging) return;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    box.style.left = x + "px";
    box.style.top = y + "px";
    box.style.width = w + "px";
    box.style.height = h + "px";
  }

  function cleanup() {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  }

  function onUp(e) {
    dragging = false;
    const x = Math.min(e.clientX, startX);
    const y = Math.min(e.clientY, startY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    cleanup();
    if (w < 4 || h < 4) {
      chrome.runtime.sendMessage({ type: "swyshot-region-cancelled" });
      return;
    }
    chrome.runtime.sendMessage({
      type: "swyshot-region-selected",
      rect: { x, y, width: w, height: h },
      devicePixelRatio: window.devicePixelRatio || 1
    });
  }

  function onKey(e) {
    if (e.key === "Escape") {
      cleanup();
      chrome.runtime.sendMessage({ type: "swyshot-region-cancelled" });
    }
  }

  overlay.addEventListener("mousedown", onDown);
  overlay.addEventListener("mousemove", onMove);
  overlay.addEventListener("mouseup", onUp);
  document.addEventListener("keydown", onKey, true);
}

async function startRegionSelection(tabId) {
  console.log("[SwyCapture] 영역 선택 오버레이 삽입 시도");
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: injectSelectionOverlay });
    console.log("[SwyCapture] 영역 선택 오버레이 삽입 완료 — 드래그로 영역을 선택해주세요.");
  } catch (err) {
    console.error("[SwyCapture] 영역 선택 오버레이 삽입 실패:", err);
    notifyError("errRegionOverlayFailed", err.message);
  }
}

async function finishRegionCapture(tabId, windowId, rect, dpr) {
  console.log("[SwyCapture] 영역 캡쳐 진행:", rect);
  try {
    const dataUrl = await captureVisibleTabSafe(windowId);
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);

    const sx = Math.round(rect.x * dpr);
    const sy = Math.round(rect.y * dpr);
    const sw = Math.round(rect.width * dpr);
    const sh = Math.round(rect.height * dpr);

    const offscreen = new OffscreenCanvas(sw, sh);
    const ctx = offscreen.getContext("2d");
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    bitmap.close();

    const outBlob = await offscreen.convertToBlob({ type: "image/png" });
    const croppedDataUrl = await blobToDataUrl(outBlob);
    saveAndOpen(croppedDataUrl);
  } catch (err) {
    console.error("[SwyCapture] 영역 캡쳐 실패:", err);
    notifyError("errRegionFailed", err.message);
  }
}
