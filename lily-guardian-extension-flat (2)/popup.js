// LILY Guardian — popup logic
//
// Module 1 (Auditoria): send text to the FastAPI backend and render a
//   structured visual alert. Text can be pasted or pulled from the active
//   page's current selection (via the scripting API in the background worker).
// Module 2 (Prova Digital): ask the background worker to capture evidence,
//   save the JSON package locally (anchor download — no `downloads` permission),
//   and show a history kept in chrome.storage.local.

const BACKEND_URL = "https://lily-guardian-backend.onrender.com";
const BACKEND_AUTH = "";
const HISTORY_KEY = "evidence_history";

const SEVERITY_LABELS = {
  none: "Sem violações",
  low: "Baixo",
  medium: "Médio",
  high: "Alto",
};

// ----- Tab switching -------------------------------------------------------

function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetId = tab.getAttribute("aria-controls");
      document.querySelectorAll(".tab").forEach((t) => {
        const active = t === tab;
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      });
      document.querySelectorAll(".panel").forEach((panel) => {
        const active = panel.id === targetId;
        panel.classList.toggle("active", active);
        panel.hidden = !active;
      });
      if (targetId === "panel-evidence") {
        loadHistory();
      }
    });
  });
}

// ----- Helpers -------------------------------------------------------------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showResult(el, html) {
  el.innerHTML = html;
  el.hidden = false;
}

// ----- Module 1: Auditing --------------------------------------------------

function engineLabel(engine) {
  if (engine === "perspective") return "Perspective API";
  if (engine === "lexicon") return "léxico (offline)";
  return engine || "—";
}

function renderAnalysis(result) {
  const severity = result.severity || "none";
  const engine = `<p class="help engine">Motor: ${escapeHtml(engineLabel(result.engine))}</p>`;

  if (!result.flagged) {
    return `
      <h3>Resultado da análise</h3>
      <p><span class="badge ok">Nenhuma violação detectada</span></p>
      <p class="help">O texto analisado (${result.char_count} caracteres) não
      acionou nenhum dos detectores.</p>${engine}`;
  }

  const findingsHtml = (result.findings || [])
    .map((f) => {
      const matches = (f.matches || []).map(escapeHtml).join(", ");
      return `
        <div class="finding">
          <div class="finding-title">${escapeHtml(f.label_pt)} (${f.count})</div>
          <div class="finding-matches">Trechos: ${matches}</div>
        </div>`;
    })
    .join("");

  return `
    <h3>⚠️ Alerta de conteúdo</h3>
    <p>
      Severidade:
      <span class="badge ${severity}">${SEVERITY_LABELS[severity] || severity}</span>
    </p>
    <p class="help">Pontuação de risco: ${result.score} &middot;
      ${result.findings.length} categoria(s) detectada(s).</p>
    ${findingsHtml}${engine}`;
}

async function analyzeText() {
  const input = document.getElementById("audit-input");
  const resultEl = document.getElementById("audit-result");
  const btn = document.getElementById("analyze-btn");
  const text = input.value.trim();

  if (!text) {
    showResult(resultEl, `<p class="error">Cole um texto antes de analisar.</p>`);
    return;
  }

  btn.disabled = true;
  btn.textContent = "Analisando...";
  showResult(
    resultEl,
    `<p class="help">Analisando... no primeiro uso o servidor gratuito pode
    levar até ~1 min para acordar.</p>`
  );

  // Route through the background worker so we reuse its cold-start retry logic
  // and so the host page's CSP never blocks the request.
  const response = await chrome.runtime.sendMessage({
    type: "ANALYZE_TEXT",
    text,
  });
  if (response && response.ok) {
    showResult(resultEl, renderAnalysis(response.data));
  } else {
    const where = response?.backend ? ` (${escapeHtml(response.backend)})` : "";
    showResult(
      resultEl,
      `<p class="error">Não foi possível analisar agora${where}. O servidor
      pode estar acordando — aguarde alguns segundos e tente novamente.</p>
      <p class="help">Detalhe: ${escapeHtml(response?.error || "falha na análise.")}</p>`
    );
  }
  btn.disabled = false;
  btn.textContent = "Analisar Texto";
}

