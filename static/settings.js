// Página de Configurações (/settings). Substitui o antigo modal: cada seção
// é um cartão que salva sozinho, e os campos de caminho viraram um seletor
// de pastas/arquivos. Usa $, escHtml, formatSummary e SUMMARY_HEADERS do app.js.
(function () {
  if (location.pathname !== "/settings") return;

  // Ícones do módulo compartilhado (static/icons.js), o mesmo de todas as páginas
  const ico = (n) => window.Icons.svg(n);
  const ICON = {
    folder: ico("folder"), file: ico("file"), up: ico("chevron-up"), down: ico("chevron-down"),
    close: ico("close"), check: ico("check"), chevron: ico("chevron-right"), trash: ico("trash"),
  };

  const PROVIDER_LABEL = { gemini: "Google (direto)", anthropic: "Anthropic (direto)", openrouter: "OpenRouter" };
  const SUMMARY_SUGGESTIONS = [
    "Sempre foque em quem está falando: quem pede, em que tom e o que espera de mim.",
    "Destaque prazos, valores e nomes logo no começo.",
    "Seja ainda mais curto: no máximo 5 linhas.",
    "Ignore assinaturas, avisos legais e histórico citado.",
    "Avise quando a decisão já foi tomada por outra pessoa.",
  ];

  let settings = {};
  let toastTimer = null;

  // ── utilidades ──
  function toast(message, isError) {
    const el = $("st-toast");
    el.textContent = message;
    el.classList.toggle("error", !!isError);
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 4000 : 1800);
  }

  async function getJSON(url, fallback) {
    try {
      const res = await fetch(url);
      const data = await res.json().catch(() => fallback);
      return res.ok ? data : { ...fallback, _error: data && data.detail };
    } catch {
      return { ...fallback, _error: "Sem conexão com o servidor." };
    }
  }

  async function saveSettings(patch, quiet) {
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(typeof data.detail === "string" ? data.detail : "Não consegui salvar.", true);
        return null;
      }
      settings = data.settings || settings;
      if (!quiet) toast("Salvo");
      return settings;
    } catch {
      toast("Sem conexão com o servidor.", true);
      return null;
    }
  }

  const debounce = (fn, ms) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  function fmtMinutes(m) {
    m = Math.round(m);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  }

  // "a/b/c.md" -> nome em destaque + pasta em cinza (caminho inteiro quebrando no meio é ilegível)
  function fileLabel(rel) {
    const i = rel.lastIndexOf("/");
    const dir = i >= 0 ? rel.slice(0, i + 1) : "";
    const name = i >= 0 ? rel.slice(i + 1) : rel;
    return `<span class="st-file-name">${escHtml(name)}</span>${dir ? `<span class="st-file-dir">${escHtml(dir)}</span>` : ""}`;
  }

  const fmtBytes = (n) => (!n ? "0 B" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const fmtWhen = (ts) =>
    new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ts * 1000));

  // ── 1. Uso ──
  let metricsData = null;
  let metricsRange = "week";

  function dayLabel(date, total, i) {
    const [y, mo, da] = date.split("-").map(Number);
    if (total <= 10) return new Intl.DateTimeFormat("pt-BR", { weekday: "short" }).format(new Date(y, mo - 1, da)).replace(".", "");
    return i % 5 === 0 || i === total - 1 ? String(da) : "";
  }

  function renderAutopilotMetrics(ap) {
    if (!ap) return;
    const levels = { conservador: "Conservador", moderado: "Moderado", autonomo: "Autônomo" };
    const pill = $("ap-m-pill");
    pill.textContent = ap.enabled ? `Ligado · ${levels[ap.level] || ap.level}` : "Desligado";
    pill.classList.toggle("on", ap.enabled);
    $("ap-m-sub").textContent = ap.decisions
      ? `${ap.decisions} decisões no período; ${ap.automation_rate}% viraram resposta enviada sozinha.`
      : ap.enabled
        ? "Ligado, mas ainda não analisou nenhum e-mail neste período."
        : "Desligado. Quando você ligar, aqui aparece tudo o que ele analisou, respondeu e deixou pra você.";
    $("ap-m-decisions").textContent = ap.decisions;
    $("ap-m-sent").textContent = ap.auto_sent;
    const extra = [ap.auto_pending ? `${ap.auto_pending} na fila` : "", ap.auto_failed ? `${ap.auto_failed} falhou` : ""].filter(Boolean);
    $("ap-m-sent-sub").textContent = extra.length ? `(${extra.join(" · ")})` : "";
    $("ap-m-drafts").textContent = ap.drafts;
    $("ap-m-alerts").textContent = ap.alerts;
    $("ap-m-rate").textContent = `${ap.automation_rate}%`;
    $("ap-m-saved").textContent = fmtMinutes(ap.saved_minutes);
    $("ap-m-cancelled").textContent = ap.auto_cancelled;
    $("ap-m-cancel-sub").textContent = ap.auto_cancelled ? "(dentro do tempo de segurança)" : "";
    const a = ap.assist || { suggested: 0, used: 0, gaps: 0 };
    $("ap-m-assist").textContent =
      a.suggested || a.gaps
        ? `Modo Auxiliar: ${a.suggested} resposta${a.suggested === 1 ? "" : "s"} sugerida${a.suggested === 1 ? "" : "s"} (${a.used} usada${a.used === 1 ? "" : "s"} por você) e ${a.gaps} e-mail${a.gaps === 1 ? "" : "s"} sem contexto suficiente.`
        : "";
    const bars = $("ap-m-bars");
    const legend = bars.nextElementSibling;
    bars.style.display = legend.style.display = ap.decisions ? "" : "none";
    if (!ap.decisions) return;
    const days = ap.daily;
    const max = Math.max(1, ...days.map((d) => Math.max(d.auto_sent, d.drafts, d.alerts)));
    bars.className = `st-bars ${days.length > 10 ? "dense" : ""}`;
    bars.innerHTML = days
      .map((d, i) => {
        const [, mo, da] = d.date.split("-").map(Number);
        const tip = `${String(da).padStart(2, "0")}/${String(mo).padStart(2, "0")}: ${d.auto_sent} enviados sozinho, ${d.drafts} rascunhos, ${d.alerts} alertas`;
        const h = (n) => Math.round((n / max) * 100);
        return `<div class="st-bar-col" data-tooltip="${escHtml(tip)}">
          <div class="st-bar-pair three"><i class="bar-s" style="height:${h(d.auto_sent)}%"></i><i class="bar-d" style="height:${h(d.drafts)}%"></i><i class="bar-al" style="height:${h(d.alerts)}%"></i></div>
          <span>${escHtml(dayLabel(d.date, days.length, i))}</span>
        </div>`;
      })
      .join("");
  }

  function renderMetrics() {
    if (!metricsData) return;
    const m = metricsData[metricsRange];
    $("m-analyzed").textContent = m.analyzed;
    $("m-answered").textContent = m.answered;
    $("m-auto").textContent = m.answered_by_autopilot ? `(${m.answered_by_autopilot} pelo piloto)` : "";
    $("m-saved").textContent = fmtMinutes(m.saved_minutes);
    $("m-saved-sub").textContent = m.saved_minutes ? `(~${fmtMinutes(m.saved_per_day_minutes)} por dia)` : "";
    $("m-assumptions").textContent =
      `Estimativa: ${m.assumptions.minutes_per_summary} min por resumo gerado + ${m.assumptions.minutes_per_reply} min por resposta enviada.`;

    renderAutopilotMetrics(m.autopilot);
    const days = m.daily;
    const max = Math.max(1, ...days.map((d) => Math.max(d.analyzed, d.answered)));
    $("m-bars").className = `st-bars ${days.length > 10 ? "dense" : ""}`;
    $("m-bars").innerHTML = days
      .map((d, i) => {
        const [y, mo, da] = d.date.split("-").map(Number);
        const label =
          days.length <= 10
            ? new Intl.DateTimeFormat("pt-BR", { weekday: "short" }).format(new Date(y, mo - 1, da)).replace(".", "")
            : i % 5 === 0 || i === days.length - 1
              ? String(da)
              : "";
        const tip = `${String(da).padStart(2, "0")}/${String(mo).padStart(2, "0")}: ${d.analyzed} analisados, ${d.answered} respondidos`;
        return `<div class="st-bar-col" data-tooltip="${escHtml(tip)}">
          <div class="st-bar-pair">
            <i class="bar-a" style="height:${Math.round((d.analyzed / max) * 100)}%"></i>
            <i class="bar-b" style="height:${Math.round((d.answered / max) * 100)}%"></i>
          </div>
          <span>${escHtml(label)}</span>
        </div>`;
      })
      .join("");
  }

  async function initMetrics() {
    metricsData = await getJSON("/api/metrics", null);
    if (!metricsData || !metricsData.week) {
      $("m-assumptions").textContent = "Não consegui carregar as métricas agora.";
      return;
    }
    $("m-min-summary").value = metricsData.week.assumptions.minutes_per_summary;
    $("m-min-reply").value = metricsData.week.assumptions.minutes_per_reply;
    renderMetrics();
    document.querySelectorAll(".st-seg [data-range]").forEach((btn) => {
      btn.onclick = () => {
        metricsRange = btn.dataset.range;
        document.querySelectorAll(".st-seg [data-range]").forEach((b) => b.classList.toggle("on", b === btn));
        renderMetrics();
      };
    });
    $("m-save").onclick = async () => {
      const a = parseFloat($("m-min-summary").value);
      const b = parseFloat($("m-min-reply").value);
      if (!(a >= 0) || !(b >= 0)) {
        toast("Use números de 0 para cima.", true);
        return;
      }
      if (await saveSettings({ metric_minutes_summary: a, metric_minutes_reply: b })) {
        metricsData = await getJSON("/api/metrics", metricsData);
        renderMetrics();
      }
    };
  }

  // ── 2. Modelos de IA ──
  let chain = [];
  let catalog = [];
  let catalogLoaded = false;

  function chips(item) {
    const out = [`<span class="st-chip">${escHtml(PROVIDER_LABEL[item.provider] || item.provider)}</span>`];
    if (item.provider === "openrouter" && item.free) out.push('<span class="st-chip free">grátis</span>');
    if (item.available === false) out.push('<span class="st-chip warn">sem chave</span>');
    return out.join("");
  }

  function renderChain() {
    $("st-models-list").innerHTML = chain
      .map(
        (m, i) => `<li class="st-model">
        <span class="st-model-n">${i + 1}</span>
        <span class="st-model-body">
          <span class="st-model-name">${escHtml(m.name)}${i === 0 ? ' <em>principal</em>' : ""}</span>
          <span class="st-model-meta">${chips({ ...m, free: m.entry.endsWith(":free") })}</span>
        </span>
        <span class="st-model-actions">
          <button type="button" class="st-icon" data-up="${i}" aria-label="Subir" ${i === 0 ? "disabled" : ""}>${ICON.up}</button>
          <button type="button" class="st-icon" data-down="${i}" aria-label="Descer" ${i === chain.length - 1 ? "disabled" : ""}>${ICON.down}</button>
          <button type="button" class="st-icon danger" data-del="${i}" aria-label="Remover" ${chain.length === 1 ? "disabled" : ""}>${ICON.close}</button>
        </span>
      </li>`
      )
      .join("");
    const move = async (from, to) => {
      [chain[from], chain[to]] = [chain[to], chain[from]];
      renderChain();
      await persistChain();
    };
    $("st-models-list").querySelectorAll("[data-up]").forEach((b) => (b.onclick = () => move(+b.dataset.up, +b.dataset.up - 1)));
    $("st-models-list").querySelectorAll("[data-down]").forEach((b) => (b.onclick = () => move(+b.dataset.down, +b.dataset.down + 1)));
    $("st-models-list").querySelectorAll("[data-del]").forEach(
      (b) =>
        (b.onclick = async () => {
          chain.splice(+b.dataset.del, 1);
          renderChain();
          await persistChain();
        })
    );
  }

  async function persistChain() {
    await saveSettings({ llm_models: chain.map((m) => m.entry) });
  }

  function renderLast(last) {
    if (!last) {
      $("st-model-last").textContent = "";
      return;
    }
    const skipped = (last.skipped || []).length
      ? ` Pulou: ${last.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}.`
      : "";
    $("st-model-last").textContent = `Último a responder: ${last.name} em ${last.seconds}s.${skipped}`;
  }

  async function loadChain() {
    const cfg = await getJSON("/api/llm/config", { models: [] });
    chain = cfg.models || [];
    renderChain();
    renderLast(cfg.last_used);
  }

  function renderComboResults() {
    const q = $("st-model-q").value.trim().toLowerCase();
    const freeOnly = $("st-free-only").checked;
    const taken = new Set(chain.map((m) => m.entry));
    const tokens = q.split(/\s+/).filter(Boolean);
    const rows = catalog
      .filter((m) => !taken.has(m.entry))
      .filter((m) => m.provider !== "openrouter" || m.free || !freeOnly)
      .filter((m) => tokens.every((t) => `${m.name} ${m.entry}`.toLowerCase().includes(t)))
      .slice(0, 30);
    const box = $("st-model-results");
    box.innerHTML = rows.length
      ? rows
          .map(
            (m) => `<button type="button" class="st-combo-item" role="option" data-entry="${escHtml(m.entry)}">
              <span class="st-model-name">${escHtml(m.name)}</span>
              <span class="st-model-meta">${chips(m)}</span>
            </button>`
          )
          .join("")
      : `<p class="st-empty">${catalogLoaded ? "Nenhum modelo encontrado." : "Carregando modelos…"}</p>`;
    box.classList.remove("hidden");
    box.querySelectorAll("[data-entry]").forEach((btn) => {
      btn.onclick = async () => {
        const item = catalog.find((m) => m.entry === btn.dataset.entry);
        chain.push({ entry: item.entry, name: item.name, provider: item.provider, available: true });
        $("st-model-q").value = "";
        box.classList.add("hidden");
        renderChain();
        await persistChain();
      };
    });
  }

  async function ensureCatalog() {
    if (catalogLoaded) return;
    const data = await getJSON("/api/llm/models", { items: [] });
    catalog = data.items || [];
    catalogLoaded = true;
    if (data._error) toast(data._error, true);
  }

  async function initModels() {
    $("st-llm-reasoning").checked = !!settings.llm_reasoning;
    $("st-llm-reasoning").onchange = () => saveSettings({ llm_reasoning: $("st-llm-reasoning").checked });
    await loadChain();
    const q = $("st-model-q");
    q.addEventListener("focus", async () => {
      renderComboResults();
      await ensureCatalog();
      renderComboResults();
    });
    q.addEventListener("input", async () => {
      renderComboResults();
      await ensureCatalog();
      renderComboResults();
    });
    $("st-free-only").onchange = renderComboResults;
    document.addEventListener("click", (e) => {
      if (!$("st-combo").contains(e.target)) $("st-model-results").classList.add("hidden");
    });
    q.addEventListener("keydown", (e) => {
      if (e.key === "Escape") $("st-model-results").classList.add("hidden");
    });
    $("st-model-test").onclick = async () => {
      const btn = $("st-model-test");
      btn.disabled = true;
      $("st-model-status").innerHTML = workingHTML("Testando a ordem");
      try {
        const res = await fetch("/api/llm/test", { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          $("st-model-status").textContent = "Funcionou.";
          renderLast(data.last_used);
        } else {
          $("st-model-status").textContent = "";
          toast(typeof data.detail === "string" ? data.detail : "Nenhum modelo respondeu.", true);
        }
      } finally {
        btn.disabled = false;
      }
    };
    $("st-model-reset").onclick = async () => {
      if (await saveSettings({ llm_models: [] })) {
        await loadChain();
        toast("Voltou ao padrão: Gemini primeiro, depois os gratuitos.");
      }
    };
  }

  // ── 3. Formato do resumo ──
  let templates = [];
  let selectedTemplate = "padrao";

  function renderTemplates() {
    $("st-templates").innerHTML = templates
      .map(
        (t) => `<button type="button" class="st-tpl ${t.key === selectedTemplate ? "on" : ""}" role="radio"
          aria-checked="${t.key === selectedTemplate}" data-key="${escHtml(t.key)}">
          <span class="st-tpl-head"><strong>${escHtml(t.name)}</strong>${t.key === selectedTemplate ? ICON.check : ""}</span>
          <span class="st-tpl-desc">${escHtml(t.description)}</span>
          <span class="st-tpl-sample">${formatSummary(t.sample)}</span>
        </button>`
      )
      .join("");
    $("st-templates").querySelectorAll("[data-key]").forEach((btn) => {
      btn.onclick = async () => {
        const previous = selectedTemplate;
        selectedTemplate = btn.dataset.key;
        renderTemplates();
        if (!(await saveSettings({ summary_template: selectedTemplate }))) {
          selectedTemplate = previous;
          renderTemplates();
        }
      };
    });
  }

  async function initSummary() {
    const data = await getJSON("/api/summary/templates", { items: [] });
    templates = data.items || [];
    selectedTemplate = data.selected || "padrao";
    if (Array.isArray(data.headers) && data.headers.length) {
      SUMMARY_HEADERS.splice(0, SUMMARY_HEADERS.length, ...data.headers);
    }
    renderTemplates();
    $("st-summary-custom").value = data.custom || "";
    $("st-summary-chips").innerHTML = SUMMARY_SUGGESTIONS.map(
      (s) => `<button type="button" class="st-chip-btn">${escHtml(s)}</button>`
    ).join("");
    $("st-summary-chips").querySelectorAll(".st-chip-btn").forEach((btn) => {
      btn.onclick = () => {
        const box = $("st-summary-custom");
        if (box.value.includes(btn.textContent)) return;
        box.value = box.value.trim() ? `${box.value.trim()}\n${btn.textContent}` : btn.textContent;
        box.focus();
      };
    });
    $("st-summary-save").onclick = async () => {
      if (await saveSettings({ summary_custom: $("st-summary-custom").value.trim() })) {
        $("st-summary-status").textContent = "Salvo. Vale para os próximos resumos.";
      }
    };
  }

  // ── 4. Conhecimento ──
  function ragInfo(st) {
    const c = st.chunks || {};
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    $("st-rag-info").textContent = total
      ? `${st.documents} documentos indexados: ${c.kb || 0} trechos do cérebro, ${c.mail || 0} de e-mails recebidos e ${c.mail_sent || 0} de respostas suas.`
      : "Nada indexado ainda.";
  }

  async function reindexRag(force) {
    $("st-rag-status").textContent = "Indexando…";
    try {
      const res = await fetch(`/api/rag/reindex${force ? "?force=true" : ""}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        $("st-rag-status").textContent = "";
        toast(typeof data.detail === "string" ? data.detail : "Falhou ao indexar.", true);
        return;
      }
      ragInfo(data);
      const st = data.stats || {};
      $("st-rag-status").textContent = `${st.added || 0} novos, ${st.updated || 0} atualizados, ${st.removed || 0} removidos.`;
    } catch {
      $("st-rag-status").textContent = "";
      toast("Sem conexão com o servidor.", true);
    }
  }

  async function runRagSearch() {
    const q = $("st-rag-q").value.trim();
    const el = $("st-rag-results");
    if (!q) {
      el.innerHTML = '<p class="st-empty">Digite algo para buscar.</p>';
      return;
    }
    const data = await getJSON(`/api/rag/search?q=${encodeURIComponent(q)}`, { items: [] });
    const label = { kb: "cérebro", mail: "e-mail", mail_sent: "resposta sua" };
    el.innerHTML = (data.items || []).length
      ? data.items
          .map(
            (it) => `<div class="st-result">
              <span class="st-result-title"><span class="st-chip">${escHtml(label[it.source] || it.source)}</span> ${escHtml(it.title)}</span>
              <span class="st-result-snippet">${escHtml(it.snippet)}</span>
            </div>`
          )
          .join("")
      : '<p class="st-empty">Nenhum trecho encontrado.</p>';
  }

  // Seletor de pastas e arquivos (no lugar da caixa de texto com caminhos).
  function createPicker(root, key, filesBase) {
    root.innerHTML = `
      <div class="pk-selected" data-r="selected"></div>
      <button type="button" class="st-btn" data-r="toggle" aria-expanded="false">Adicionar pasta ou arquivo</button>
      <div class="pk-panel hidden" data-r="panel">
        <input type="search" data-r="q" placeholder="Buscar pasta ou arquivo…" autocomplete="off" />
        <nav class="pk-crumbs" data-r="crumbs" aria-label="Caminho"></nav>
        <div class="pk-here" data-r="here"></div>
        <div class="pk-list" data-r="list"></div>
      </div>
      <details class="st-details"><summary>Ver arquivos incluídos</summary><div class="st-list" data-r="files"></div></details>`;
    const r = (name) => root.querySelector(`[data-r="${name}"]`);
    let cwd = null;

    const paths = () => (settings[key] || []).slice();
    const setPaths = async (next) => {
      if (await saveSettings({ [key]: next })) {
        renderSelected();
        renderBrowserState();
        if (key === "context_global_paths") reindexRag(false);
      }
    };

    async function renderSelected() {
      const list = paths();
      if (!list.length) {
        r("selected").innerHTML = '<p class="st-empty">Nada selecionado.</p>';
        return;
      }
      const res = await fetch("/api/fs/describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: list }),
      });
      const items = (await res.json().catch(() => ({ items: [] }))).items || [];
      r("selected").innerHTML = items
        .map((it, i) => {
          const title = it.type === "dir" && !it.rel ? "Learning Base (tudo)" : it.rel || it.name;
          const meta =
            it.type === "dir"
              ? `${it.files} arquivo${it.files === 1 ? "" : "s"} de texto`
              : it.type === "file"
                ? fmtBytes(it.size)
                : it.type === "missing"
                  ? "não existe mais"
                  : "fora da Learning Base";
          return `<div class="pk-item ${it.type === "missing" || it.type === "outside" ? "bad" : ""}">
            <span class="pk-icon">${it.type === "file" ? ICON.file : ICON.folder}</span>
            <span class="pk-text"><span class="pk-title">${escHtml(title)}</span><span class="pk-meta">${escHtml(meta)}</span></span>
            <button type="button" class="st-icon danger" data-rm="${i}" aria-label="Remover ${escHtml(title)}">${ICON.close}</button>
          </div>`;
        })
        .join("");
      r("selected").querySelectorAll("[data-rm]").forEach((b) => {
        b.onclick = () => {
          const next = paths();
          next.splice(+b.dataset.rm, 1);
          setPaths(next);
        };
      });
    }

    function entryRow(e, showRel) {
      const chosen = paths().includes(e.path);
      const isDir = e.type === "dir";
      const sub = isDir ? `${e.files == null ? "" : `${e.files} arquivo${e.files === 1 ? "" : "s"}`}` : fmtBytes(e.size);
      return `<div class="pk-row">
        <button type="button" class="pk-open" ${isDir ? `data-open="${escHtml(e.path)}"` : "disabled"}>
          <span class="pk-icon">${isDir ? ICON.folder : ICON.file}</span>
          <span class="pk-text"><span class="pk-title">${escHtml(showRel ? e.rel : e.name)}</span><span class="pk-meta">${escHtml(sub)}</span></span>
          ${isDir ? `<span class="pk-go">${ICON.chevron}</span>` : ""}
        </button>
        <button type="button" class="st-btn pk-pick ${chosen ? "on" : ""}" data-pick="${escHtml(e.path)}">${chosen ? "Selecionado" : "Selecionar"}</button>
      </div>`;
    }

    function wireList(container) {
      container.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => browse(b.dataset.open)));
      container.querySelectorAll("[data-pick]").forEach((b) => {
        b.onclick = () => {
          const next = paths();
          const at = next.indexOf(b.dataset.pick);
          if (at >= 0) next.splice(at, 1);
          else next.push(b.dataset.pick);
          setPaths(next);
        };
      });
    }

    let lastBrowse = null;
    function renderBrowserState() {
      if (!lastBrowse) return;
      const data = lastBrowse;
      r("crumbs").innerHTML = data.breadcrumb
        .map(
          (c, i) =>
            `${i ? ICON.chevron : ""}<button type="button" data-open="${escHtml(c.path)}" ${i === data.breadcrumb.length - 1 ? 'aria-current="page"' : ""}>${escHtml(c.name)}</button>`
        )
        .join("");
      const here = { path: data.path, type: "dir" };
      const chosen = paths().includes(here.path);
      r("here").innerHTML = `<button type="button" class="st-btn pk-pick ${chosen ? "on" : ""}" data-pick="${escHtml(here.path)}">${chosen ? "Esta pasta está selecionada" : "Selecionar esta pasta inteira"}</button>`;
      r("list").innerHTML = data.entries.length ? data.entries.map((e) => entryRow(e, false)).join("") : '<p class="st-empty">Pasta vazia.</p>';
      wireList(r("crumbs"));
      wireList(r("here"));
      wireList(r("list"));
    }

    async function browse(path) {
      r("q").value = "";
      const data = await getJSON(`/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`, null);
      if (!data || !data.entries) {
        toast((data && data._error) || "Não consegui abrir essa pasta.", true);
        return;
      }
      lastBrowse = data;
      cwd = data.path;
      renderBrowserState();
    }

    const runSearch = debounce(async () => {
      const q = r("q").value.trim();
      if (q.length < 2) {
        if (lastBrowse) renderBrowserState();
        return;
      }
      const data = await getJSON(`/api/fs/search?q=${encodeURIComponent(q)}`, { items: [] });
      r("crumbs").innerHTML = "";
      r("here").innerHTML = "";
      r("list").innerHTML = (data.items || []).length ? data.items.map((e) => entryRow(e, true)).join("") : '<p class="st-empty">Nada encontrado.</p>';
      wireList(r("list"));
    }, 250);
    r("q").addEventListener("input", runSearch);

    r("toggle").onclick = async () => {
      const panel = r("panel");
      const open = panel.classList.toggle("hidden") === false;
      r("toggle").setAttribute("aria-expanded", String(open));
      r("toggle").textContent = open ? "Fechar" : "Adicionar pasta ou arquivo";
      if (open && !lastBrowse) await browse(null);
    };

    root.querySelector("details").addEventListener("toggle", async (e) => {
      if (!e.target.open) return;
      r("files").innerHTML = '<p class="st-empty">Carregando…</p>';
      const data = await getJSON(`/api/settings/context-files?base=${filesBase}`, { files: [] });
      r("files").innerHTML = (data.files || []).length
        ? data.files
            .map(
              (f) => `<div class="st-list-row"><span class="st-list-main" data-tooltip="${escHtml(f.path)}">${fileLabel(f.path.replace(/^.*Learning Base\//, ""))}</span><span class="st-list-meta">${fmtBytes(f.size)}</span></div>`
            )
            .join("")
        : '<p class="st-empty">Nenhum arquivo incluído.</p>';
    });

    renderSelected();
    return { refresh: renderSelected };
  }

  async function initKnowledge() {
    $("st-rag-enabled").checked = settings.rag_enabled !== false;
    $("st-rag-personal").checked = !!settings.rag_include_personal;
    $("st-ctx-global-enabled").checked = !!settings.context_global_enabled;
    $("st-ctx-email-enabled").checked = !!settings.context_enabled;
    $("st-rag-enabled").onchange = () => saveSettings({ rag_enabled: $("st-rag-enabled").checked });
    $("st-rag-personal").onchange = async () => {
      if (await saveSettings({ rag_include_personal: $("st-rag-personal").checked })) reindexRag(false);
    };
    $("st-ctx-global-enabled").onchange = () => saveSettings({ context_global_enabled: $("st-ctx-global-enabled").checked });
    $("st-ctx-email-enabled").onchange = () => saveSettings({ context_enabled: $("st-ctx-email-enabled").checked });
    $("st-rag-reindex").onclick = () => reindexRag(true);
    $("st-rag-search").onclick = runRagSearch;
    $("st-rag-q").addEventListener("keydown", (e) => {
      if (e.key === "Enter") runRagSearch();
    });
    createPicker($("picker-global"), "context_global_paths", "global");
    createPicker($("picker-email"), "context_paths", "email");
    ragInfo(await getJSON("/api/rag/status", { chunks: {}, documents: 0 }));
  }

  // ── 5. Escrita e desempenho ──
  function initWriting() {
    $("st-style-preset").value = settings.style_preset || "neutro";
    $("st-style-custom").value = settings.style_custom || "";
    $("st-style-save").onclick = async () => {
      if (await saveSettings({ style_preset: $("st-style-preset").value, style_custom: $("st-style-custom").value.trim() })) {
        $("st-style-status").textContent = "Salvo.";
      }
    };
    $("st-preload-enabled").checked = settings.preload_enabled !== false;
    $("st-preload-count").value = settings.preload_count || 2;
    $("st-preload-enabled").onchange = () => saveSettings({ preload_enabled: $("st-preload-enabled").checked });
    $("st-preload-count").onchange = () => {
      const n = Math.min(20, Math.max(1, parseInt($("st-preload-count").value, 10) || 2));
      $("st-preload-count").value = n;
      saveSettings({ preload_count: n });
    };
  }

  // ── 5b. Copiloto: cards laterais do detalhe (preferência por usuário) ──
  async function initCopilotCards() {
    const prefs = await getJSON("/api/copilot/settings", null);
    const tasks = $("st-cp-tasks"), facts = $("st-cp-facts"), status = $("st-cp-status");
    if (!prefs) { status.textContent = "Não consegui ler as preferências do copiloto."; return; }
    tasks.checked = prefs.show_tasks_card !== false;
    facts.checked = prefs.show_facts_card !== false;
    const save = async (field, value) => {
      status.textContent = "Salvando…";
      try {
        const res = await fetch("/api/copilot/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [field]: value }) });
        status.textContent = res.ok ? "Salvo." : "Não salvou.";
      } catch { status.textContent = "Sem conexão: não salvou."; }
    };
    tasks.onchange = () => save("show_tasks_card", tasks.checked);
    facts.onchange = () => save("show_facts_card", facts.checked);
  }

  // ── 6. Piloto ──
  function initAutopilot() {
    const levels = { conservador: "Conservador", moderado: "Moderado", autonomo: "Autônomo" };
    $("st-autopilot-info").textContent = settings.autopilot_enabled
      ? `Ligado no nível ${levels[settings.autopilot_level] || settings.autopilot_level}.`
      : "Desligado. A IA não responde nada sozinha.";
  }

  // ── 7. Apelidos (agrupados por pessoa: vários apelidos para o mesmo e-mail) ──
  let aliasData = [];

  function groupAliases(list) {
    const groups = new Map();
    for (const a of list) {
      const key = (a.email || "").toLowerCase() || `alias:${a.alias}`;
      if (!groups.has(key)) groups.set(key, { name: a.name || a.alias, email: a.email || "", aliases: [] });
      const g = groups.get(key);
      if (a.name && g.name !== a.name && g.name === g.aliases[0]) g.name = a.name;
      g.aliases.push(a.alias);
    }
    return [...groups.values()].sort((x, y) => x.name.localeCompare(y.name, "pt-BR"));
  }

  const splitAliases = (text) =>
    [...new Set(text.split(/[,;\n]/).map((t) => t.trim().toLowerCase()).filter(Boolean))];

  // Salva vários apelidos para a mesma pessoa. Se um apelido já aponta para OUTRA
  // pessoa, pergunta antes de trocar (senão "rodrigo" mudaria de dono em silêncio).
  async function saveAliases(aliases, name, email) {
    const existing = new Map(aliasData.map((a) => [a.alias.toLowerCase(), a]));
    let saved = 0;
    for (const alias of aliases) {
      const prev = existing.get(alias);
      if (prev && (prev.email || "").toLowerCase() !== (email || "").toLowerCase()) {
        const who = prev.name || prev.email || "outra pessoa";
        if (!window.confirm(`O apelido "${alias}" já aponta para ${who}. Trocar para ${name || email || "esta pessoa"}?`)) continue;
      }
      const res = await fetch("/api/settings/aliases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias, name, email }),
      });
      if (res.ok) saved += 1;
    }
    return saved;
  }

  async function loadAliases() {
    const data = await getJSON("/api/settings/aliases", { aliases: [] });
    aliasData = data.aliases || [];
    const el = $("st-aliases");
    const groups = groupAliases(aliasData);
    el.innerHTML = groups.length
      ? groups
          .map(
            (g, gi) => `<div class="st-person">
              <div class="st-person-head">
                <strong>${escHtml(g.name)}</strong>
                ${g.email ? `<span class="st-person-email">${escHtml(g.email)}</span>` : ""}
              </div>
              <div class="st-person-aliases">
                ${g.aliases
                  .map(
                    (al) => `<span class="st-alias-chip">${escHtml(al)}<button type="button" data-rm="${escHtml(al)}" aria-label="Remover o apelido ${escHtml(al)}">${ICON.close}</button></span>`
                  )
                  .join("")}
                <input type="text" class="st-alias-inline" data-g="${gi}" placeholder="+ apelido" autocomplete="off"
                  enterkeyhint="done" aria-label="Adicionar outro apelido para ${escHtml(g.name)}" />
              </div>
            </div>`
          )
          .join("")
      : '<p class="st-empty">Nenhum apelido cadastrado ainda.</p>';
    el.querySelectorAll("[data-rm]").forEach((b) => {
      b.onclick = async () => {
        await fetch(`/api/settings/aliases/${encodeURIComponent(b.dataset.rm)}`, { method: "DELETE" });
        loadAliases();
      };
    });
    el.querySelectorAll(".st-alias-inline").forEach((input) => {
      const g = groups[+input.dataset.g];
      const commit = async () => {
        const list = splitAliases(input.value);
        if (!list.length) return;
        input.value = "";
        if (await saveAliases(list, g.name, g.email)) toast(list.length > 1 ? "Apelidos salvos" : "Apelido salvo");
        loadAliases();
      };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === ",") {
          e.preventDefault();
          commit();
        }
      });
      input.addEventListener("blur", commit);
    });
  }

  function initAliases() {
    loadAliases();
    const box = $("st-alias-suggestions");
    const field = $("st-alias-alias");
    const lastSegment = () => field.value.split(/[,;]/).pop().trim();
    const suggest = debounce(async () => {
      const q = lastSegment();
      if (q.length < 2) {
        box.classList.add("hidden");
        return;
      }
      const data = await getJSON(`/api/settings/alias-suggest?q=${encodeURIComponent(q)}`, { suggestions: [] });
      const items = data.suggestions || [];
      if (!items.length) {
        box.classList.add("hidden");
        return;
      }
      box.innerHTML = items
        .map((s, i) => `<button type="button" data-i="${i}"><span class="sugg-name">${escHtml(s.name || s.email)}</span><span class="sugg-email">${escHtml(s.email)}</span></button>`)
        .join("");
      box.querySelectorAll("[data-i]").forEach((b) => {
        b.onclick = () => {
          const s = items[+b.dataset.i];
          $("st-alias-name").value = s.name || "";
          $("st-alias-email").value = s.email || "";
          box.classList.add("hidden");
        };
      });
      box.classList.remove("hidden");
    }, 250);
    field.addEventListener("input", suggest);
    document.addEventListener("mousedown", (e) => {
      if (!box.contains(e.target) && e.target.id !== "st-alias-alias") box.classList.add("hidden");
    });
    $("st-alias-add").onclick = async () => {
      const aliases = splitAliases(field.value);
      if (!aliases.length) {
        toast("Escreva pelo menos um apelido.", true);
        return;
      }
      const name = $("st-alias-name").value.trim();
      const email = $("st-alias-email").value.trim();
      const saved = await saveAliases(aliases, name, email);
      ["st-alias-alias", "st-alias-name", "st-alias-email"].forEach((id) => ($(id).value = ""));
      if (saved) toast(saved > 1 ? `${saved} apelidos salvos` : "Apelido salvo");
      loadAliases();
    };
  }

  // ── 8. Aprendizados (botão Aprender do copiloto) ──
  const LEARNED_SCOPE = { general: "Geral", person: "Pessoa", thread: "Assunto" };

  async function loadLearned() {
    const data = await getJSON("/api/learned", { notes: [] });
    const el = $("st-learned");
    const notes = data.notes || [];
    el.innerHTML = notes.length
      ? notes
          .map((n) => {
            const where = n.scope === "person" ? n.person_email : n.scope === "thread" ? n.subject || "(sem assunto)" : "vale sempre";
            return `<div class="st-list-row">
              <span class="st-list-main">${escHtml(n.text)}</span>
              <span class="st-list-meta">${LEARNED_SCOPE[n.scope] || n.scope} · ${escHtml(where || "")} · ${fmtWhen(Date.parse(n.created_at) / 1000)}</span>
              <button type="button" class="st-icon danger" data-learned="${n.id}" aria-label="Remover este aprendizado">${ICON.trash}</button>
            </div>`;
          })
          .join("")
      : '<p class="st-empty">Nada aprendido ainda. Use o botão Aprender no detalhe do copiloto.</p>';
    el.querySelectorAll("[data-learned]").forEach((b) => {
      b.onclick = async () => {
        if (!window.confirm("Remover este aprendizado? A IA deixa de usá-lo nos próximos e-mails.")) return;
        const res = await fetch(`/api/learned/${b.dataset.learned}`, { method: "DELETE" }).catch(() => null);
        toast(res && res.ok ? "Aprendizado removido" : "Não consegui remover.", !(res && res.ok));
        loadLearned();
      };
    });
  }

  // ── 9. Arquivos gerados ──
  async function loadGenerated() {
    const data = await getJSON("/api/settings/generated-files", { exports: [], context_md: null });
    $("st-context-md").textContent = data.context_md
      ? `Conhecimento acumulado (não apagável por aqui): ${data.context_md.path} — ${fmtBytes(data.context_md.size)}`
      : "";
    const el = $("st-files");
    const items = data.exports || [];
    el.innerHTML = items.length
      ? items
          .map(
            (f) => `<div class="st-list-row">
              <span class="st-list-main" data-tooltip="${escHtml(f.path)}">${fileLabel(f.path)}</span>
              <span class="st-list-meta">${fmtBytes(f.size)} · ${fmtWhen(f.modified_at)}</span>
              <button type="button" class="st-icon danger" data-del="${escHtml(f.path)}" aria-label="Apagar ${escHtml(f.name)}">${ICON.trash}</button>
            </div>`
          )
          .join("")
      : '<p class="st-empty">Nenhum arquivo exportado.</p>';
    el.querySelectorAll("[data-del]").forEach((b) => {
      b.onclick = async () => {
        const rel = b.dataset.del.split("/").map(encodeURIComponent).join("/");
        await fetch(`/api/settings/generated-files/${rel}`, { method: "DELETE" });
        loadGenerated();
      };
    });
  }

  function initGenerated() {
    loadGenerated();
    $("st-files-delete-all").onclick = async () => {
      if (!window.confirm("Apagar todos os arquivos exportados?")) return;
      await fetch("/api/settings/generated-files", { method: "DELETE" });
      toast("Arquivos apagados");
      loadGenerated();
    };
  }

  // ── navegação entre seções ──
  function initNav() {
    const links = [...document.querySelectorAll(".st-nav a")];
    links.forEach((a) =>
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const target = document.querySelector(a.getAttribute("href"));
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      })
    );
    const cards = [...document.querySelectorAll(".st-card")];
    let active = null;
    const update = () => {
      if (!cards[0] || cards[0].offsetHeight === 0) return;
      let current = cards[0];
      for (const c of cards) if (c.getBoundingClientRect().top <= 120) current = c;
      const section = current && (current.dataset.nav || current.id);
      if (!section || section === active) return;
      active = section;
      links.forEach((a) => {
        const on = a.getAttribute("href") === `#${active}`;
        a.classList.toggle("on", on);
        if (on) a.scrollIntoView({ inline: "center", block: "nearest" });
      });
    };
    // Sem requestAnimationFrame (não roda em aba em segundo plano) e com
    // re-checagem depois: o init() roda antes de a página aparecer, quando
    // todas as seções ainda têm altura 0.
    let timer = null;
    const onScroll = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        update();
      }, 80);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", update);
    [200, 800, 2000].forEach((ms) => setTimeout(update, ms));
    update();
  }

  async function init() {
    document.title = "Configurações · IA.Email";
    const data = await getJSON("/api/settings", { settings: {} });
    settings = data.settings || {};
    initNav();
    initWriting();
    initAutopilot();
    initCopilotCards();
    initAliases();
    loadLearned();
    initGenerated();
    await Promise.allSettled([initMetrics(), initModels(), initSummary(), initKnowledge()]);
  }

  init();
})();
