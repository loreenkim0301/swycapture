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

  if (msg.type === "swyshot-fullpage-choice") {
    console.log("[SwyCapture] 메시지 수신: swyshot-fullpage-choice", msg);
    const tab = sender.tab;
    if (tab && ["top", "current", "scaled"].includes(msg.choice)) {
      // 대화상자가 페이지에서 사라진 뒤 리페인트될 시간을 주고 시작한다(대화상자가 찍히지 않도록).
      delay(100).then(() => captureFullPage(tab.id, tab.windowId, msg.choice));
    }
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
  // 영역 선택 오버레이와, 답하지 않고 남겨둔 "전체 페이지 한도 초과" 대화상자를 함께 정리한다.
  ["__swyshot_overlay__", "__swyshot_fullpage_dialog__"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.remove();
  });
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
  return "data:" + (blob.type || "image/png") + ";base64," + btoa(binary);
}

function saveAndOpen(dataUrl, { successMessage = null, sizeBytes = 0 } = {}) {
  chrome.storage.local.set({ swyshotImage: dataUrl, swyshotCapturedAt: Date.now() }, () => {
    // chrome.storage.local.set()은 실패해도(용량 초과 등) 콜백은 항상 호출되고
    // chrome.runtime.lastError만 세팅된다. 이걸 확인하지 않으면 저장이 실패한 채로
    // 새 탭을 열게 되어, 이전에 저장돼 있던 캡쳐 이미지가 그대로 다시 보이는
    // "캡쳐했는데 옛날 화면만 나온다" 버그가 생긴다.
    if (chrome.runtime.lastError) {
      // 용량 문제일 가능성이 크면 몇 MB였는지와 함께 다시 시도할 방법을 알려준다.
      if (sizeBytes >= 10 * 1024 * 1024) {
        notifyError("errSaveImageTooLarge", toMegabytes(sizeBytes), chrome.runtime.lastError.message);
      } else {
        notifyError("errSaveImageFailed", chrome.runtime.lastError.message);
      }
      return;
    }
    chrome.tabs.create({ url: chrome.runtime.getURL("annotator.html") });
    notifySuccess(successMessage);
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

function notifySuccess(message) {
  console.log("[SwyCapture] 캡쳐 완료");
  notify(chrome.i18n.getMessage("notifySuccessTitle"), message || chrome.i18n.getMessage("notifySuccessMessage"));
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
// 일부 페이지(특히 사이드바가 있는 문서형 레이아웃)는 window/body가 아니라 안쪽의 별도 div가
// 실제로 스크롤되는 컨테이너다. 이런 페이지에서 window.scrollTo()는 아무 효과가 없어서 매번
// 똑같은 최상단 화면만 캡쳐되고, 그걸 이어붙이면 같은 장면이 반복되거나 사실상 한 화면만
// 캡쳐된 것처럼 보인다. 그래서 window 자체가 스크롤 불가능하면 화면의 상당 부분을 차지하는
// 실제 스크롤 컨테이너를 찾아 그걸 스크롤한다. (스위타이머 크롬 확장에서 동일한 문제를
// 겪고 고친 코드를 그대로 가져옴)
//
// 주의: chrome.scripting.executeScript({ func })는 넘긴 함수 "하나"의 소스만 페이지에 주입한다.
// 같은 파일의 다른 top-level 함수는 주입된 페이지 안에 존재하지 않으므로, 아래에서 쓰는
// locateScrollRoot는 각 함수 안에 중첩 선언으로 반드시 중복 정의해야 한다(분리하면
// "locateScrollRoot is not defined"로 즉시 실패한다).
function getPageMetrics() {
  function locateScrollRoot() {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight > doc.clientHeight + 4) return null; // window 자체 스크롤 사용
    let best = null;
    let bestArea = 0;
    document.querySelectorAll("body *").forEach((el) => {
      const cs = window.getComputedStyle(el);
      if (cs.overflowY !== "auto" && cs.overflowY !== "scroll") return;
      if (el.scrollHeight <= el.clientHeight + 4) return;
      const rect = el.getBoundingClientRect();
      if (rect.height < window.innerHeight * 0.4) return;
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    });
    return best;
  }

  const root = locateScrollRoot();
  if (root) {
    return {
      usesRoot: true,
      scrollHeight: root.scrollHeight,
      scrollWidth: root.scrollWidth,
      viewportHeight: root.clientHeight,
      viewportWidth: root.clientWidth,
      devicePixelRatio: window.devicePixelRatio || 1,
      originalScrollY: root.scrollTop
    };
  }
  const doc = document.documentElement;
  const body = document.body;
  return {
    usesRoot: false,
    scrollHeight: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0),
    scrollWidth: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0),
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
    devicePixelRatio: window.devicePixelRatio || 1,
    originalScrollY: window.scrollY
  };
}

function scrollAndReport(y) {
  function locateScrollRoot() {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight > doc.clientHeight + 4) return null;
    let best = null;
    let bestArea = 0;
    document.querySelectorAll("body *").forEach((el) => {
      const cs = window.getComputedStyle(el);
      if (cs.overflowY !== "auto" && cs.overflowY !== "scroll") return;
      if (el.scrollHeight <= el.clientHeight + 4) return;
      const rect = el.getBoundingClientRect();
      if (rect.height < window.innerHeight * 0.4) return;
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    });
    return best;
  }

  const root = locateScrollRoot();
  if (root) {
    root.scrollTop = y;
    return root.scrollTop;
  }
  window.scrollTo(0, y);
  return window.scrollY;
}

