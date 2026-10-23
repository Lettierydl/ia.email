// Histórico de ações + Desfazer/Refazer, compartilhado por /copilot e /mail.
// Servidor: /api/historico (app/history.py). Expõe window.UndoHistory:
//   init({ onChange, onToast })  atalhos Cmd/Ctrl+Z (desfazer a última ação) e
//                                Cmd+Shift+Z / Ctrl+Y (refazer). Com foco em
//                                campo de texto o atalho é do campo (undo do texto).
//   offer(entry, text)           toast "<text>  [Desfazer]" por ~6 s depois de uma ação
//   undo(id) / redo(id) / undoLast() / redoLast()
//   mountPage(box, { openThread }) página "Histórico" (por dia, busca, filtro, carregar mais)
//   hideToast()
// Nada de alert/confirm nativos: tudo por toast próprio (.uh-toast).
(function () {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const OFFER_MS = 6000;
  const DONE_MS = 6000;
  const ICON = {
    marcar_lido: "check-circle-double", resolvido: "check", resolver_coluna: "check-circle-double", reabrir: "reopen",
    acompanhar: "user", mover: "chevron-right", delegar: "handoff", cobrar: "bell", aplicar: "sparkles", tarefa: "check",
    enviar: "send", salvar_rascunho: "pencil", ocultar: "eye-off", mostrar: "eye", nao_interessado: "bell-off",
  };
  const ORIGEM = { copilot: "Copiloto", mail: "Caixa" };
  let opts = { onChange: null, onToast: null };
  let busy = false;
  const pages = new Set();

  async function api(url, method) {
    try {
      const res = await fetch(url, { method: method || "GET" });
      return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
    } catch (_) {
      return { ok: false, status: 0, data: { detail: "Sem conexão com o servidor." } };
    }
  }

  // ── toast com ação (Desfazer / Refazer) ──
  let toastEl = null;
  let toastTimer = null;
  function toastBox() {
    if (toastEl && document.body.contains(toastEl)) return toastEl;
    toastEl = document.createElement("div");
    toastEl.className = "uh-toast hidden";
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
    document.body.appendChild(toastEl);
    return toastEl;
  }
  function hideToast() {
    clearTimeout(toastTimer);
    if (toastEl) toastEl.classList.add("hidden");
  }
  function toast(text, action, ms) {
    const el = toastBox();
    el.innerHTML = `<span class="uh-toast-t">${esc(text)}</span>${action ? `<button type="button" class="uh-toast-b">${esc(action.label)}</button>` : ""}`;
    if (action) el.querySelector(".uh-toast-b").onclick = () => { hideToast(); action.run(); };
    el.classList.remove("hidden");
    if (opts.onToast) opts.onToast();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, ms || 4200);
  }
  const lowerFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : "");
  const what = (e) => `${lowerFirst(e.rotulo)} — ${e.assunto || "(sem assunto)"}`;

  function offer(entry, text) {
    if (!entry || !entry.desfazivel || entry.desfeito) { if (text) toast(text); return; }
    toast(text || `${entry.rotulo} — ${entry.assunto}`, { label: "Desfazer", run: () => undo(entry.id) }, OFFER_MS);
  }

  function changed(entry) {
    pages.forEach((p) => p.refresh());
    if (opts.onChange) opts.onChange(entry);
  }

  async function run(url, verb, next) {
    if (busy) return null;
    busy = true;
    try {
      const r = await api(url, "POST");
      if (!r.ok) {
        toast(r.data.detail || `Não deu para ${verb}.`);
        return null;
      }
      const e = r.data.entry;
      const parcial = r.data.conflitos ? " (o que mudou depois ficou como está)" : "";
      toast(`${verb === "desfazer" ? "Desfeito" : "Refeito"}: ${what(e)}${parcial}`, next(e), DONE_MS);
      changed(e);
      return r.data;
    } finally {
      busy = false;
    }
  }
  const redoAction = (e) => ({ label: "Refazer", run: () => redo(e.id) });
  const undoAction = (e) => (e.desfazivel ? { label: "Desfazer", run: () => undo(e.id) } : null);
  const undo = (id) => run(`/api/historico/${encodeURIComponent(id)}/desfazer`, "desfazer", redoAction);
  const redo = (id) => run(`/api/historico/${encodeURIComponent(id)}/refazer`, "refazer", undoAction);
  const undoLast = () => run("/api/historico/desfazer-ultimo", "desfazer", redoAction);
  const redoLast = () => run("/api/historico/refazer-ultimo", "refazer", undoAction);

  // ── atalho de teclado ──
  const NOT_TEXT = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);
  function isTextTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('[contenteditable]:not([contenteditable="false"])')) return true;
    const tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    return tag === "INPUT" && !NOT_TEXT.has((el.type || "text").toLowerCase());
  }
  function onKey(e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.defaultPrevented || e.isComposing) return;
    const k = (e.key || "").toLowerCase();
    const isUndo = k === "z" && !e.shiftKey;
    const isRedo = (k === "z" && e.shiftKey) || (k === "y" && e.ctrlKey && !e.metaKey && !e.shiftKey);
    if (!isUndo && !isRedo) return;
    if (isTextTarget(e.target) || isTextTarget(document.activeElement)) return; // undo do próprio texto
    if (document.querySelector(".dlg-overlay")) return; // diálogo aberto: não mexe por trás
    e.preventDefault();
    if (isUndo) undoLast();
    else redoLast();
  }
  let bound = false;
  function init(o) {
    opts = Object.assign({}, opts, o || {});
    if (!bound) { document.addEventListener("keydown", onKey); bound = true; }
  }

  // ── página "Histórico" ──
  function dayKey(d) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
  function dayLabel(d, now) {
    now = now || new Date();
    if (dayKey(d) === dayKey(now)) return "Hoje";
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (dayKey(d) === dayKey(y)) return "Ontem";
    const o = { weekday: "long", day: "2-digit", month: "long" };
    if (d.getFullYear() !== now.getFullYear()) o.year = "numeric";
    const s = d.toLocaleDateString("pt-BR", o);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function groupByDay(items, now) {
    const out = [];
    let last = null;
    items.forEach((it) => {
      const d = new Date(it.at);
      const key = dayKey(d);
      if (!last || last.key !== key) { last = { key, label: dayLabel(d, now), items: [] }; out.push(last); }
      last.items.push(it);
    });
    return out;
  }
  const hhmm = (iso) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const icon = (acao) => (window.Icons && window.Icons.svg ? window.Icons.svg(ICON[acao] || "clock", { size: 16 }) : "");

  function rowHTML(e) {
    const subj = e.n > 1 || !e.thread_id
      ? `<span class="uh-subj">${esc(e.assunto)}</span>`
      : `<button type="button" class="uh-subj uh-link" data-thread="${esc(e.thread_id)}" title="Abrir o e-mail">${esc(e.assunto)}</button>`;
    let state;
    if (e.estado === "nao_reversivel") state = `<span class="uh-state" title="${esc(e.motivo)}">Não reversível</span>`;
    else if (e.desfeito) state = `<span class="uh-state">Desfeito</span><button type="button" class="uh-btn" data-redo="${e.id}">Refazer</button>`;
    else state = `<button type="button" class="uh-btn primary" data-undo="${e.id}">Desfazer</button>`;
    return `<li class="uh-row${e.desfeito ? " is-undone" : ""}" data-hid="${e.id}">
      <time datetime="${esc(e.at)}">${hhmm(e.at)}</time>
      <span class="uh-ic a-${esc(e.acao)}" aria-hidden="true">${icon(e.acao)}</span>
      <span class="uh-main"><span class="uh-act">${esc(e.rotulo)}</span>${subj}${e.origem ? `<small class="uh-org">${esc(ORIGEM[e.origem] || e.origem)}</small>` : ""}</span>
      <span class="uh-side">${state}</span></li>`;
  }

  function mountPage(box, o) {
    o = o || {};
    box.innerHTML = `<div class="uh-page">
      <header class="uh-head"><h2>Histórico</h2><p>Suas últimas ações. Desfaça aqui ou com ${/Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘Z" : "Ctrl+Z"}.</p></header>
      <div class="uh-bar">
        <input type="search" class="uh-q" placeholder="Buscar pelo assunto…" aria-label="Buscar no histórico" autocomplete="off">
        <select class="uh-tipo" aria-label="Filtrar por tipo de ação"><option value="">Todas as ações</option></select>
      </div>
      <div class="uh-list" aria-live="polite"><p class="uh-empty">Carregando…</p></div>
      <button type="button" class="uh-more hidden">Carregar mais</button>
    </div>`;
    const root = box.querySelector(".uh-page");
    const q = root.querySelector(".uh-q");
    const tipo = root.querySelector(".uh-tipo");
    const list = root.querySelector(".uh-list");
    const more = root.querySelector(".uh-more");
    let items = [];
    let next = null;
    let seq = 0;
    let tiposOk = false;
    let timer = null;

    function render() {
      if (!items.length) {
        list.innerHTML = `<p class="uh-empty">${q.value.trim() || tipo.value ? "Nada encontrado com esse filtro." : "Nenhuma ação ainda. Quando você marcar como lido, resolver ou mover um e-mail, aparece aqui."}</p>`;
      } else {
        list.innerHTML = groupByDay(items).map((g) => `<section class="uh-day"><h3>${esc(g.label)}</h3><ul>${g.items.map(rowHTML).join("")}</ul></section>`).join("");
      }
      more.classList.toggle("hidden", !next);
    }
    async function fetchPage(append) {
      const my = ++seq;
      const p = new URLSearchParams({ limit: "50" });
      if (q.value.trim()) p.set("q", q.value.trim());
      if (tipo.value) p.set("tipo", tipo.value);
      if (append && next) p.set("before", String(next));
      more.disabled = true;
      const r = await api(`/api/historico?${p}`);
      more.disabled = false;
      if (my !== seq) return;
      if (!r.ok) { list.innerHTML = `<p class="uh-empty">${esc(r.data.detail || "Não consegui carregar o histórico.")}</p>`; return; }
      if (!tiposOk && Array.isArray(r.data.tipos)) {
        tipo.insertAdjacentHTML("beforeend", r.data.tipos.map((t) => `<option value="${esc(t.key)}">${esc(t.label)}</option>`).join(""));
        tiposOk = true;
      }
      items = append ? items.concat(r.data.items || []) : r.data.items || [];
      next = r.data.proximo || null;
      render();
    }
    q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => fetchPage(false), 250); });
    q.addEventListener("keydown", (e) => { if (e.key === "Escape" && q.value) { q.value = ""; fetchPage(false); } });
    tipo.addEventListener("change", () => fetchPage(false));
    more.addEventListener("click", () => fetchPage(true));
    root.addEventListener("click", (e) => {
      const u = e.target.closest("[data-undo]");
      if (u) { e.stopPropagation(); u.disabled = true; undo(u.dataset.undo).then(() => (u.disabled = false)); return; }
      const r = e.target.closest("[data-redo]");
      if (r) { e.stopPropagation(); r.disabled = true; redo(r.dataset.redo).then(() => (r.disabled = false)); return; }
      const t = e.target.closest("[data-thread]");
      if (t && o.openThread) { e.stopPropagation(); o.openThread(t.dataset.thread); }
    });
    const page = { root, refresh: () => (document.body.contains(root) ? fetchPage(false) : pages.delete(page)) };
    pages.add(page);
    fetchPage(false);
    return page;
  }

  window.UndoHistory = { init, offer, undo, redo, undoLast, redoLast, mountPage, hideToast, toast, groupByDay, dayLabel, isTextTarget };
})();
