// [SwyShot] background.js — v1.0.0
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

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;

  if (msg.type === "swyshot-start-capture") {
    startCapture(msg.mode, msg.tabId, msg.windowId);
    return;
  }

  if (msg.type === "swyshot-region-selected") {
    const tab = sender.tab;
    if (tab) finishRegionCapture(tab.id, tab.windowId, msg.rect, msg.devicePixelRatio);
    return;
  }

  if (msg.type === "swyshot-region-cancelled") {
    console.log("[SwyShot] 영역 선택이 취소되었습니다.");
    return;
  }
});

function startCapture(mode, tabId, windowId) {
  if (mode === "visible") return captureVisible(windowId);
  if (mode === "fullpage") return captureFullPage(tabId, windowId);
  if (mode === "region") return startRegionSelection(tabId);
  console.error("[SwyShot] 알 수 없는 캡쳐 모드:", mode);
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
  });
}

async function alertInTab(tabId, message) {
  if (!tabId) {
    console.error("[SwyShot]", message);
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: (m) => alert(m), args: [message] });
  } catch (err) {
    console.error("[SwyShot]", message);
  }
}

// ---------- 모드 1: 현재 화면 ----------
async function captureVisible(windowId) {
  try {
    const dataUrl = await captureVisibleTabSafe(windowId);
    saveAndOpen(dataUrl);
  } catch (err) {
    console.error("[SwyShot] 캡쳐 실패:", err);
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
  try {
    const metrics = await execInTab(tabId, getPageMetrics);
    const dpr = metrics.devicePixelRatio;
    const canvasW = Math.round(metrics.scrollWidth * dpr);
    const canvasH = Math.round(metrics.scrollHeight * dpr);

    if (canvasW > 32000 || canvasH > 32000) {
      alertInTab(tabId, chrome.i18n.getMessage("errFullPageTooLarge"));
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
    console.error("[SwyShot] 전체 페이지 캡쳐 실패:", err);
    alertInTab(tabId, chrome.i18n.getMessage("errFullPageFailed", [err.message]));
  }
}

// ---------- 모드 3: 영역 선택 (드래그 → 크롭) ----------
function injectSelectionOverlay() {
  if (document.getElementById("__swyshot_overlay__")) return;

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
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: injectSelectionOverlay });
  } catch (err) {
    console.error("[SwyShot] 영역 선택 오버레이 삽입 실패:", err);
  }
}

async function finishRegionCapture(tabId, windowId, rect, dpr) {
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
    console.error("[SwyShot] 영역 캡쳐 실패:", err);
    alertInTab(tabId, chrome.i18n.getMessage("errRegionFailed", [err.message]));
  }
}
