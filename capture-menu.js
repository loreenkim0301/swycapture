// [SwyCapture] capture-menu.js
document.documentElement.lang = chrome.i18n.getUILanguage();
document.querySelectorAll("[data-i18n]").forEach((el) => {
  el.textContent = chrome.i18n.getMessage(el.dataset.i18n);
});

document.getElementById("swyshot-menu-version").textContent = "v" + chrome.runtime.getManifest().version;

// ---------- 댓글 작성자 이름 ----------
const authorDisplay = document.getElementById("swyshot-author-display");
const authorNameEl = document.getElementById("swyshot-author-name");
const authorEdit = document.getElementById("swyshot-author-edit");
const authorInput = document.getElementById("swyshot-author-input");
const authorChangeBtn = document.getElementById("swyshot-author-change");
const authorSaveBtn = document.getElementById("swyshot-author-save");
const authorCancelBtn = document.getElementById("swyshot-author-cancel");

let authorName = "";

function renderAuthorName() {
  authorNameEl.textContent = authorName
    ? chrome.i18n.getMessage("authorBtnWithName", [authorName])
    : chrome.i18n.getMessage("authorBtnDefault");
}

chrome.storage.local.get(["swyshotAuthorName"], (res) => {
  authorName = res.swyshotAuthorName || "";
  renderAuthorName();
});

authorChangeBtn.addEventListener("click", () => {
  authorInput.value = authorName;
  authorDisplay.hidden = true;
  authorEdit.hidden = false;
  authorInput.focus();
  authorInput.select();
});

authorCancelBtn.addEventListener("click", () => {
  authorEdit.hidden = true;
  authorDisplay.hidden = false;
});

authorSaveBtn.addEventListener("click", () => {
  authorName = authorInput.value.trim();
  chrome.storage.local.set({ swyshotAuthorName: authorName });
  renderAuthorName();
  authorEdit.hidden = true;
  authorDisplay.hidden = false;
});

authorInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") authorSaveBtn.click();
  if (e.key === "Escape") authorCancelBtn.click();
});

// ---------- 캡쳐 저장 위치 ----------
const DEFAULT_SAVE_FOLDER = "SwyCapture";
const savePathDisplay = document.getElementById("swyshot-savepath-display");
const savePathFolderEl = document.getElementById("swyshot-savepath-folder");
const savePathEdit = document.getElementById("swyshot-savepath-edit");
const savePathInput = document.getElementById("swyshot-savepath-input");
const savePathChangeBtn = document.getElementById("swyshot-savepath-change");
const savePathSaveBtn = document.getElementById("swyshot-savepath-save");
const savePathCancelBtn = document.getElementById("swyshot-savepath-cancel");

// chrome.downloads의 filename에 "/"를 포함하면 다운로드 폴더 아래 하위 폴더로
// 저장된다. 상위 경로 이동(..)이나 구분자 등은 허용하지 않고 폴더명 한 단계로 제한한다.
function sanitizeFolderName(name) {
  return String(name || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 50);
}

let saveFolder = DEFAULT_SAVE_FOLDER;

chrome.storage.local.get(["swyshotSaveFolder"], (res) => {
  saveFolder = sanitizeFolderName(res.swyshotSaveFolder) || DEFAULT_SAVE_FOLDER;
  savePathFolderEl.textContent = saveFolder;
});

savePathChangeBtn.addEventListener("click", () => {
  savePathInput.value = saveFolder;
  savePathDisplay.hidden = true;
  savePathEdit.hidden = false;
  savePathInput.focus();
  savePathInput.select();
});

savePathCancelBtn.addEventListener("click", () => {
  savePathEdit.hidden = true;
  savePathDisplay.hidden = false;
});

savePathSaveBtn.addEventListener("click", () => {
  saveFolder = sanitizeFolderName(savePathInput.value) || DEFAULT_SAVE_FOLDER;
  chrome.storage.local.set({ swyshotSaveFolder: saveFolder });
  savePathFolderEl.textContent = saveFolder;
  savePathEdit.hidden = true;
  savePathDisplay.hidden = false;
});

savePathInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") savePathSaveBtn.click();
  if (e.key === "Escape") savePathCancelBtn.click();
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