// position:fixed/sticky 요소는 스크롤해도 항상 같은 화면 위치에 떠 있으므로, 스크롤-스티칭
// 방식으로 여러 장을 이어붙이면 매 구간마다 반복해서 찍혀버린다(예: 상단 고정 헤더가 세로로
// 계속 겹쳐 보임). 스크롤 캡쳐 도중에는 숨겼다가 끝나면 원래대로 되돌린다.
function hideFixedElements() {
  const marker = "data-swycapture-prev-visibility";
  document.querySelectorAll("body *").forEach((el) => {
    if (el.hasAttribute(marker)) return;
    const cs = window.getComputedStyle(el);
    if (cs.position === "fixed" || cs.position === "sticky") {
      el.setAttribute(marker, el.style.visibility || "");
      el.style.setProperty("visibility", "hidden", "important");
    }
  });
}

function restoreFixedElements() {
  const marker = "data-swycapture-prev-visibility";
  document.querySelectorAll(`[${marker}]`).forEach((el) => {
    const prev = el.getAttribute(marker);
    if (prev) {
      el.style.visibility = prev;
    } else {
      el.style.removeProperty("visibility");
    }
    el.removeAttribute(marker);
  });
}

async function execInTab(tabId, func, args) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: args || []
  });
  return result;
}

// 캡쳐 결과 이미지 한 장의 크기 한도.
// - 한 변 32,000px: 브라우저 캔버스의 한 변 최대치(약 32,767px)에 여유를 둔 값
// - 1억 2천만 화소: 캔버스 면적 한도(약 2억 6천만 화소)와 메모리를 고려한 값. 주석 편집기의
//   "PNG로 저장"이 오른쪽에 댓글 사이드바(이미지 폭의 약 1/3)를 붙여 다시 그리므로 그만큼 여유를 둔다.
const MAX_CANVAS_SIDE = 32000;
const MAX_CANVAS_AREA = 120000000;
// PNG가 이보다 크면 chrome.storage 저장/주석 편집기 로딩이 실패하거나 매우 느려지므로 JPEG로 압축한다.
const MAX_PNG_BYTES = 40 * 1024 * 1024;
// 화질을 낮춰 전체를 담는 대안은, 결과가 일반(1배율) 화면 기준 절반 크기 이상일 때만 제안한다.
// 그보다 작으면 글씨를 읽을 수 없어 대안으로서 의미가 없다.
const MIN_READABLE_CSS_SCALE = 0.5;

