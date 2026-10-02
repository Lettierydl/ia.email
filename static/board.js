// Painel visual (/board): os e-mails analisados como cartões em zonas, tipo um
// quadro. Arraste cartões, navegue com o mouse/dedo, clique pra ver o detalhe.
// Nada aqui envia e-mail: "Usar como rascunho" só leva pro e-mail com o texto.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const SOURCE = { kb: "cérebro", mail: "e-mail recebido", mail_sent: "resposta sua" };
  const CARD_W = 300, CARD_H = 172, SLOT = 188, HEAD = 78, ZONE_W = 340, GAP = 28, PER_ROW = 3;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } },
  };

  let data = { zones: [] };
  let items = {};
  let view = store.get("ia_board_view") || (window.innerWidth < 760 ? "list" : "board");
  let pos = {};
  try { pos = JSON.parse(store.get("ia_board_pos") || "{}") || {}; } catch { pos = {}; }
  const cam = { x: 20, y: 20, k: 1 };
  let selected = null, running = false, pollTimer = null, fitted = false, layout = { w: 0, h: 0 };

  const api = async (url, method, body) => {
    try {
      const res = await fetch(url, { method: method || "GET", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      const json = await res.json().catch(() => ({}));
      return { ok: res.ok, data: json };
    } catch { return { ok: false, data: { detail: "Sem conexão com o servidor." } }; }
  };
  let toastTimer;
  function toast(text) {
    const el = $("bd-toast");
    el.textContent = text; el.classList.remove("hidden");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add("hidden"), 4500);
  }
  function whenText(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  // ── cartão ──
  function chips(it) {
    const out = [];
    if (it.confidence != null) out.push(`<span class="bd-chip good">confiança ${Math.round(it.confidence * 100)}%</span>`);
    if (it.sensitive) out.push('<span class="bd-chip warn">tema sensível</span>');
    if (it.chip) out.push(`<span class="bd-chip">${esc(it.chip)}</span>`);
    if (it.zone === "queue" && it.scheduled_send_at) out.push(`<span class="bd-chip warn">sai ${esc(whenText(it.scheduled_send_at))}</span>`);
    if (it.zone === "sent") out.push(`<span class="bd-chip ${it.state === "sent" ? "good" : it.state === "failed" ? "bad" : ""}">${{ sent: "enviado", cancelled: "cancelado", failed: "falhou" }[it.state] || esc(it.state)}</span>`);
    if (it.evidence && it.evidence.length) out.push(`<span class="bd-chip">${it.evidence.length} fonte${it.evidence.length > 1 ? "s" : ""}</span>`);
    return out.length ? `<div class="bd-chips">${out.join("")}</div>` : "";
  }
  function cardHTML(it) {
    return `<h3>${esc(it.subject)}</h3><div class="bd-from">${esc(it.from)}</div>
      <div class="bd-prev">${esc(it.preview)}</div>${chips(it)}`;
  }

  // ── painel ──
  function computeLayout() {
    const base = {}; // id -> posição padrão
    const frames = [];
    let y = 0, rowH = 0, col = 0, maxW = 0;
    data.zones.forEach((z, i) => {
      if (col === PER_ROW) { col = 0; y += rowH + GAP; rowH = 0; }
      const h = HEAD + Math.max(1, z.items.length) * SLOT + 8;
      const x = col * (ZONE_W + GAP);
      frames.push({ z, x, y, h });
      z.items.forEach((it, n) => { base[it.id] = { x: x + (ZONE_W - CARD_W) / 2, y: y + HEAD + n * SLOT }; });
      rowH = Math.max(rowH, h);
      col += 1;
      maxW = Math.max(maxW, x + ZONE_W);
    });
    layout = { w: maxW, h: y + rowH };
    return { base, frames };
  }
  function applyCam() {
    $("bd-world").style.transform = `translate(${cam.x}px,${cam.y}px) scale(${cam.k})`;
    $("bd-zval").textContent = `${Math.round(cam.k * 100)}%`;
  }
  function fit() {
    const c = $("bd-canvas");
    if (!layout.w) return;
    // Ajusta pela largura (a altura rola); nunca fica pequeno demais pra ler.
    const k = Math.min(1, (c.clientWidth - 40) / layout.w);
    cam.k = Math.max(0.55, k);
    cam.x = Math.max(20, (c.clientWidth - layout.w * cam.k) / 2);
    cam.y = 20;
    applyCam();
  }
  function zoomAt(factor, cx, cy) {
    const k = Math.min(1.6, Math.max(0.3, cam.k * factor));
    cam.x = cx - ((cx - cam.x) * k) / cam.k;
    cam.y = cy - ((cy - cam.y) * k) / cam.k;
    cam.k = k;
    applyCam();
  }

  function renderBoard() {
    const { base, frames } = computeLayout();
    const world = $("bd-world");
    world.innerHTML = frames
      .map(({ z, x, y, h }) => `<section class="bd-zone tone-${z.tone}" style="left:${x}px;top:${y}px;width:${ZONE_W}px;height:${h}px">
        <h2>${esc(z.title)} <b>${z.items.length}</b></h2><p>${esc(z.hint)}</p>
        ${z.items.length ? "" : '<div class="bd-empty">Nada aqui por enquanto.</div>'}</section>`)
      .join("");
    Object.values(items).forEach((it) => {
      const p = pos[it.id] || base[it.id];
      const el = document.createElement("article");
      el.className = `bd-card card-${it.zone}${selected === it.id ? " sel" : ""}`;
      el.dataset.id = it.id;
      el.style.cssText = `left:${p.x}px;top:${p.y}px;height:${CARD_H}px;overflow:hidden`;
      el.innerHTML = cardHTML(it);
      world.appendChild(el);
    });
    applyCam();
  }

  function renderList() {
    $("bd-listview").innerHTML = data.zones
      .map((z) => `<section class="bd-lz"><h2 style="color:inherit">${esc(z.title)} <span class="bd-chip">${z.items.length}</span></h2><p>${esc(z.hint)}</p>
        ${z.items.length ? z.items.map((it) => `<article class="bd-card card-${it.zone}${selected === it.id ? " sel" : ""}" data-id="${esc(it.id)}">${cardHTML(it)}</article>`).join("") : '<p class="bd-empty" style="position:static">Nada aqui por enquanto.</p>'}</section>`)
      .join("");
  }

  function render() {
    items = {};
    data.zones.forEach((z) => z.items.forEach((it) => { items[it.id] = it; }));
    const n = data.total || 0;
    $("bd-sub").textContent = n ? `${n} e-mail${n > 1 ? "s" : ""} no painel` : running ? "Analisando…" : "Nenhum e-mail analisado ainda. Clique em “Analisar minha caixa”.";
    const board = view === "board";
    $("bd-canvas").classList.toggle("hidden", !board);
    $("bd-listview").classList.toggle("hidden", board);
    $("bd-zoom").style.visibility = board ? "visible" : "hidden";
    $("bd-v-board").classList.toggle("on", board);
    $("bd-v-list").classList.toggle("on", !board);
    if (board) { renderBoard(); if (!fitted) { fit(); fitted = true; } } else renderList();
    if (selected && !items[selected]) closeDrawer();
  }

  async function load() {
    const res = await api("/api/board");
    if (res.ok) { data = res.data; render(); }
    else $("bd-sub").textContent = "Não consegui carregar o painel.";
  }

  // ── detalhe ──
  function closeDrawer() {
    selected = null;
    $("bd-drawer").classList.add("hidden");
    document.querySelectorAll(".bd-card.sel").forEach((e) => e.classList.remove("sel"));
  }
  function evidenceHTML(list) {
    return list.map((e) => `<div class="bd-ev"><b>${esc(e.title)}</b><small>${esc(SOURCE[e.source] || e.source)}${e.why ? " · " + esc(e.why) : ""}</small>${e.snippet ? `<q>${esc(e.snippet)}</q>` : ""}</div>`).join("");
  }
  function actionButtons(it) {
    const a = it.actions || [];
    const out = [];
    if (a.includes("use")) out.push(`<button class="bd-btn primary" data-act="use">Usar como rascunho</button>`);
    if (a.includes("cancel")) out.push(`<button class="bd-btn primary" data-act="cancel">Cancelar envio</button>`);
    if (a.includes("open")) out.push(`<a class="bd-btn${out.length ? "" : " primary"}" style="text-decoration:none" href="/mail/${encodeURIComponent(it.thread_id)}">Abrir e-mail</a>`);
    if (a.includes("dismiss")) out.push(`<button class="bd-btn" data-act="dismiss">${it.zone === "none" ? "Ok, ignorar" : "Descartar"}</button>`);
    if (a.includes("dismiss_pilot")) out.push(`<button class="bd-btn" data-act="dismiss_pilot">Já vi, tirar do painel</button>`);
    return out.join("");
  }
  function openDrawer(id, tab) {
    const it = items[id];
    if (!it) return;
    selected = id;
    document.querySelectorAll(".bd-card").forEach((e) => e.classList.toggle("sel", e.dataset.id === id));
    const tabs = [["main", it.body_label || "Detalhe"]];
    if (it.evidence && it.evidence.length) tabs.push(["basis", `Em que me baseei (${it.evidence.length})`]);
    tabs.push(["orig", "E-mail original"]);
    tab = tab || "main";
    const dr = $("bd-drawer");
    let body = "";
    if (tab === "main") {
      body = `<div class="bd-lbl">${esc(it.body_label)}</div><div class="bd-text">${esc(it.body || "(sem texto)")}</div>
        ${it.question ? `<p class="bd-note"><strong>Pergunta pra você:</strong> ${esc(it.question)}</p>` : ""}
        ${it.reason && it.reason !== it.body ? `<p class="bd-note"><strong>Por quê:</strong> ${esc(it.reason)}</p>` : ""}
        ${it.error ? `<p class="bd-note"><strong>Erro:</strong> ${esc(it.error)}</p>` : ""}`;
    } else if (tab === "basis") body = evidenceHTML(it.evidence);
    else body = '<div class="bd-text" id="bd-orig">Carregando e-mail…</div>';
    dr.innerHTML = `<div class="bd-dh"><h2>${esc(it.subject)}</h2><div class="bd-from">${esc(it.from)}${it.when ? " · " + esc(whenText(it.when)) : ""}</div>
      <button class="bd-x" data-act="close" aria-label="Fechar">×</button></div>
      <div class="bd-tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? "on" : ""}">${esc(l)}</button>`).join("")}</div>
      <div class="bd-db">${body}</div><div class="bd-df">${actionButtons(it)}</div>`;
    dr.classList.remove("hidden");
    if (tab === "orig") {
      api(`/api/threads/${encodeURIComponent(it.thread_id)}/original-preview`).then((r) => {
        const el = $("bd-orig");
        if (el && selected === id) el.textContent = r.ok ? r.data.body || "(vazio)" : "Não consegui carregar o e-mail.";
      });
    }
  }

  async function act(kind, it, btn) {
    if (btn) btn.disabled = true;
    const enc = encodeURIComponent(it.id);
    const url = { use: `/api/assistant/${enc}/use`, dismiss: `/api/assistant/${enc}/dismiss`, cancel: `/api/autopilot/queue/${enc}/cancel`, dismiss_pilot: `/api/autopilot/decisions/${enc}/dismiss` }[kind];
    const r = await api(url, "POST");
    if (!r.ok) {
      if (btn) btn.disabled = false;
      toast(typeof r.data.detail === "string" ? r.data.detail : "Não consegui fazer isso.");
      load();
      return;
    }
    if (kind === "use") { location.href = `/mail/${encodeURIComponent(r.data.thread_id || it.thread_id)}`; return; }
    closeDrawer();
    toast(kind === "cancel" ? "Envio cancelado." : "Pronto.");
    load();
  }

  // ── interação: cartões (arrastar/clicar) e fundo (mover) ──
  function bindCanvas() {
    const canvas = $("bd-canvas");
    let drag = null;
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      const card = e.target.closest(".bd-card");
      drag = { card, sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y, moved: false, el: card, p: card ? { x: parseFloat(card.style.left), y: parseFloat(card.style.top) } : null };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      if (drag.card) {
        drag.card.classList.add("dragging");
        drag.card.style.left = `${drag.p.x + dx / cam.k}px`;
        drag.card.style.top = `${drag.p.y + dy / cam.k}px`;
      } else {
        canvas.classList.add("panning");
        cam.x = drag.cx + dx; cam.y = drag.cy + dy; applyCam();
      }
    });
    const end = () => {
      if (!drag) return;
      const d = drag; drag = null;
      canvas.classList.remove("panning");
      if (d.card) {
        d.card.classList.remove("dragging");
        if (d.moved) {
          pos[d.card.dataset.id] = { x: parseFloat(d.card.style.left), y: parseFloat(d.card.style.top) };
          store.set("ia_board_pos", JSON.stringify(pos));
        } else openDrawer(d.card.dataset.id);
      } else if (!d.moved) closeDrawer();
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else { cam.x -= e.deltaX; cam.y -= e.deltaY; applyCam(); }
    }, { passive: false });
  }

  // ── execução em lote ──
  function showProgress(st) {
    running = !!st.running;
    $("bd-progress").classList.toggle("hidden", !running);
    $("bd-run").disabled = running;
    $("bd-stop").classList.toggle("hidden", !running);
    if (!running) return;
    $("bd-ptext").textContent = `Analisando ${Math.min(st.done + 1, st.total)} de ${st.total}${st.current ? ": " + st.current.slice(0, 60) : ""} — ${st.suggested} com resposta, ${st.gaps} sem contexto`;
    $("bd-pbar").style.width = `${st.total ? Math.round((st.done / st.total) * 100) : 0}%`;
  }
  async function poll() {
    clearTimeout(pollTimer);
    const r = await api("/api/assistant/status");
    if (!r.ok) return;
    showProgress(r.data);
    await load();
    if (r.data.running) pollTimer = setTimeout(poll, 2000);
  }

  function init() {
    bindCanvas();
    $("bd-v-board").onclick = () => { view = "board"; store.set("ia_board_view", view); render(); };
    $("bd-v-list").onclick = () => { view = "list"; store.set("ia_board_view", view); render(); };
    $("bd-zin").onclick = () => { const c = $("bd-canvas"); zoomAt(1.2, c.clientWidth / 2, c.clientHeight / 2); };
    $("bd-zout").onclick = () => { const c = $("bd-canvas"); zoomAt(1 / 1.2, c.clientWidth / 2, c.clientHeight / 2); };
    $("bd-zfit").onclick = fit;
    $("bd-reset").onclick = () => { pos = {}; store.set("ia_board_pos", "{}"); render(); fit(); };
    const saved = store.get("ia_email_assist_limit");
    if (saved && [...$("bd-limit").options].some((o) => o.value === saved)) $("bd-limit").value = saved;
    $("bd-limit").onchange = () => store.set("ia_email_assist_limit", $("bd-limit").value);
    $("bd-run").onclick = async () => {
      $("bd-run").disabled = true;
      const r = await api(`/api/assistant/run?limit=${encodeURIComponent($("bd-limit").value)}`, "POST");
      if (!r.ok) { $("bd-run").disabled = false; toast(typeof r.data.detail === "string" ? r.data.detail : "Não consegui iniciar a análise."); return; }
      if (!r.data.running && !r.data.total) { $("bd-run").disabled = false; toast("Não há e-mails novos esperando resposta que eu ainda não tenha analisado."); return; }
      showProgress(r.data); poll();
    };
    $("bd-stop").onclick = () => api("/api/assistant/cancel", "POST");
    $("bd-listview").addEventListener("click", (e) => { const c = e.target.closest(".bd-card"); if (c) openDrawer(c.dataset.id); });
    $("bd-drawer").addEventListener("click", (e) => {
      const t = e.target.closest("[data-tab]");
      if (t) return openDrawer(selected, t.dataset.tab);
      const b = e.target.closest("[data-act]");
      if (!b) return;
      if (b.dataset.act === "close") return closeDrawer();
      act(b.dataset.act, items[selected], b);
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
    window.addEventListener("resize", () => { if (view === "board") fit(); });
    poll();
  }
  init();
})();
