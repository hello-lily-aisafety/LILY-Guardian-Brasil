// LILY Guardian — background service worker (Manifest V3)
//
// Responsibilities:
//  - Digital Evidence Preservation: capture the active tab, collect metadata
//    (URL, UTC timestamp, IP), compute a SHA-256 hash for integrity, and return
//    the packaged JSON to the popup (which performs the local download). A
//    lightweight history record (no screenshot) is kept in chrome.storage.local.
//  - Page selection: read the user's selected text from the active tab via the
//    scripting API so it can be audited.
//
// Least privilege: permissions are limited to activeTab, storage and scripting;
// host access is limited to the IP API and the local analysis backend. The
// screenshot never leaves the extension context.

// Backend base URL. Update this to the deployed backend (e.g. Render) so the
// extension works without a local server.
const BACKEND_URL = "https://lily-guardian-backend.onrender.com";
// Optional Authorization header (leave empty for the public Render backend).
const BACKEND_AUTH = "";

const IP_ENDPOINT = "https://api.ipify.org?format=json";
const HISTORY_KEY = "evidence_history";
const HISTORY_LIMIT = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call the analysis backend from the service worker. Doing the request here
 * (instead of in the content script) avoids the host page's Content-Security-
 * Policy blocking the request, so analysis works on any site.
 *
 * The backend runs on Render's free plan, which sleeps after ~15 min of
 * inactivity. The first request after sleep can take ~30-60s and may briefly
 * return 502/503/504 while the service wakes. We therefore retry transient
 * failures with a backoff so analysis does not silently fail on a cold start.
 */
async function analyzeText(text) {
  const headers = { "Content-Type": "application/json" };
  if (BACKEND_AUTH) headers["Authorization"] = BACKEND_AUTH;
  const body = JSON.stringify({ text });
  const maxAttempts = 4;
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${BACKEND_URL}/analyze`, {
        method: "POST",
        headers,
        body,
      });
      if (res.ok) {
        return { ok: true, data: await res.json() };
      }
      // 5xx usually means the free-tier server is still waking up — retry.
      lastError = `HTTP ${res.status}`;
      if (res.status < 500 || attempt === maxAttempts) {
        return { ok: false, error: lastError, backend: BACKEND_URL };
      }
    } catch (e) {
      lastError = e?.message || String(e);
      if (attempt === maxAttempts) {
        return { ok: false, error: lastError, backend: BACKEND_URL };
      }
    }
    await sleep(attempt * 3000); // 3s, 6s, 9s backoff for cold starts
  }
  return { ok: false, error: lastError, backend: BACKEND_URL };
}

/** Convert an ArrayBuffer to a lowercase hex string. */
function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Compute the SHA-256 hash (hex) of a string. */
async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bufferToHex(digest);
}

/**
 * Fetch the public IP over HTTPS. The request is asynchronous and errors are
 * handled gracefully, falling back to a clearly-labelled simulated value
 * (allowed for the MVP) so evidence capture never fails on a network error.
 */
async function collectIp() {
  try {
    const res = await fetch(IP_ENDPOINT, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ip) {
        return { ip: data.ip, simulated: false };
      }
    }
  } catch (_e) {
    // network/permission error — fall back to a simulated value
  }
  const simulated = `198.51.100.${Math.floor(Math.random() * 254) + 1}`;
  return { ip: simulated, simulated: true };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Persist a lightweight history record (metadata + hash, no screenshot). */
async function appendHistory(record) {
  try {
    const stored = await chrome.storage.local.get(HISTORY_KEY);
    const history = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
    history.unshift(record);
    await chrome.storage.local.set({
      [HISTORY_KEY]: history.slice(0, HISTORY_LIMIT),
    });
  } catch (_e) {
    // storage failure should not block the capture result
  }
}

/**
 * Capture evidence from the active tab. Returns the full JSON package as a
 * string so the popup can save it locally (no `downloads` permission needed).
 */
async function captureEvidence() {
  const tab = await getActiveTab();
  if (!tab) {
    return { ok: false, error: "Nenhuma aba ativa encontrada." };
  }

  let screenshot;
  try {
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
  } catch (e) {
    return {
      ok: false,
      error:
        "Não foi possível capturar a tela desta aba (páginas internas do " +
        "navegador não permitem captura). Detalhe: " + (e?.message || e),
    };
  }

  const ipInfo = await collectIp();
  const timestamp = new Date().toISOString(); // UTC, ISO-8601

  const metadata = {
    url: tab.url || "",
    title: tab.title || "",
    timestamp_utc: timestamp,
    ip: ipInfo.ip,
    ip_simulated: ipInfo.simulated,
    user_agent: navigator.userAgent,
    capture_tool: "LILY Guardian",
    capture_version: chrome.runtime.getManifest().version,
  };

  // The integrity hash covers metadata + screenshot, excluding the hash itself.
  const integrityPayload = JSON.stringify({ metadata, screenshot });
  const hash = await sha256Hex(integrityPayload);

  const evidencePackage = {
    metadata,
    screenshot, // data:image/png;base64,... — kept local, never uploaded
    integrity: {
      algorithm: "SHA-256",
      hash,
      hashed_fields: ["metadata", "screenshot"],
    },
  };

  const safeStamp = timestamp.replace(/[:.]/g, "-");
  const filename = `lily-evidence-${safeStamp}.json`;

  await appendHistory({ filename, metadata, integrity: evidencePackage.integrity });

  return {
    ok: true,
    filename,
    json: JSON.stringify(evidencePackage, null, 2),
    metadata,
    integrity: evidencePackage.integrity,
  };
}

/** Read the selected text from the active tab using the scripting API. */
async function getPageSelection() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    return { ok: false, error: "Nenhuma aba ativa encontrada." };
  }
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window.getSelection ? window.getSelection().toString() : ""),
    });
    return { ok: true, selection: (result && result.result) || "" };
  } catch (e) {
    return {
      ok: false,
      error:
        "Não foi possível ler a seleção desta página (páginas internas não " +
        "permitem). Detalhe: " + (e?.message || e),
    };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CAPTURE_EVIDENCE") {
    captureEvidence()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "ANALYZE_TEXT") {
    analyzeText(message.text || "")
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (message?.type === "GET_SELECTION") {
    getPageSelection()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  return false;
});