// 페이지 크기로부터 "원본 화질로 한 장에 담을 수 있는 최대 길이"와 "전체를 담으려면 줄여야 하는 비율"을 계산한다.
// 예전에는 한도를 넘으면 무조건 "너무 길어서 안 된다"로 끝났는데, 이 값들로 대안을 제시한다.
function planFullPage(metrics) {
  const dpr = metrics.devicePixelRatio;
  // 가로 스크롤은 하지 않으므로(뷰포트 폭만 찍힘) 폭이 한도를 넘으면 오른쪽을 잘라낸다.
  const widthPx = Math.max(1, Math.min(Math.round(metrics.scrollWidth * dpr), MAX_CANVAS_SIDE));
  const fullHeightPx = Math.max(1, Math.round(metrics.scrollHeight * dpr));
  const maxHeightByArea = Math.floor(MAX_CANVAS_AREA / widthPx);
  const maxHeightPx = Math.min(MAX_CANVAS_SIDE, maxHeightByArea);
  const fitScale =
    Math.min(1, MAX_CANVAS_SIDE / fullHeightPx, Math.sqrt(MAX_CANVAS_AREA / (widthPx * fullHeightPx))) * 0.999;
  return {
    dpr,
    widthPx,
    fullHeightPx,
    maxHeightPx,
    maxCssHeight: Math.floor(maxHeightPx / dpr),
    limitedBy: maxHeightByArea < MAX_CANVAS_SIDE ? "area" : "side",
    fits: fullHeightPx <= maxHeightPx,
    fitScale,
    canScale: fitScale * dpr >= MIN_READABLE_CSS_SCALE
  };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(v, max));
}

function formatNumber(n) {
  return Math.round(n).toLocaleString(chrome.i18n.getUILanguage());
}

function screensOf(cssHeight, viewportHeight) {
  return Math.max(1, Math.round(cssHeight / Math.max(1, viewportHeight)));
}

// "현재 위치부터" 캡쳐할 때의 시작점. 끝부분 근처에서 누르면 최대 길이를 다 채울 수 있도록 위로 당긴다.
function currentStartY(metrics, plan) {
  return clamp(metrics.originalScrollY, 0, Math.max(0, metrics.scrollHeight - plan.maxCssHeight));
}

