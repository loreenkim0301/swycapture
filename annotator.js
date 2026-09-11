// [SwyCapture] annotator.js
(function () {
  function t(key, subs) {
    return chrome.i18n.getMessage(key, subs) || key;
  }

  document.title = t("annotatorTitle");
  document.documentElement.lang = chrome.i18n.getUILanguage();
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-alt]").forEach((el) => {
    el.alt = t(el.dataset.i18nAlt);
  });

  const mainEl = document.getElementById("swyshot-main");
  const canvas = document.getElementById("swyshot-canvas");
  const imgEl = document.getElementById("swyshot-image");
  const listEl = document.getElementById("swyshot-comment-list");
  const emptyEl = document.getElementById("swyshot-empty");
  const countEl = document.getElementById("swyshot-count");
  const saveHtmlBtn = document.getElementById("swyshot-save-html");
  const savePdfBtn = document.getElementById("swyshot-save-pdf");
  const savePngBtn = document.getElementById("swyshot-save-png");
  const connectorSvg = document.getElementById("swyshot-connector");
  const versionEl = document.getElementById("swyshot-version");

  versionEl.textContent = "v" + chrome.runtime.getManifest().version;

  emptyEl.innerHTML = t("emptyState").replace(/\n/g, "<br>");

  /** @type {{id:string, xPercent:number, yPercent:number, text:string, author:string, createdAt:number}[]} */
  let comments = [];
  let capturedAt = Date.now();
  let imageDataUrl = "";
  let pendingPin = null;
  let activeId = null;
  let authorName = "";
  const DEFAULT_SAVE_FOLDER = "SwyCapture";
  let saveFolder = DEFAULT_SAVE_FOLDER;

  chrome.storage.local.get(
    ["swyshotImage", "swyshotCapturedAt", "swyshotAuthorName", "swyshotSaveFolder"],
    (res) => {
      if (!res.swyshotImage) {
        document.body.innerHTML = `<p style="padding:24px;font-family:sans-serif;">${escapeHtml(
          t("missingImage")
        )}</p>`;
        return;
      }
      imageDataUrl = res.swyshotImage;
      capturedAt = res.swyshotCapturedAt || Date.now();
      imgEl.src = imageDataUrl;

      // 댓글 작성자 이름은 툴바 팝업(capture-menu)에서 설정한다. 여기서는 이미
      // 저장된 이름을 읽어와 새 댓글에 붙이기만 한다.
      authorName = res.swyshotAuthorName || "";

      saveFolder = sanitizeFolderName(res.swyshotSaveFolder) || DEFAULT_SAVE_FOLDER;
    }
  );

  // 캡쳐 저장 위치는 툴바 팝업(capture-menu)에서 설정한다. 여기서는 저장 시
  // 사용할 폴더명만 읽어온다. 팝업에서 값이 바뀌면 다음 캡쳐부터 반영되도록
  // storage 변경도 구독해둔다(같은 세션에서 팝업과 편집 화면을 오갈 수 있으므로).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.swyshotSaveFolder) {
      saveFolder = sanitizeFolderName(changes.swyshotSaveFolder.newValue) || DEFAULT_SAVE_FOLDER;
    }
  });

  // chrome.downloads의 filename에 "/"를 포함하면 다운로드 폴더 아래 하위 폴더로
  // 저장된다. 상위 경로 이동(..)이나 구분자 등은 허용하지 않고 폴더명 한 단계로 제한한다.
  function sanitizeFolderName(name) {
    return String(name || "")
      .trim()
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 50);
  }

  // 댓글 작성자 이름 변경 UI는 툴바 팝업(capture-menu)에 있다. 팝업에서 이름을 바꾸면
  // 같은 세션에서 열려있는 편집 화면에도 다음 댓글부터 반영되도록 storage 변경을 구독한다.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.swyshotAuthorName) {
      authorName = changes.swyshotAuthorName.newValue || "";
    }
  });

  // ---------- 새 댓글 찍기 ----------
  canvas.addEventListener("click", (e) => {
    if (e.target.closest(".swyshot-pin") || e.target.closest(".swyshot-composer")) return;
    if (pendingPin) return;

    const rect = imgEl.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;

    const xPercent = ((e.clientX - rect.left) / rect.width) * 100;
    const yPercent = ((e.clientY - rect.top) / rect.height) * 100;
    openComposer(xPercent, yPercent);
  });

  function openComposer(xPercent, yPercent) {
    const pinEl = document.createElement("div");
    pinEl.className = "swyshot-pin pending";
    pinEl.style.left = xPercent + "%";
    pinEl.style.top = yPercent + "%";
    pinEl.textContent = "•";
    canvas.appendChild(pinEl);

    const composer = document.createElement("div");
    composer.className = "swyshot-composer";
    composer.style.left = xPercent + "%";
    composer.style.top = yPercent + "%";
    composer.innerHTML = `
      <textarea placeholder="${escapeHtml(t("composerPlaceholder"))}"></textarea>
      <div class="swyshot-composer-actions">
        <button type="button" class="cancel">${escapeHtml(t("composerCancel"))}</button>
        <button type="button" class="confirm">${escapeHtml(t("composerConfirm"))}</button>
      </div>
    `;
    canvas.appendChild(composer);

    const textarea = composer.querySelector("textarea");
    textarea.focus();

    pendingPin = { xPercent, yPercent, pinEl, composerEl: composer };

    composer.querySelector(".cancel").addEventListener("click", () => {
      canvas.removeChild(pinEl);
      canvas.removeChild(composer);
      pendingPin = null;
    });

    composer.querySelector(".confirm").addEventListener("click", () => confirmComment());
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) confirmComment();
      if (e.key === "Escape") composer.querySelector(".cancel").click();
    });

    function confirmComment() {
      const text = textarea.value.trim();
      canvas.removeChild(pinEl);
      canvas.removeChild(composer);
      pendingPin = null;
      if (!text) return;

      addComment(xPercent, yPercent, text);
    }
  }

  function addComment(xPercent, yPercent, text) {
    const comment = {
      id: "c" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      xPercent,
      yPercent,
      text,
      author: authorName,
      createdAt: Date.now()
    };
    comments.push(comment);
    activeId = comment.id;
    render();
  }

  function deleteComment(id) {
    comments = comments.filter((c) => c.id !== id);
    if (activeId === id) activeId = null;
    render();
  }

  function activateComment(id) {
    activeId = id;
    render();
  }

  // ---------- 렌더링 ----------
  function render() {
    canvas.querySelectorAll(".swyshot-pin:not(.pending)").forEach((el) => el.remove());
    listEl.innerHTML = "";

    comments.forEach((c, idx) => {
      const num = idx + 1;

      const pinEl = document.createElement("div");
      pinEl.className = "swyshot-pin" + (activeId === c.id ? " active" : "");
      pinEl.style.left = c.xPercent + "%";
      pinEl.style.top = c.yPercent + "%";
      pinEl.textContent = num;
      pinEl.title = (c.author ? c.author + ": " : "") + c.text;
      pinEl.dataset.id = c.id;
      attachDrag(pinEl, c);
      canvas.appendChild(pinEl);

      const li = document.createElement("li");
      li.className = "swyshot-comment-item" + (activeId === c.id ? " active" : "");
      li.dataset.id = c.id;
      li.innerHTML = `
        <span class="swyshot-comment-num">${num}</span>
        <div class="swyshot-comment-body">
          <span class="swyshot-comment-author"></span>
          <span class="swyshot-comment-text"></span>
        </div>
        <button type="button" class="swyshot-comment-del" title="${escapeHtml(t("commentDeleteTitle"))}">✕</button>
      `;
      li.querySelector(".swyshot-comment-author").textContent = c.author || "";
      li.querySelector(".swyshot-comment-text").textContent = c.text;
      li.addEventListener("click", () => activateComment(c.id));
      li.querySelector(".swyshot-comment-del").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteComment(c.id);
      });
      listEl.appendChild(li);
    });

    countEl.textContent = t("commentCount", [String(comments.length)]);
    emptyEl.style.display = comments.length === 0 ? "block" : "none";

    requestAnimationFrame(updateConnector);
  }

  // ---------- 핀 드래그 ----------
  function attachDrag(pinEl, comment) {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;

    pinEl.addEventListener("pointerdown", (e) => {
      if (pinEl.classList.contains("pending")) return;
      e.stopPropagation();
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      pinEl.setPointerCapture(e.pointerId);
    });

    pinEl.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      if (Math.abs(e.clientX - startX) > 3 || Math.abs(e.clientY - startY) > 3) {
        moved = true;
        pinEl.classList.add("dragging");
      }
      if (!moved) return;

      const rect = imgEl.getBoundingClientRect();
      let xPercent = ((e.clientX - rect.left) / rect.width) * 100;
      let yPercent = ((e.clientY - rect.top) / rect.height) * 100;
      xPercent = Math.min(100, Math.max(0, xPercent));
      yPercent = Math.min(100, Math.max(0, yPercent));

      pinEl.style.left = xPercent + "%";
      pinEl.style.top = yPercent + "%";
      comment.xPercent = xPercent;
      comment.yPercent = yPercent;

      if (activeId === comment.id) updateConnector();
    });

    pinEl.addEventListener("pointerup", (e) => {
      if (!dragging) return;
      dragging = false;
      pinEl.classList.remove("dragging");
      pinEl.releasePointerCapture(e.pointerId);
      if (moved) {
        render();
      } else {
        activateComment(comment.id);
      }
    });
  }

  // ---------- 핀 ↔ 댓글 연결선 (계단식) ----------
  function updateConnector() {
    connectorSvg.innerHTML = "";
    if (!activeId) return;

    const pinEl = canvas.querySelector(`.swyshot-pin[data-id="${cssEscape(activeId)}"]`);
    const itemEl = listEl.querySelector(`.swyshot-comment-item[data-id="${cssEscape(activeId)}"]`);
    if (!pinEl || !itemEl) return;

    const mainRect = mainEl.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const sidebarRect = document.getElementById("swyshot-sidebar").getBoundingClientRect();
    const pinRect = pinEl.getBoundingClientRect();
    const numRect = itemEl.querySelector(".swyshot-comment-num").getBoundingClientRect();

    if (numRect.top < sidebarRect.top || numRect.bottom > sidebarRect.bottom) return;

    const x1 = pinRect.left + pinRect.width / 2 - mainRect.left;
    const y1 = pinRect.top + pinRect.height / 2 - mainRect.top;
    const x2 = numRect.left + numRect.width / 2 - mainRect.left;
    const y2 = numRect.top + numRect.height / 2 - mainRect.top;
    const midX = canvasRect.right + (sidebarRect.left - canvasRect.right) / 2 - mainRect.left;

    const ns = "http://www.w3.org/2000/svg";
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`);
    connectorSvg.appendChild(path);

    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", x2);
    dot.setAttribute("cy", y2);
    dot.setAttribute("r", 3);
    connectorSvg.appendChild(dot);
  }

  function cssEscape(str) {
    return String(str).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  window.addEventListener("resize", () => requestAnimationFrame(updateConnector));
  document.getElementById("swyshot-sidebar").addEventListener("scroll", () => requestAnimationFrame(updateConnector));

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function buildFilename(ext) {
    const ts = new Date(capturedAt);
    const pad = (n) => String(n).padStart(2, "0");
    const name = `swyshot-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(
      ts.getHours()
    )}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.${ext}`;
    return `${saveFolder}/${name}`;
  }

  function downloadBlob(blob, filename, onDone) {
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        const reason = chrome.runtime.lastError ? chrome.runtime.lastError.message : t("unknownError");
        console.error("[SwyCapture] 다운로드 실패:", reason);
        showSaveError(reason);
        URL.revokeObjectURL(url);
        if (onDone) onDone();
        return;
      }
      const onChanged = (delta) => {
        if (delta.id !== downloadId) return;
        if (delta.state && delta.state.current === "complete") {
          URL.revokeObjectURL(url);
          chrome.downloads.onChanged.removeListener(onChanged);
          if (onDone) onDone();
        } else if (delta.state && delta.state.current === "interrupted") {
          console.error("[SwyCapture] 다운로드 중단:", delta.error && delta.error.current);
          showSaveError(delta.error ? delta.error.current : t("downloadInterrupted"));
          URL.revokeObjectURL(url);
          chrome.downloads.onChanged.removeListener(onChanged);
          if (onDone) onDone();
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
    });
  }

  function showSaveError(reason) {
    alert(t("saveErrorAlert", [reason]));
  }

  // ---------- PDF로 저장 (브라우저 인쇄 → PDF로 저장, 화면 그대로 노출) ----------
  savePdfBtn.addEventListener("click", () => {
    window.print();
  });

  // ---------- HTML로 저장 ----------
  saveHtmlBtn.addEventListener("click", () => {
    saveHtmlBtn.disabled = true;
    saveHtmlBtn.textContent = t("savingLabel");
    const html = buildExportHtml();
    const blob = new Blob([html], { type: "text/html" });
    downloadBlob(blob, buildFilename("html"), () => {
      saveHtmlBtn.disabled = false;
      saveHtmlBtn.textContent = t("saveHtmlBtn");
    });
  });

  function buildExportHtml() {
    const selfDescribingData = {
      _format: "swyshot-v1",
      _instructions: t("exportInstructions"),
      capturedAt,
      exportedAt: Date.now(),
      comments: comments.map((c) => ({
        id: c.id,
        xPercent: c.xPercent,
        yPercent: c.yPercent,
        text: c.text,
        author: c.author || "",
        createdAt: c.createdAt
      }))
    };

    const pinsHtml = comments
      .map(
        (c, idx) => `
      <button type="button" class="swyshot-vpin" style="left:${c.xPercent}%;top:${c.yPercent}%" data-id="${escapeHtml(
          c.id
        )}">${idx + 1}</button>`
      )
      .join("");

    const listItemsHtml = comments
      .map(
        (c, idx) => `
        <li class="swyshot-vitem" data-id="${escapeHtml(c.id)}">
          <span class="swyshot-vnum">${idx + 1}</span>
          <div class="swyshot-vbody">
            <span class="swyshot-vauthor"></span>
            <span class="swyshot-vtext"></span>
          </div>
        </li>`
      )
      .join("");

    const uiLang = chrome.i18n.getUILanguage();
    const capturedAtStr = new Date(capturedAt).toLocaleString(uiLang);

    return `<!DOCTYPE html>
<!--
  [SwyCapture 스냅샷 헤더]
  이 파일은 SwyCapture(스위캡쳐) 테스트 버전으로 생성된 단일 HTML 스크린샷 주석 파일입니다.
  - 이미지: <img id="swyshot-image">에 base64로 내장되어 있습니다.
  - 댓글 데이터: <script type="application/json" id="swyshot-comments">에 자기설명 구조로 내장되어 있습니다.
  - 서버/클라우드 업로드 없이 이 파일 하나만으로 이미지+댓글이 모두 보존됩니다.
-->
<html lang="${escapeHtml(uiLang)}">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(t("exportPageTitle", [capturedAtStr]))}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif; background:#f4f5f7; padding:24px; }
  .swyshot-meta { font-size: 12px; color:#6b7280; margin-bottom: 10px; }
  .swyshot-wrap { position: relative; display: flex; gap: 16px; align-items: flex-start; max-width: 1400px; margin: 0 auto; }
  .swyshot-frame { position: relative; display: inline-block; border:1px solid #e2e4ea; border-radius:8px; overflow:hidden; background:#fff; max-width: calc(100% - 300px); }
  .swyshot-frame img { display:block; max-width: 100%; height:auto; }
  .swyshot-vpin {
    position:absolute; transform:translate(-50%,-50%); min-width:22px; height:22px; padding:0 6px;
    border-radius:11px; background:#2B4EE6; color:#fff; font-size:12px; font-weight:700;
    display:flex; align-items:center; justify-content:center; border:2px solid #fff;
    box-shadow:0 1px 4px rgba(0,0,0,.35); cursor:pointer; opacity:.55; transition:opacity .12s ease;
  }
  .swyshot-vpin:hover, .swyshot-vpin.active { opacity: 1; }
  .swyshot-vpin.active { outline: 3px solid rgba(43,78,230,.35); }
  .swyshot-sidebar {
    width: 280px; flex-shrink: 0; background:#fff; border:1px solid #e2e4ea; border-radius:8px;
    padding: 12px; position: sticky; top: 16px; max-height: calc(100vh - 32px); overflow-y: auto;
  }
  .swyshot-sidebar-title { font-weight:700; font-size:13px; margin-bottom:8px; color:#6b7280; }
  .swyshot-vlist { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
  .swyshot-vitem { border:1px solid #e2e4ea; border-radius:6px; padding:8px; font-size:13px; cursor:pointer; display:flex; gap:8px; }
  .swyshot-vitem:hover { border-color:#2B4EE6; }
  .swyshot-vitem.active { border-color:#2B4EE6; background:#eef1fd; }
  .swyshot-vnum { flex-shrink:0; width:20px; height:20px; border-radius:50%; background:#2B4EE6; color:#fff; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; }
  .swyshot-vbody { display:flex; flex-direction:column; min-width:0; flex:1; }
  .swyshot-vauthor { font-weight:700; font-size:11px; color:#2B4EE6; margin-bottom:2px; }
  .swyshot-vauthor:empty { display:none; }
  .swyshot-vtext { white-space:pre-wrap; word-break:break-word; }
  .swyshot-connector { position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:15; overflow:visible; }
  .swyshot-connector path { fill:none; stroke:#2B4EE6; stroke-width:2; stroke-dasharray:5 4; stroke-linecap:round; }
  .swyshot-connector circle { fill:#2B4EE6; }
</style>
</head>
<body>
  <div class="swyshot-meta">${escapeHtml(t("exportMetaLine", [capturedAtStr, String(comments.length)]))}</div>
  <div class="swyshot-wrap" id="swyshot-wrap">
    <div class="swyshot-frame" id="swyshot-frame">
      <img id="swyshot-image" src="${imageDataUrl}" alt="${escapeHtml(t("imageAlt"))}" />${pinsHtml}
    </div>
    <aside class="swyshot-sidebar" id="swyshot-sidebar">
      <div class="swyshot-sidebar-title">${escapeHtml(t("exportSidebarTitle"))}</div>
      <ol class="swyshot-vlist" id="swyshot-vlist">${listItemsHtml}</ol>
    </aside>
    <svg id="swyshot-connector" class="swyshot-connector"></svg>
  </div>

  <script type="application/json" id="swyshot-comments">${JSON.stringify(selfDescribingData, null, 2).replace(
      /</g,
      "\\u003c"
    )}</script>
  <script>
    (function(){
      // 댓글 텍스트는 XSS 방지를 위해 textContent로 채워 넣습니다.
      var data = JSON.parse(document.getElementById('swyshot-comments').textContent);
      document.querySelectorAll('.swyshot-vitem').forEach(function(li){
        var id = li.getAttribute('data-id');
        var c = data.comments.find(function(x){ return x.id === id; });
        if (c) {
          li.querySelector('.swyshot-vauthor').textContent = c.author || '';
          li.querySelector('.swyshot-vtext').textContent = c.text;
        }
      });

      var wrap = document.getElementById('swyshot-wrap');
      var svg = document.getElementById('swyshot-connector');
      var frame = document.getElementById('swyshot-frame');
      var sidebar = document.getElementById('swyshot-sidebar');

      function setActive(id) {
        document.querySelectorAll('.swyshot-vpin').forEach(function(p){ p.classList.toggle('active', p.getAttribute('data-id') === id); });
        document.querySelectorAll('.swyshot-vitem').forEach(function(li){ li.classList.toggle('active', li.getAttribute('data-id') === id); });
        drawConnector(id);
      }

      function drawConnector(id) {
        svg.innerHTML = '';
        if (!id) return;
        var pin = document.querySelector('.swyshot-vpin[data-id="' + id + '"]');
        var li = document.querySelector('.swyshot-vitem[data-id="' + id + '"]');
        if (!pin || !li) return;
        var wrapRect = wrap.getBoundingClientRect();
        var frameRect = frame.getBoundingClientRect();
        var sidebarRect = sidebar.getBoundingClientRect();
        var pinRect = pin.getBoundingClientRect();
        var numRect = li.querySelector('.swyshot-vnum').getBoundingClientRect();

        var x1 = pinRect.left + pinRect.width/2 - wrapRect.left;
        var y1 = pinRect.top + pinRect.height/2 - wrapRect.top;
        var x2 = numRect.left + numRect.width/2 - wrapRect.left;
        var y2 = numRect.top + numRect.height/2 - wrapRect.top;
        var midX = frameRect.right + (sidebarRect.left - frameRect.right)/2 - wrapRect.left;

        var ns = 'http://www.w3.org/2000/svg';
        var path = document.createElementNS(ns, 'path');
        path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' L ' + midX + ' ' + y1 + ' L ' + midX + ' ' + y2 + ' L ' + x2 + ' ' + y2);
        svg.appendChild(path);
        var dot = document.createElementNS(ns, 'circle');
        dot.setAttribute('cx', x2); dot.setAttribute('cy', y2); dot.setAttribute('r', 3);
        svg.appendChild(dot);
      }

      document.querySelectorAll('.swyshot-vpin, .swyshot-vitem').forEach(function(el){
        el.addEventListener('click', function(){
          var id = el.getAttribute('data-id');
          var alreadyActive = el.classList.contains('active');
          setActive(alreadyActive ? null : id);
        });
      });
    })();
  </script>
</body>
</html>`;
  }

  // ---------- PNG로 저장 (이미지+핀+댓글 목록을 하나의 이미지로 합성) ----------
  savePngBtn.addEventListener("click", () => {
    savePngBtn.disabled = true;
    savePngBtn.textContent = t("savingLabel");
    buildExportPng()
      .then((blob) => {
        downloadBlob(blob, buildFilename("png"), () => {
          savePngBtn.disabled = false;
          savePngBtn.textContent = t("savePngBtn");
        });
      })
      .catch((err) => {
        console.error("[SwyCapture] PNG 생성 실패:", err);
        showSaveError(String(err));
        savePngBtn.disabled = false;
        savePngBtn.textContent = t("savePngBtn");
      });
  });

  function wrapTextByChar(ctx, text, maxWidth) {
    const paragraphs = String(text).split("\n");
    const lines = [];
    paragraphs.forEach((para) => {
      let current = "";
      for (const ch of para) {
        const test = current + ch;
        if (ctx.measureText(test).width > maxWidth && current !== "") {
          lines.push(current);
          current = ch;
        } else {
          current = test;
        }
      }
      lines.push(current);
    });
    return lines;
  }

  function buildExportPng() {
    return new Promise((resolve, reject) => {
      const srcImg = new Image();
      srcImg.onload = () => {
        try {
          const W = srcImg.naturalWidth;
          const H = srcImg.naturalHeight;
          const scale = W / 1000;

          const pinRadius = 14 * scale;
          const pinFont = Math.max(11, 13 * scale);

          if (comments.length === 0) {
            const canvasEl = document.createElement("canvas");
            canvasEl.width = W;
            canvasEl.height = H;
            const ctx = canvasEl.getContext("2d");
            ctx.drawImage(srcImg, 0, 0, W, H);
            canvasEl.toBlob((blob) => {
              if (!blob) reject(new Error(t("errCanvasToBlob")));
              else resolve(blob);
            }, "image/png");
            return;
          }

          const gap = 16 * scale;
          const sidebarWidth = Math.max(220, 300 * scale);
          const padX = 16 * scale;
          const padTop = 16 * scale;
          const rowGap = 12 * scale;
          const titleFont = Math.max(12, 13 * scale);
          const bodyFont = Math.max(12, 14 * scale);
          const lineHeight = bodyFont * 1.45;
          const badgeSize = Math.max(16, 20 * scale);
          const textMaxWidth = sidebarWidth - padX * 2 - badgeSize - 8 * scale;

          const measureCanvas = document.createElement("canvas");
          const mctx = measureCanvas.getContext("2d");
          mctx.font = `${bodyFont}px -apple-system, "Apple SD Gothic Neo", sans-serif`;

          const rows = comments.map((c, idx) => {
            const lines = wrapTextByChar(mctx, c.text, textMaxWidth);
            const author = c.author || null;
            const lineCount = lines.length + (author ? 1 : 0);
            return { num: idx + 1, text: c.text, author, lines, height: Math.max(badgeSize, lineCount * lineHeight) };
          });

          let cursorY = padTop + titleFont * 1.4 + 8 * scale;
          const rowTops = rows.map((row) => {
            const top = cursorY;
            cursorY += row.height + rowGap;
            return top;
          });
          const sidebarContentHeight = cursorY + padTop / 2;

          const sidebarX = W + gap;
          const canvasW = sidebarX + sidebarWidth;
          const canvasH = Math.max(H, sidebarContentHeight);

          const canvasEl = document.createElement("canvas");
          canvasEl.width = canvasW;
          canvasEl.height = canvasH;
          const ctx = canvasEl.getContext("2d");

          // 배경
          ctx.fillStyle = "#f4f5f7";
          ctx.fillRect(0, 0, canvasW, canvasH);

          // 원본 이미지
          ctx.drawImage(srcImg, 0, 0, W, H);

          // 사이드바 패널
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = "#e2e4ea";
          ctx.lineWidth = 1;
          if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(sidebarX, 0, sidebarWidth, sidebarContentHeight, 8 * scale);
            ctx.fill();
            ctx.stroke();
          } else {
            ctx.fillRect(sidebarX, 0, sidebarWidth, sidebarContentHeight);
            ctx.strokeRect(sidebarX, 0, sidebarWidth, sidebarContentHeight);
          }

          // 사이드바 타이틀
          ctx.fillStyle = "#6b7280";
          ctx.font = `700 ${titleFont}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
          ctx.textAlign = "left";
          ctx.textBaseline = "alphabetic";
          ctx.fillText(t("exportSidebarTitle"), sidebarX + padX, padTop + titleFont);

          // 계단식 연결선 (핀 → 배지), 배지/핀보다 먼저 그려서 아래 깔리게 함
          const midX = W + gap / 2;
          ctx.save();
          ctx.globalAlpha = 0.4;
          ctx.strokeStyle = "#2B4EE6";
          ctx.lineWidth = Math.max(1, 1.5 * scale);
          ctx.setLineDash([5 * scale, 4 * scale]);
          comments.forEach((c, idx) => {
            const x1 = (c.xPercent / 100) * W;
            const y1 = (c.yPercent / 100) * H;
            const badgeCy = rowTops[idx] + badgeSize / 2;
            const x2 = sidebarX + padX + badgeSize / 2;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(midX, y1);
            ctx.lineTo(midX, badgeCy);
            ctx.lineTo(x2, badgeCy);
            ctx.stroke();
          });
          ctx.restore();
          ctx.setLineDash([]);

          // 핀 (원본 위, 반투명 — 이미지 가시성 우선)
          comments.forEach((c, idx) => {
            const cx = (c.xPercent / 100) * W;
            const cy = (c.yPercent / 100) * H;
            ctx.save();
            ctx.globalAlpha = 0.55;
            ctx.beginPath();
            ctx.arc(cx, cy, pinRadius, 0, Math.PI * 2);
            ctx.fillStyle = "#2B4EE6";
            ctx.fill();
            ctx.lineWidth = Math.max(1.5, 2 * scale);
            ctx.strokeStyle = "#ffffff";
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#ffffff";
            ctx.font = `700 ${pinFont}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(idx + 1), cx, cy + 0.5);
            ctx.restore();
          });

          // 사이드바 배지 + 텍스트
          rows.forEach((row, idx) => {
            const top = rowTops[idx];
            const badgeCx = sidebarX + padX + badgeSize / 2;
            const badgeCy = top + badgeSize / 2;

            ctx.beginPath();
            ctx.arc(badgeCx, badgeCy, badgeSize / 2, 0, Math.PI * 2);
            ctx.fillStyle = "#2B4EE6";
            ctx.fill();
            ctx.fillStyle = "#ffffff";
            ctx.font = `700 ${Math.max(10, badgeSize * 0.55)}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(row.num), badgeCx, badgeCy + 0.5);

            const textX = sidebarX + padX + badgeSize + 8 * scale;
            ctx.textAlign = "left";
            ctx.textBaseline = "alphabetic";
            let lineIdx = 0;
            if (row.author) {
              ctx.fillStyle = "#2B4EE6";
              ctx.font = `700 ${bodyFont}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
              ctx.fillText(row.author, textX, top + bodyFont + lineIdx * lineHeight);
              lineIdx++;
            }
            ctx.fillStyle = "#1c1f26";
            ctx.font = `${bodyFont}px -apple-system, "Apple SD Gothic Neo", sans-serif`;
            row.lines.forEach((line) => {
              ctx.fillText(line, textX, top + bodyFont + lineIdx * lineHeight);
              lineIdx++;
            });
          });

          canvasEl.toBlob((blob) => {
            if (!blob) reject(new Error(t("errCanvasToBlob")));
            else resolve(blob);
          }, "image/png");
        } catch (err) {
          reject(err);
        }
      };
      srcImg.onerror = () => reject(new Error(t("errImageLoad")));
      srcImg.src = imageDataUrl;
    });
  }
})();
