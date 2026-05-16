// Content script. Lives in the page but renders the overlay inside a Shadow DOM
// host so page CSS can't bleed in (and our overlay CSS doesn't leak out).
//
// Network: all fetches are proxied through the background service worker so
// requests carry chrome-extension:// origin instead of the page's origin.
//
// Patch JS execution: dispatched via chrome.scripting.executeScript(world:"MAIN")
// from the background — that bypasses the page's CSP, which is otherwise strict
// on Gmail and similar.

(() => {
  // Strip any old overlay host that lingered from a previous extension load —
  // ensures the fresh CSS + JS take over after a reload without needing a full page refresh.
  document.getElementById("morph-overlay-host")?.remove();

  const CFG = window.MORPH_CONFIG;
  const HOST_ID = "morph-overlay-host";
  const PATCH_PREFIX = "morph-patch-";
  let patchCounter = 0;
  const undoStack = [];
  let cachedPresets = null;
  let cachedPresetsAt = 0;
  let cssText = null;
  let shadow = null;       // ShadowRoot
  let rootEl = null;       // top-level <div> inside the shadow (the equivalent of old #morph-overlay-root)

  // -------- per-install user id --------
  async function getUserId() {
    return new Promise((resolve) => {
      chrome.storage.local.get([CFG.USER_ID_KEY], (data) => {
        let id = data[CFG.USER_ID_KEY];
        if (!id) {
          id = (crypto.randomUUID && crypto.randomUUID()) ||
               (Date.now().toString(36) + Math.random().toString(36).slice(2));
          chrome.storage.local.set({ [CFG.USER_ID_KEY]: id });
        }
        resolve(id);
      });
    });
  }

  // -------- background-proxied fetch --------
  async function bgFetch(url, init = {}) {
    const resp = await chrome.runtime.sendMessage({ type: "MORPH_FETCH", url, init });
    if (!resp) throw new Error("background worker did not respond");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(resp.text || "").slice(0, 200)}`);
    try { return JSON.parse(resp.text); } catch (_) { return resp.text; }
  }

  // -------- history --------
  async function loadHistory() {
    return new Promise((resolve) => {
      chrome.storage.local.get([CFG.HISTORY_KEY], (data) => {
        resolve(Array.isArray(data[CFG.HISTORY_KEY]) ? data[CFG.HISTORY_KEY] : []);
      });
    });
  }

  async function pushHistory(text) {
    const t = (text || "").trim();
    if (!t) return;
    const list = await loadHistory();
    const dedup = [t, ...list.filter((x) => x !== t)].slice(0, CFG.HISTORY_MAX);
    chrome.storage.local.set({ [CFG.HISTORY_KEY]: dedup });
  }

  // -------- presets --------
  async function loadPresets() {
    const fresh = cachedPresets && (Date.now() - cachedPresetsAt) < CFG.PRESETS_TTL_MS;
    if (fresh) return cachedPresets;
    try {
      const data = await bgFetch(CFG.PRESETS_URL, { method: "GET" });
      cachedPresets = Array.isArray(data.presets) ? data.presets : [];
      cachedPresetsAt = Date.now();
    } catch (e) {
      console.warn("morph: failed to load presets", e);
      cachedPresets = cachedPresets || [];
    }
    return cachedPresets;
  }

  // -------- overlay UI (Shadow DOM) --------
  async function ensureCss() {
    if (cssText !== null) return cssText;
    try {
      const url = chrome.runtime.getURL("overlay/overlay.css");
      const resp = await fetch(url);
      cssText = await resp.text();
    } catch (e) {
      console.warn("morph: failed to load overlay css", e);
      cssText = "";
    }
    return cssText;
  }

  async function buildOverlay() {
    const existing = document.getElementById(HOST_ID);
    if (existing) return existing._morphRootEl;

    const host = document.createElement("div");
    host.id = HOST_ID;
    // The host element gets a couple of high-priority inline styles so even
    // aggressively-styled pages can't push it around.
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
    document.documentElement.appendChild(host);

    const sh = host.attachShadow({ mode: "open" });
    const styleTag = document.createElement("style");
    styleTag.textContent = await ensureCss();
    sh.appendChild(styleTag);

    const root = document.createElement("div");
    root.className = "morph-root";
    root.innerHTML = `
      <div class="morph-backdrop"></div>
      <div class="morph-panel" role="dialog" aria-label="Chrome Morph">
        <div class="morph-presets"><div class="morph-presets-empty">загружаю…</div></div>
        <div class="morph-history-popover" hidden>
          <div class="morph-history-title">Недавние запросы</div>
          <div class="morph-history-list"></div>
        </div>
        <textarea class="morph-input" placeholder="…или опиши своими словами, что сделать со страницей"></textarea>
        <div class="morph-row">
          <div class="morph-mode-toggle" role="tablist" aria-label="Режим">
            <button type="button" data-mode="auto" class="morph-mode-btn active" title="Сервер сам выберет режим">авто</button>
            <button type="button" data-mode="style" class="morph-mode-btn" title="Только CSS — стилистика">стиль</button>
            <button type="button" data-mode="dom" class="morph-mode-btn" title="JS-патч — менять контент">контент</button>
            <button type="button" data-mode="redesign" class="morph-mode-btn" title="Большая перестройка">редизайн</button>
          </div>
          <span class="morph-hint">Enter — отправить</span>
          <button class="morph-icon-btn morph-history-btn" type="button" title="История" aria-label="History">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
          </button>
          <button class="morph-icon-btn morph-undo" type="button" title="Отменить последнее" aria-label="Undo" disabled>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>
          </button>
          <button class="morph-icon-btn morph-reset" type="button" title="Сбросить всё и обновить страницу" aria-label="Reset">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
          </button>
          <button class="morph-btn morph-submit" type="button">Применить</button>
        </div>
      </div>
      <div class="morph-toast"></div>
    `;
    sh.appendChild(root);
    host._morphRootEl = root;
    host._morphShadow = sh;
    shadow = sh;
    rootEl = root;
    wireOverlay(root);
    return root;
  }

  function wireOverlay(root) {
    const $ = (s) => root.querySelector(s);
    const input = $(".morph-input");
    const submit = $(".morph-submit");
    const undo = $(".morph-undo");
    const presetBar = $(".morph-presets");
    const toast = $(".morph-toast");
    const panel = $(".morph-panel");

    const updateUndoUi = () => { undo.disabled = undoStack.length === 0; };

    const showToast = (msg, isError = false, ms = 3200) => {
      toast.textContent = msg;
      toast.classList.toggle("error", isError);
      toast.classList.add("show");
      clearTimeout(toast._t);
      toast._t = setTimeout(() => toast.classList.remove("show"), ms);
    };

    const shrink = () => root.classList.add("morph-shrunk");
    const unshrink = () => root.classList.remove("morph-shrunk");

    panel.addEventListener("click", (e) => {
      if (!root.classList.contains("morph-shrunk")) return;
      // Only expand when the user actually clicked the bubble itself.
      // Buttons/inputs inside the panel must never trigger this — otherwise
      // their click bubbles, hits this handler, and immediately undoes the shrink
      // we just kicked off.
      if (e.target !== panel) return;
      e.stopPropagation();
      unshrink();
    });

    let selectedMode = "auto";
    root.querySelectorAll(".morph-mode-btn").forEach((b) => {
      b.addEventListener("click", () => {
        selectedMode = b.dataset.mode || "auto";
        root.querySelectorAll(".morph-mode-btn").forEach((x) => x.classList.toggle("active", x === b));
      });
    });

    const runRequest = async ({ instruction, mode = "auto", presetId = null }) => {
      submit.disabled = true;
      shrink();
      panel.offsetWidth;
      const minSpinMs = 450;
      const startedAt = Date.now();
      try {
        const patch = await callBackend({ instruction, mode, presetId });
        await applyPatch(patch);
        updateUndoUi();
        const elapsed = Date.now() - startedAt;
        if (elapsed < minSpinMs) await new Promise(r => setTimeout(r, minSpinMs - elapsed));
        hideOverlay();
        const moduleLabel = {style: "стиль", dom: "контент", redesign: "редизайн"}[patch.module] || patch.module || "";
        const notes = patch.notes || "Готово";
        const jsErr = applyPatch._lastJsError;
        if (jsErr) {
          showToast(`[${moduleLabel}] JS-ошибка: ${jsErr}`, true, 7000);
        } else {
          showToast(moduleLabel ? `[${moduleLabel}] ${notes}` : notes);
        }
      } catch (e) {
        unshrink();
        console.error("morph error", e);
        showToast("Ошибка: " + (e.message || e), true, 6000);
      } finally {
        submit.disabled = false;
      }
    };

    const sendFromInput = async () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      await runRequest({ instruction: text, mode: selectedMode });
      pushHistory(text);
    };

    submit.addEventListener("click", (e) => { e.stopPropagation(); sendFromInput(); });
    undo.addEventListener("click", (e) => { e.stopPropagation(); undoLast(); updateUndoUi(); });
    root.querySelector(".morph-reset")?.addEventListener("click", (e) => {
      e.stopPropagation();
      hideOverlay();
      location.reload();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendFromInput(); }
      else if (e.key === "Escape") hideOverlay();
    });
    $(".morph-backdrop").addEventListener("click", hideOverlay);

    const historyPopover = root.querySelector(".morph-history-popover");
    const historyList = root.querySelector(".morph-history-list");
    const historyBtn = root.querySelector(".morph-history-btn");

    historyBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = !historyPopover.hidden;
      if (isOpen) {
        historyPopover.hidden = true;
      } else {
        loadHistory().then((items) => {
          renderHistoryList(historyList, items);
          historyPopover.hidden = false;
        });
      }
    });

    document.addEventListener("click", (e) => {
      if (!historyPopover.hidden && !historyPopover.contains(e.target) && e.target !== historyBtn) {
        historyPopover.hidden = true;
      }
    }, true);

    function renderHistoryList(list, items) {
      list.innerHTML = "";
      if (!items.length) {
        list.innerHTML = '<div class="morph-history-empty">пока пусто</div>';
        return;
      }
      for (const text of items) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "morph-history-row";
        row.textContent = text;
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          historyPopover.hidden = true;
          runRequest({ instruction: text, mode: "auto" });
          pushHistory(text);
        });
        list.appendChild(row);
      }
    }

    root._morphApi = { input, presetBar, runRequest, updateUndoUi };
    updateUndoUi();
  }

  function renderPresets(root, presets) {
    const bar = root._morphApi.presetBar;
    bar.innerHTML = "";
    if (!presets || !presets.length) {
      bar.innerHTML = `<div class="morph-presets-empty">Не достучались до сервера — пресеты пока недоступны. Можно писать своими словами.</div>`;
      return;
    }
    for (const p of presets) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "morph-preset";
      btn.title = p.description || "";
      btn.innerHTML = `<span class="morph-preset-emoji">${p.emoji || "✨"}</span><span>${p.label}</span>`;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        root._morphApi.runRequest({
          instruction: p.instruction,
          mode: p.mode || "auto",
          presetId: p.id,
        });
      });
      bar.appendChild(btn);
    }
  }

  async function showOverlay() {
    const root = await buildOverlay();
    document.getElementById(HOST_ID).style.pointerEvents = "auto";
    root.classList.add("morph-open");
    root.classList.remove("morph-shrunk");
    setTimeout(() => root._morphApi.input.focus(), 30);
    const presets = await loadPresets();
    renderPresets(root, presets);
  }

  function hideOverlay() {
    const host = document.getElementById(HOST_ID);
    if (!host) return;
    const root = host._morphRootEl;
    root.classList.remove("morph-open");
    root.classList.remove("morph-shrunk");
    host.style.pointerEvents = "none";
  }

  function toggleOverlay() {
    const host = document.getElementById(HOST_ID);
    const isOpen = host && host._morphRootEl?.classList.contains("morph-open");
    if (isOpen) hideOverlay();
    else showOverlay();
  }

  // -------- backend call --------
  async function callBackend({ instruction, mode, presetId }) {
    const charLimit = mode === "slow" ? CFG.MAX_HTML_CHARS : CFG.FAST_HTML_CHARS;
    // Strip our own host element so the model doesn't see the overlay.
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("#" + HOST_ID + ", style[id^='" + PATCH_PREFIX + "']").forEach(n => n.remove());
    const html = clone.outerHTML.slice(0, charLimit);

    const userId = await getUserId();
    return await bgFetch(CFG.MORPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Morph-User": userId },
      body: JSON.stringify({
        instruction, mode,
        preset_id: presetId,
        url: location.href,
        title: document.title,
        html,
      }),
    });
  }

  // -------- patch apply / undo --------
  async function applyPatch(patch) {
    const styleEl = document.createElement("style");
    styleEl.id = PATCH_PREFIX + (++patchCounter);
    styleEl.textContent = patch.css || "";
    document.head.appendChild(styleEl);

    const removedNodes = [];
    (patch.remove || []).forEach((sel) => {
      try {
        document.querySelectorAll(sel).forEach((node) => {
          if (node.id === HOST_ID || node.closest?.("#" + HOST_ID)) return;
          removedNodes.push({ node, parent: node.parentNode, nextSibling: node.nextSibling });
          node.parentNode.removeChild(node);
        });
      } catch (e) { console.warn("morph: bad selector", sel, e); }
    });

    let jsResult = null;
    if (patch.js && patch.js.trim()) {
      try {
        // CSP-safe execution: ask the background SW to run the code in the
        // tab's MAIN world via chrome.scripting.executeScript — that bypasses
        // the page's strict CSP (gmail.com, github.com, etc.).
        jsResult = await chrome.runtime.sendMessage({ type: "MORPH_EXEC", code: patch.js });
        if (jsResult && jsResult.ok === false) {
          console.error("[chrome-morph] JS patch failed:", jsResult.error, "\nCode:\n", patch.js);
        } else {
          console.debug("[chrome-morph] JS patch ran ok");
        }
      } catch (e) {
        console.error("[chrome-morph] MORPH_EXEC transport failed", e);
        jsResult = { ok: false, error: String(e?.message || e) };
      }
    }
    applyPatch._lastJsError = jsResult && jsResult.ok === false ? jsResult.error : null;

    undoStack.push({ styleEl, removedNodes });
    if (undoStack.length > CFG.UNDO_DEPTH) undoStack.shift();
  }

  function undoLast() {
    const entry = undoStack.pop();
    if (!entry) return;
    entry.styleEl?.remove();
    for (let i = entry.removedNodes.length - 1; i >= 0; i--) {
      const { node, parent, nextSibling } = entry.removedNodes[i];
      try { parent.insertBefore(node, nextSibling); } catch (_) {}
    }
  }

  // -------- message listener --------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "MORPH_TOGGLE") { toggleOverlay(); sendResponse({ ok: true }); }
    else if (msg?.type === "MORPH_PING") { sendResponse({ ok: true }); }
  });
})();