async function useSelection() {
  const input = document.getElementById("audit-input");
  const resultEl = document.getElementById("audit-result");
  const btn = document.getElementById("selection-btn");

  btn.disabled = true;
  btn.textContent = "Lendo seleção...";
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_SELECTION" });
    if (result && result.ok) {
      const selection = (result.selection || "").trim();
      if (!selection) {
        showResult(
          resultEl,
          `<p class="help">Nenhum texto selecionado na página. Selecione um
          trecho e tente novamente.</p>`
        );
      } else {
        input.value = selection;
        resultEl.hidden = true;
      }
    } else {
      showResult(
        resultEl,
        `<p class="error">${escapeHtml(result?.error || "Falha ao ler a seleção.")}</p>`
      );
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Analisar seleção da página";
  }
}

// ----- Module 2: Digital Evidence -----------------------------------------

function triggerDownload(filename, jsonString) {
  const blob = new Blob([jsonString], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function renderEvidence(result) {
  const m = result.metadata;
  return `
    <h3>✅ Evidência registrada</h3>
    <div class="meta-row"><span class="meta-key">Arquivo</span>
      <span class="meta-val">${escapeHtml(result.filename)}</span></div>
    <div class="meta-row"><span class="meta-key">URL</span>
      <span class="meta-val">${escapeHtml(m.url)}</span></div>
    <div class="meta-row"><span class="meta-key">Timestamp (UTC)</span>
      <span class="meta-val">${escapeHtml(m.timestamp_utc)}</span></div>
    <div class="meta-row"><span class="meta-key">IP${m.ip_simulated ? " (simulado)" : ""}</span>
      <span class="meta-val">${escapeHtml(m.ip)}</span></div>
    <div class="meta-row"><span class="meta-key">SHA-256</span>
      <span class="meta-val">${escapeHtml(result.integrity.hash)}</span></div>`;
}

async function registerEvidence() {
  const resultEl = document.getElementById("evidence-result");
  const btn = document.getElementById("evidence-btn");

  btn.disabled = true;
  btn.textContent = "Capturando...";

  try {
    const result = await chrome.runtime.sendMessage({ type: "CAPTURE_EVIDENCE" });
    if (result && result.ok) {
      triggerDownload(result.filename, result.json);
      showResult(resultEl, renderEvidence(result));
      loadHistory();
    } else {
      showResult(
        resultEl,
        `<p class="error">${escapeHtml(result?.error || "Falha desconhecida.")}</p>`
      );
    }
  } catch (e) {
    showResult(
      resultEl,
      `<p class="error">Erro ao registrar evidência: ${escapeHtml(
        e.message || String(e)
      )}</p>`
    );
  } finally {
    btn.disabled = false;
    btn.textContent = "Registrar Evidência";
  }
}

async function loadHistory() {
  const listEl = document.getElementById("evidence-history");
  if (!listEl) return;
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const history = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];

  if (history.length === 0) {
    listEl.innerHTML = `<p class="help">Nenhuma evidência registrada ainda.</p>`;
    return;
  }

  listEl.innerHTML = history
    .map((item) => {
      const hash = (item.integrity && item.integrity.hash) || "";
      return `
        <div class="history-item">
          <div class="history-item-time">${escapeHtml(item.metadata.timestamp_utc)}</div>
          <div class="history-item-url">${escapeHtml(item.metadata.url)}</div>
          <div class="history-item-hash">SHA-256: ${escapeHtml(hash.slice(0, 24))}…</div>
        </div>`;
    })
    .join("");
}

async function clearHistory() {
  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
  loadHistory();
}

// ----- Backend status indicator -------------------------------------------

async function checkBackend() {
  const dot = document.getElementById("backend-status");
  try {
    const res = await fetch(`${BACKEND_URL}/health`, {
      cache: "no-store",
      headers: BACKEND_AUTH ? { Authorization: BACKEND_AUTH } : {},
    });
    if (res.ok) {
      dot.classList.add("online");
      dot.title = "Backend online";
      return;
    }
  } catch (_e) {
    // fall through
  }
  dot.classList.add("offline");
  dot.title = "Backend offline";
}

// ----- Init ----------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  document.getElementById("analyze-btn").addEventListener("click", analyzeText);
  document.getElementById("selection-btn").addEventListener("click", useSelection);
  document.getElementById("evidence-btn").addEventListener("click", registerEvidence);
  document.getElementById("clear-history-btn").addEventListener("click", clearHistory);
  checkBackend();
});
