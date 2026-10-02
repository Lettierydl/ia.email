// Modo "Auxiliar" na página do piloto (/autopilot): nunca envia nada; analisa
// vários e-mails e mostra "como eu responderia" (com a base usada) e "sem
// contexto suficiente". Usa $, escHtml, workingHTML do app.js.
(function () {
  if (location.pathname !== "/autopilot") return;

  const SOURCE = { kb: "cérebro", mail: "e-mail recebido", mail_sent: "resposta sua" };
  const LIMIT_KEY = "ia_email_assist_limit";
  let pollTimer = null;
  let mode = "piloto";
  let running = false;

  const get = async (url) => {
    try {
      const res = await fetch(url);
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  const post = async (url, body) => {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, data };
    } catch {
      return { ok: false, data: { detail: "Sem conexão com o servidor." } };
    }
  };
  const notify = (text) => {
    if (typeof showBanner === "function") {
      showBanner(text, true);
      setTimeout(() => showBanner("", false), 4000);
    }
  };

  // ── modo ──
  function applyMode() {
    document.querySelectorAll(".ap-mode").forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    });
    $("ap-piloto-only").classList.toggle("hidden", mode === "auxiliar");
    $("ap-enabled-label").textContent =
      mode === "auxiliar" ? "Analisar e-mails novos sozinho, aos poucos (nunca envia)" : "Ligar o piloto automático";
  }

  async function initMode() {
    const data = await get("/api/settings");
    mode = (data && data.settings && data.settings.autopilot_mode) || "piloto";
    applyMode();
    document.querySelectorAll(".ap-mode").forEach((b) => {
      b.onclick = async () => {
        const previous = mode;
        mode = b.dataset.mode;
        applyMode();
        const { ok, data: d } = await post("/api/settings", { autopilot_mode: mode });
        if (!ok) {
          mode = previous;
          applyMode();
          notify(typeof d.detail === "string" ? d.detail : "Não consegui trocar o modo.");
        }
      };
    });
  }

  // ── relatório ──
  function evidenceHTML(list) {
    if (!list.length) return "";
    return `<details class="as-basis">
      <summary>Em que me baseei (${list.length})</summary>
      ${list
        .map(
          (e) => `<div class="as-ev">
            <span class="as-chip">${escHtml(SOURCE[e.source] || e.source)}</span>
            <span class="as-ev-title">${escHtml(e.title)}</span>
            ${e.why ? `<span class="as-ev-why">${escHtml(e.why)}</span>` : ""}
            <span class="as-ev-snippet">${escHtml(e.snippet)}</span>
          </div>`
        )
        .join("")}
    </details>`;
  }

  function head(item) {
    const who = item.from_name || item.from_email;
    return `<div class="as-head">
      <strong class="as-subject">${escHtml(item.subject || "(sem assunto)")}</strong>
      <span class="as-from">${escHtml(who)}</span>
      ${item.sensitive ? '<span class="as-chip warn">tema sensível: revise com atenção</span>' : ""}
    </div>`;
  }

  function renderReport(rep) {
    const sug = rep.suggestions || [];
    const gaps = rep.gaps || [];
    $("ap-assist-n-sug").textContent = sug.length;
    $("ap-assist-n-gap").textContent = gaps.length;
    const noReply = rep.no_reply || [];
    $("ap-assist-n-no").textContent = noReply.length;
    const total = sug.length + gaps.length;
    const info = noReply.length ? ` ${noReply.length} ${noReply.length === 1 ? "não pede" : "não pedem"} resposta.` : "";
    $("ap-assist-summary").textContent = total
      ? `Consigo responder ${sug.length} de ${total} e-mails que pedem algo, com base no que você já decidiu; ${gaps.length} ${gaps.length === 1 ? "precisa" : "precisam"} de contexto.${info}`
      : running
        ? ""
        : noReply.length
          ? `Nenhum e-mail pede resposta agora.${info}`
          : "Nenhuma análise pendente. Clique em “Analisar minha caixa” para eu ver os e-mails que esperam resposta.";

    $("ap-assist-suggestions").innerHTML = sug.length
      ? sug
          .map(
            (it) => `<article class="as-card" data-id="${escHtml(it.id)}">
              ${head(it)}
              <p class="as-conf">confiança ${Math.round(it.confidence * 100)}%</p>
              <div class="as-draft">${escHtml(it.draft_text)}</div>
              ${evidenceHTML(it.evidence)}
              <div class="as-actions">
                <button type="button" class="primary" data-use="${escHtml(it.id)}">Usar como rascunho</button>
                <a class="ghost as-link" href="/mail/${encodeURIComponent(it.thread_id)}">Abrir e-mail</a>
                <button type="button" class="ghost" data-dismiss="${escHtml(it.id)}">Descartar</button>
              </div>
            </article>`
          )
          .join("")
      : '<p class="files-empty">Nenhuma resposta sugerida agora.</p>';

    $("ap-assist-gaps").innerHTML = gaps.length
      ? gaps
          .map(
            (it) => `<article class="as-card gap" data-id="${escHtml(it.id)}">
              ${head(it)}
              <p class="as-why"><strong>O que falta:</strong> ${escHtml(it.reasoning)}</p>
              ${it.question ? `<p class="as-question"><strong>Pergunta pra você:</strong> ${escHtml(it.question)}</p>` : ""}
              ${evidenceHTML(it.evidence)}
              <div class="as-actions">
                <a class="primary as-link" href="/mail/${encodeURIComponent(it.thread_id)}">Abrir e-mail</a>
                <button type="button" class="ghost" data-dismiss="${escHtml(it.id)}">Descartar</button>
              </div>
            </article>`
          )
          .join("")
      : '<p class="files-empty">Nada sem contexto no momento.</p>';

    $("ap-assist-noreply").innerHTML = noReply
      .map(
        (it) => `<article class="as-card quiet" data-id="${escHtml(it.id)}">
          ${head(it)}
          <p class="as-why">${escHtml(it.reasoning)}</p>
          <div class="as-actions">
            <a class="ghost as-link" href="/mail/${encodeURIComponent(it.thread_id)}">Abrir e-mail</a>
            <button type="button" class="ghost" data-dismiss="${escHtml(it.id)}">Ok, ignorar</button>
          </div>
        </article>`
      )
      .join("");

    document.querySelectorAll("[data-use]").forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        b.textContent = "Preparando…";
        const { ok, data } = await post(`/api/assistant/${encodeURIComponent(b.dataset.use)}/use`);
        if (ok) {
          window.location.href = `/mail/${encodeURIComponent(data.thread_id)}`;
        } else {
          b.disabled = false;
          b.textContent = "Usar como rascunho";
          notify(typeof data.detail === "string" ? data.detail : "Não consegui usar essa sugestão.");
          loadReport();
        }
      };
    });
    document.querySelectorAll("[data-dismiss]").forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        await post(`/api/assistant/${encodeURIComponent(b.dataset.dismiss)}/dismiss`);
        loadReport();
      };
    });
  }

  async function loadReport() {
    const rep = await get("/api/assistant/report");
    if (rep) renderReport(rep);
  }

  // ── execução em lote ──
  function showProgress(st) {
    running = !!st.running;
    const box = $("ap-assist-progress");
    box.classList.toggle("hidden", !st.running);
    $("ap-assist-run").disabled = !!st.running;
    $("ap-assist-cancel").classList.toggle("hidden", !st.running);
    if (!st.running) return;
    const label = st.current ? `Analisando ${Math.min(st.done + 1, st.total)} de ${st.total}: ${st.current.slice(0, 70)}` : `Analisando ${st.total} e-mails`;
    $("ap-assist-working").innerHTML = workingHTML(label);
    $("ap-assist-bar").style.width = `${st.total ? Math.round((st.done / st.total) * 100) : 0}%`;
    $("ap-assist-counts").textContent = `${st.suggested} com resposta · ${st.gaps} sem contexto${st.no_reply ? ` · ${st.no_reply} sem pedido` : ""}${st.errors ? ` · ${st.errors} com erro` : ""}`;
  }

  async function poll() {
    clearTimeout(pollTimer);
    const st = await get("/api/assistant/status");
    if (!st) return;
    showProgress(st);
    if (st.running) {
      loadReport();
      pollTimer = setTimeout(poll, 1500);
    } else {
      await loadReport();
      if (st.finished_at && st.total) {
        const extra = st.errors ? ` (${st.errors} não deram certo)` : "";
        $("ap-assist-counts").textContent = "";
        $("ap-assist-summary").textContent += extra;
      }
    }
  }

  async function initRun() {
    try {
      const saved = localStorage.getItem(LIMIT_KEY);
      if (saved && [...$("ap-assist-limit").options].some((o) => o.value === saved)) $("ap-assist-limit").value = saved;
    } catch {
      /* sem armazenamento local: segue com o padrão */
    }
    $("ap-assist-limit").onchange = () => {
      try {
        localStorage.setItem(LIMIT_KEY, $("ap-assist-limit").value);
      } catch {
        /* ignora */
      }
    };
    $("ap-assist-run").onclick = async () => {
      $("ap-assist-run").disabled = true;
      const { ok, data } = await post(`/api/assistant/run?limit=${encodeURIComponent($("ap-assist-limit").value)}`);
      if (!ok) {
        $("ap-assist-run").disabled = false;
        notify(typeof data.detail === "string" ? data.detail : "Não consegui iniciar a análise.");
        return;
      }
      if (!data.running && !data.total) {
        $("ap-assist-run").disabled = false;
        $("ap-assist-summary").textContent = "Não há e-mails novos esperando resposta que eu ainda não tenha analisado.";
        return;
      }
      showProgress(data);
      poll();
    };
    $("ap-assist-cancel").onclick = async () => {
      $("ap-assist-cancel").disabled = true;
      await post("/api/assistant/cancel");
      $("ap-assist-cancel").disabled = false;
    };
    await poll();
  }

  initMode();
  initRun();
})();