// 한도 초과 시 페이지 위에 띄우는 선택 대화상자. executeScript로 주입되므로 필요한 건 모두 함수 안에 둔다.
// 선택 결과는 executeScript의 반환값(Promise)으로 기다리지 않고 메시지로 보낸다 — 사용자가 오래 고민하는
// 동안 서비스 워커가 잠들어도, 메시지가 워커를 다시 깨워 캡쳐가 이어지게 하기 위해서다.
function showFullPageLimitDialog(texts, options) {
  const HOST_ID = "__swyshot_fullpage_dialog__";
  const prev = document.getElementById(HOST_ID);
  if (prev) prev.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;";
  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    .backdrop { position:fixed; inset:0; background:rgba(15,18,30,0.45); display:flex; align-items:center; justify-content:center;
      font-family:-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; }
    .dialog { background:#fff; color:#1b1d24; width:min(440px, calc(100vw - 32px)); max-height:calc(100vh - 32px); overflow:auto;
      border-radius:12px; box-shadow:0 12px 40px rgba(0,0,0,0.25); padding:20px; box-sizing:border-box; }
    h2 { margin:0 0 8px; font-size:16px; line-height:1.4; }
    p { margin:0 0 16px; font-size:13px; line-height:1.6; color:#4a4f5c; }
    button { display:block; width:100%; text-align:left; border:1px solid #e2e4ea; background:#fff; border-radius:8px;
      padding:10px 12px; margin:0 0 8px; cursor:pointer; font:inherit; color:inherit; }
    button:hover, button:focus-visible { border-color:#2B4EE6; background:#f3f5ff; outline:none; }
    button.primary { border-color:#2B4EE6; }
    .title { display:block; font-size:14px; font-weight:600; }
    .desc { display:block; font-size:12px; color:#6b7080; margin-top:2px; line-height:1.5; }
    .badge { display:inline-block; font-size:11px; font-weight:600; color:#fff; background:#2B4EE6; border-radius:4px;
      padding:1px 5px; margin-left:6px; vertical-align:1px; }
    button.cancel { text-align:center; border:none; color:#6b7080; margin:4px 0 0; }
  `;
  root.appendChild(style);

  const backdrop = document.createElement("div");
  backdrop.className = "backdrop";
  const dialog = document.createElement("div");
  dialog.className = "dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const h = document.createElement("h2");
  h.textContent = texts.title;
  const p = document.createElement("p");
  p.textContent = texts.body;
  dialog.append(h, p);

  function close(choice) {
    document.removeEventListener("keydown", onKey, true);
    host.remove();
    if (choice) chrome.runtime.sendMessage({ type: "swyshot-fullpage-choice", choice });
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close(null);
    }
  }

  let focusBtn = null;
  options.forEach((opt) => {
    const btn = document.createElement("button");
    if (opt.recommended) btn.className = "primary";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = opt.title;
    if (opt.recommended) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = texts.recommended;
      title.appendChild(badge);
    }
    const desc = document.createElement("span");
    desc.className = "desc";
    desc.textContent = opt.desc;
    btn.append(title, desc);
    btn.addEventListener("click", () => close(opt.id));
    dialog.appendChild(btn);
    if (opt.recommended || !focusBtn) focusBtn = btn;
  });

  const cancel = document.createElement("button");
  cancel.className = "cancel";
  cancel.textContent = texts.cancel;
  cancel.addEventListener("click", () => close(null));
  dialog.appendChild(cancel);

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close(null);
  });
  backdrop.appendChild(dialog);
  root.appendChild(backdrop);
  document.documentElement.appendChild(host);
  document.addEventListener("keydown", onKey, true);
  if (focusBtn) focusBtn.focus();
}

async function askFullPageOption(tabId, metrics, plan) {
  const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String));
  const vh = metrics.viewportHeight;
  const totalScreens = screensOf(metrics.scrollHeight, vh);
  const maxScreens = screensOf(plan.maxCssHeight, vh);
  const reason =
    plan.limitedBy === "area"
      ? t("fullPageLimitReasonArea", formatNumber(MAX_CANVAS_AREA / 10000), formatNumber(plan.maxHeightPx))
      : t("fullPageLimitReasonSide", formatNumber(MAX_CANVAS_SIDE));

  const scalePct = Math.floor(plan.fitScale * 100);
  const options = [];
  options.push({
    id: "top",
    title: t("fullPageOptTop", maxScreens),
    desc: t("fullPageOptTopDesc", Math.floor((plan.maxCssHeight / metrics.scrollHeight) * 100))
  });
  if (currentStartY(metrics, plan) > vh / 2) {
    options.push({ id: "current", title: t("fullPageOptCurrent", maxScreens), desc: t("fullPageOptCurrentDesc") });
  }
  if (plan.canScale) {
    options.push({ id: "scaled", title: t("fullPageOptScaled"), desc: t("fullPageOptScaledDesc", scalePct) });
  }
  // 페이지 전체를 읽을 수 있는 화질로 담을 수 있으면 그게 가장 기대에 가깝다. 아니면 맨 위부터 최대 길이.
  const recommendedId = plan.canScale ? "scaled" : "top";
  options.forEach((o) => (o.recommended = o.id === recommendedId));

  const texts = {
    title: t("fullPageLimitTitle"),
    body: t(
      "fullPageLimitBody",
      totalScreens,
      formatNumber(plan.fullHeightPx),
      reason,
      maxScreens
    ),
    recommended: t("fullPageRecommended"),
    cancel: t("fullPageOptCancel")
  };

  console.log("[SwyCapture] 전체 페이지가 한도를 넘어 선택지를 표시합니다:", { metrics, plan, options });
  try {
    await execInTab(tabId, showFullPageLimitDialog, [texts, options]);
  } catch (err) {
    // 대화상자를 못 띄우면(주입 실패 등) 그냥 거절하지 않고 가장 안전한 대안으로 바로 진행한다.
    console.error("[SwyCapture] 선택 대화상자 표시 실패, 맨 위부터 최대 길이로 캡쳐합니다:", err);
    await captureFullPage(tabId, metrics.windowId, "top");
  }
}

async function captureFullPage(tabId, windowId, choice) {
  console.log("[SwyCapture] 전체 페이지 캡쳐 시작", choice ? { choice } : "");
  try {
    const metrics = await execInTab(tabId, getPageMetrics);
    const plan = planFullPage(metrics);
    const dpr = plan.dpr;

    let startY = 0;
    let rangeCss = metrics.scrollHeight;
    let scale = 1;
    let successMessage = null;
    const totalScreens = screensOf(metrics.scrollHeight, metrics.viewportHeight);

    if (!plan.fits) {
      if (!choice) {
        await askFullPageOption(tabId, { ...metrics, windowId }, plan);
        return;
      }
      if (choice === "scaled" && plan.canScale) {
        scale = plan.fitScale;
        successMessage = chrome.i18n.getMessage("notifySuccessScaled", [String(Math.floor(scale * 100))]);
      } else {
        rangeCss = plan.maxCssHeight;
        if (choice === "current") startY = currentStartY(metrics, plan);
        successMessage = chrome.i18n.getMessage("notifySuccessPartial", [
          String(totalScreens),
          String(screensOf(rangeCss, metrics.viewportHeight))
        ]);
      }
    }

    const vh = metrics.viewportHeight;
    const endY = startY + rangeCss;
    const maxScroll = Math.max(0, metrics.scrollHeight - vh);
    const lastPos = Math.min(Math.max(startY, endY - vh), maxScroll);
    const positions = [];
    for (let y = startY; y < lastPos; y += vh) positions.push(Math.min(y, maxScroll));
    positions.push(lastPos);

    const canvasW = Math.max(1, Math.round(plan.widthPx * scale));
    const canvasH = Math.max(1, Math.round(rangeCss * dpr * scale));
    const offscreen = new OffscreenCanvas(canvasW, canvasH);
    const ctx = offscreen.getContext("2d");
    if (scale < 1) ctx.imageSmoothingQuality = "high";

    await execInTab(tabId, hideFixedElements);
    try {
      const done = new Set();
      for (const pos of positions) {
        if (done.has(pos)) continue;
        done.add(pos);

        const actualY = await execInTab(tabId, scrollAndReport, [pos]);
        await delay(220); // 스크롤 후 리페인트/지연로딩 대기
        const dataUrl = await captureVisibleTabSafe(windowId);
        const blob = await (await fetch(dataUrl)).blob();
        const bitmap = await createImageBitmap(blob);
        ctx.drawImage(
          bitmap,
          0,
          Math.round((actualY - startY) * dpr * scale),
          Math.round(bitmap.width * scale),
          Math.round(bitmap.height * scale)
        );
        bitmap.close();
      }
    } finally {
      await execInTab(tabId, restoreFixedElements);
      await execInTab(tabId, scrollAndReport, [metrics.originalScrollY]);
    }

    const { blob: outBlob, compressedFromBytes } = await encodeCanvas(offscreen);
    if (compressedFromBytes) {
      const note = chrome.i18n.getMessage("notifyCompressedJpeg", [toMegabytes(compressedFromBytes)]);
      successMessage = successMessage ? successMessage + " " + note : note;
    }
    const dataUrl = await blobToDataUrl(outBlob);
    saveAndOpen(dataUrl, { successMessage, sizeBytes: outBlob.size });
  } catch (err) {
    console.error("[SwyCapture] 전체 페이지 캡쳐 실패:", err);
    notifyError("errFullPageFailed", err.message);
  }
}

function toMegabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// 이미지가 매우 크면 PNG 용량이 수십~수백 MB가 되어 저장/열기가 실패한다.
// 이때 실패로 끝내지 않고 JPEG로 압축해서라도 결과를 보여준다.
async function encodeCanvas(canvas) {
  const png = await canvas.convertToBlob({ type: "image/png" });
  if (png.size <= MAX_PNG_BYTES) return { blob: png, compressedFromBytes: 0 };
  const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  console.log("[SwyCapture] PNG 용량 초과로 JPEG 압축:", png.size, "→", jpeg.size);
  return { blob: jpeg, compressedFromBytes: png.size };
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
