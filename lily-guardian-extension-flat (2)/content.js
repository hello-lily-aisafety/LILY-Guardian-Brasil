// LILY Guardian — content script
//
// Injects a discreet floating panel (bottom-right) into any http/https page with
// two actions:
//   - "Analisar seleção": reads the current page text selection and sends it to
//     the analysis backend, rendering a structured result in the panel.
//   - "Registrar evidência": asks the background worker to capture the visible
//     tab (screenshot + metadata + SHA-256), downloads the JSON package and
//     shows the integrity hash.
//
// This is an alternative trigger to the toolbar popup, useful where the popup /
// keyboard command is not reachable. Capture is performed in the background
// worker; the panel is hidden during capture so it does not appear in the print.

(function () {
  if (window.__lilyGuardianInjected) return;
  window.__lilyGuardianInjected = true;

  const SEVERITY_LABELS = {
    none: "Sem violações",
    low: "Baixo",
    medium: "Médio",
    high: "Alto",
  };

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const c of children) {
      node.append(c.nodeType ? c : document.createTextNode(c));
    }
    return node;
  }

  // ---- Build the floating panel ----
  const root = el("div", { id: "lily-guardian-root" });

  const header = el("div", { className: "lg-header" }, ["🛡️ LILY Guardian"]);
  const toggle = el("button", { className: "lg-toggle", title: "Minimizar", textContent: "—" });
  header.append(toggle);

  const analyzeBtn = el("button", { className: "lg-btn lg-primary", textContent: "Analisar seleção" });
  const evidenceBtn = el("button", { className: "lg-btn", textContent: "Registrar evidência" });
  const result = el("div", { className: "lg-result", id: "lg-result" });
  result.style.display = "none";

  const body = el("div", { className: "lg-body" }, [analyzeBtn, evidenceBtn, result]);

  root.append(header, body);
  document.documentElement.append(root);

  toggle.addEventListener("click", () => {
    const collapsed = root.classList.toggle("lg-collapsed");
    toggle.textContent = collapsed ? "+" : "—";
    toggle.title = collapsed ? "Expandir" : "Minimizar";
  });

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showResult(html) {
    result.innerHTML = html;
    result.style.display = "block";
  }

  // ---- Module 1: analyze the page selection ----
  function engineLabel(engine) {
    if (engine === "perspective") return "Perspective API";
    if (engine === "lexicon") return "léxico (offline)";
    return engine || "—";
  }

  function renderAnalysis(data) {
    const severity = data.severity || "none";
    const engine = `<div class="lg-engine">Motor: ${escapeHtml(engineLabel(data.engine))}</div>`;
    if (!data.flagged) {
      return `<div class="lg-badge ok">Nenhuma violação detectada</div>
        <div class="lg-help">${data.char_count} caractere(s) analisados.</div>${engine}`;
    }
    const findings = (data.findings || [])
      .map((f) => {
        const matches = (f.matches || []).map(escapeHtml).join(", ");
        return `<div class="lg-finding"><b>${escapeHtml(f.label_pt)}</b> (${f.count})
          <div class="lg-matches">${matches}</div></div>`;
      })
      .join("");
    return `<div class="lg-badge ${severity}">Severidade: ${SEVERITY_LABELS[severity] || severity}</div>
      <div class="lg-help">Pontuação ${data.score} · ${data.findings.length} categoria(s).</div>
      ${findings}${engine}`;
  }

  analyzeBtn.addEventListener("click", async () => {
    const selection = (window.getSelection ? window.getSelection().toString() : "").trim();
    if (!selection) {
      showResult(`<div class="lg-help">Selecione um trecho de texto na página e clique novamente.</div>`);
      return;
    }
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = "Analisando...";
    showResult(
      `<div class="lg-help">Analisando... no primeiro uso o servidor gratuito ` +
        `pode levar até ~1 min para acordar.</div>`
    );
    let response;
    try {
      // Run the request in the background worker so the host page's CSP does
      // not block it — this makes analysis work on any site.
      response = await chrome.runtime.sendMessage({ type: "ANALYZE_TEXT", text: selection });
    } catch (e) {
      response = { ok: false, error: e?.message || String(e) };
    }
    if (response && response.ok) {
      showResult(renderAnalysis(response.data));
    } else {
      const where = response?.backend ? ` (${escapeHtml(response.backend)})` : "";
      showResult(
        `<div class="lg-err">Não foi possível analisar agora${where}. ` +
          `O servidor pode estar acordando — aguarde alguns segundos e ` +
          `clique novamente. Detalhe: ${escapeHtml(response?.error || "falha na análise.")}</div>`
      );
    }
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = "Analisar seleção";
  });

  // ---- Module 2: register evidence ----
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

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  evidenceBtn.addEventListener("click", async () => {
    evidenceBtn.disabled = true;
    evidenceBtn.textContent = "Capturando...";
    // Hide the panel so it is not part of the screenshot.
    const prevVisibility = root.style.visibility;
    root.style.visibility = "hidden";
    await wait(150);
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "CAPTURE_EVIDENCE" });
    } catch (e) {
      response = { ok: false, error: e.message || String(e) };
    }
    root.style.visibility = prevVisibility;
    if (response && response.ok) {
      triggerDownload(response.filename, response.json);
      const m = response.metadata;
      showResult(`<div class="lg-badge ok">Evidência registrada</div>
        <div class="lg-meta"><b>Arquivo:</b> ${escapeHtml(response.filename)}</div>
        <div class="lg-meta"><b>URL:</b> ${escapeHtml(m.url)}</div>
        <div class="lg-meta"><b>UTC:</b> ${escapeHtml(m.timestamp_utc)}</div>
        <div class="lg-meta"><b>IP${m.ip_simulated ? " (simulado)" : ""}:</b> ${escapeHtml(m.ip)}</div>
        <div class="lg-meta lg-hash"><b>SHA-256:</b> ${escapeHtml(response.integrity.hash)}</div>`);
    } else {
      showResult(`<div class="lg-err">${escapeHtml(response?.error || "Falha ao capturar.")}</div>`);
    }
    evidenceBtn.disabled = false;
    evidenceBtn.textContent = "Registrar evidência";
  });
})();
