// Service worker: routes the hotkey + toolbar click, and proxies fetch calls
// from content scripts so requests carry the chrome-extension:// origin instead
// of the page's origin (Gmail, etc.) — that way our CORS policy actually matches.

async function ensureInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "MORPH_PING" });
    return true;
  } catch (_) {
    // Not present — inject below.
  }
  try {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["overlay/overlay.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["config.js", "content.js"],
    });
    return true;
  } catch (e) {
    console.warn("morph: injection failed", e);
    return false;
  }
}

async function toggleInActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (tab.url && /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) {
    console.warn("morph: cannot run on", tab.url);
    return;
  }
  if (!await ensureInjected(tab.id)) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "MORPH_TOGGLE" });
  } catch (e) {
    console.warn("morph: sendMessage failed", e);
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-morph") toggleInActiveTab();
});

chrome.action.onClicked.addListener(toggleInActiveTab);

// Proxy fetch for content scripts (avoids CORS on third-party pages),
// and execute arbitrary JS in the page's MAIN world (bypasses page CSP).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "MORPH_FETCH") {
    (async () => {
      try {
        const resp = await fetch(msg.url, msg.init || {});
        const text = await resp.text();
        sendResponse({ ok: resp.ok, status: resp.status, text });
      } catch (e) {
        sendResponse({ ok: false, status: 0, text: String(e?.message || e) });
      }
    })();
    return true;
  }
  if (msg?.type === "MORPH_EXEC") {
    const tabId = sender?.tab?.id;
    if (!tabId) { sendResponse({ ok: false, error: "no tab" }); return true; }
    (async () => {
      // Primary path: chrome.userScripts.execute (Chrome 135+). Bypasses both
      // extension and page CSP since the user opted into Developer mode.
      try {
        if (chrome.userScripts?.execute) {
          const r = await chrome.userScripts.execute({
            target: { tabId },
            world: "MAIN",
            js: [{ code: msg.code || "" }],
          });
          const inj = r?.[0];
          if (inj?.error) {
            sendResponse({ ok: false, error: String(inj.error.message || inj.error) });
          } else {
            sendResponse({ ok: true });
          }
          return;
        }
      } catch (e) {
        // userScripts API is present but failed (likely "user scripts not allowed
        // for this extension" — Chrome 138+ requires per-extension opt-in).
        // Fall through to the scripting.executeScript path below.
        console.warn("[chrome-morph] userScripts.execute failed, falling back:", e);
      }
      // Fallback: scripting.executeScript with eval. Works on most sites but
      // gets blocked by strict CSP (github.com, gmail.com).
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: (code) => {
            try { (0, eval)(code); return { ok: true }; }
            catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
          },
          args: [msg.code || ""],
        });
        sendResponse(results?.[0]?.result || { ok: false, error: "no result" });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
});
