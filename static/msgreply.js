// Ações por mensagem da conversa, compartilhadas entre o /copilot
// (copilot.js, messageHTML) e o /mail (app.js, renderBody):
//   · ícone de pessoas com contagem -> popover com Para / Cc / Cco da mensagem
//     (nome + e-mail + copiar). Hover no desktop, toque no celular.
//   · "Responder a esta mensagem" / "Responder a todos" -> opts.onReply(idx, all)
//     (a página abre o composer com a mensagem como alvo).
// Cabeçalhos por mensagem: GET /api/threads/{tid}/messages-meta (Gmail
// format=metadata, cache no servidor), casados pelo índice do .msg-card
// (mesma ordem dos blocos da thread, como os anexos). Sem Gmail: cabeçalhos
// da thread (/recipients), rotulados "da conversa".
//
// Uso na página:
//   head: `${MsgReply.headHTML(i)}` dentro do .msg-head de cada .msg-card[data-idx]
//   depois de cada innerHTML: MsgReply.bind(root, tid, { me, onReply })
//   MsgReply.recipientsFor(meta, idx, all, me) -> { to: [e-mails], cc: [e-mails] }
//   MsgReply.label(meta[idx] | {de, data}) -> "Paulo Lemes · 07/10 15:27"
//   MsgReply.bannerHTML(target, prefix) -> faixa "Respondendo a: … · voltar para a última"
(function () {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lower = (e) => String(e || "").trim().toLowerCase();
  const ic = (name, size) => (window.Icons ? window.Icons.svg(name, { size: size || 15 }) : "");
  const COPY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
  const cache = {}; // tid -> { status: "loading"|"ok"|"fallback"|"erro", messages, thread, promise }
  let live = { root: null, tid: "", opts: {} };
  let pop = null; // { el, btn, idx, pinned }
  let hideTimer = null;

  // "Nome <a@x>" -> {name, email}
  function parseAddr(raw) {
    const m = String(raw || "").match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
    if (m) return { name: m[1].trim(), email: lower(m[2]) };
    return /@/.test(raw || "") ? { name: "", email: lower(raw) } : { name: String(raw || "").trim(), email: "" };
  }
  function shortDate(raw) {
    const d = new Date(raw);
    if (!raw || isNaN(d)) return String(raw || "");
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "");
  }
  // meta do servidor ({from:{name,email}, date}) ou bloco da thread ({de, data})
  function label(m) {
    if (!m) return "";
    const from = m.from || parseAddr(m.de);
    const who = (from.name || from.email || "alguém").replace(/^"|"$/g, "");
    const when = shortDate(m.date || m.data);
    return when ? `${who} · ${when}` : who;
  }

  function load(tid, force) {
    if (!tid) return Promise.resolve(null);
    const hit = cache[tid];
    if (hit && !force && hit.status !== "erro") return hit.promise;
    const entry = { status: "loading", messages: null, thread: null };
    entry.promise = (async () => {
      try {
        const r = await fetch(`/api/threads/${encodeURIComponent(tid)}/messages-meta`);
        const d = await r.json().catch(() => ({}));
        if (r.ok && Array.isArray(d.messages)) {
          entry.messages = d.messages; entry.status = "ok";
          return entry.messages;
        }
      } catch (_) { /* cai no fallback */ }
      try {
        const r = await fetch(`/api/threads/${encodeURIComponent(tid)}/recipients`);
        const d = await r.json().catch(() => ({}));
        if (r.ok) { entry.thread = { to: d.to || [], cc: d.cc || [] }; entry.status = "fallback"; return null; }
      } catch (_) { /* sem nada */ }
      entry.status = "erro";
      return null;
    })().then((v) => { if (live.tid === tid && live.root) paintCounts(live.root, tid); return v; });
    cache[tid] = entry;
    return entry.promise;
  }
  const get = (tid) => (cache[tid] && cache[tid].messages) || null;
  function invalidate(tid) { delete cache[tid]; }

  // Para/Cc da resposta a UMA mensagem. Responder: o remetente dela (se foi o
  // Leo, os Para dela). Responder a todos: + Para + Cc dela, menos o Leo.
  function recipientsFor(meta, idx, all, me) {
    const m = meta && meta[idx];
    if (!m) return null;
    me = lower(me);
    const from = lower(m.from && m.from.email);
    let to = from && from !== me ? [from] : (m.to || []).map((a) => lower(a.email)).filter((e) => e && e !== me);
    if (!to.length && from) to = [from];
    const seen = new Set([me, ...to]);
    const cc = [];
    if (all) {
      [m.from, ...(m.to || []), ...(m.cc || [])].forEach((a) => {
        const e = lower(a && a.email);
        if (e && !seen.has(e)) { seen.add(e); cc.push(e); }
      });
    }
    return { to, cc };
  }

  function people(tid, idx) {
    const c = cache[tid];
    const m = c && c.messages && c.messages[idx];
    if (m) return { to: m.to || [], cc: m.cc || [], bcc: m.bcc || [], from: m.from, thread: false };
    if (c && c.thread) return { to: c.thread.to, cc: c.thread.cc, bcc: [], from: null, thread: true };
    return null;
  }
  function count(p) { return p ? p.to.length + p.cc.length + p.bcc.length : 0; }

  function headHTML(idx) {
    return `<span class="mr-acts" data-mr-idx="${idx}">
      <button type="button" class="mr-btn mr-people" data-mr-people title="Para / Cc desta mensagem" aria-label="Para e Cc desta mensagem" aria-haspopup="dialog" aria-expanded="false">${ic("users", 15)}<b class="mr-count" data-mr-count></b></button>
      <button type="button" class="mr-btn" data-mr-reply="one" title="Responder a esta mensagem" aria-label="Responder a esta mensagem">${ic("reply", 15)}</button>
      <button type="button" class="mr-btn" data-mr-reply="all" title="Responder a todos desta mensagem" aria-label="Responder a todos desta mensagem">${ic("reply-all", 15)}</button>
    </span>`;
  }

  function paintCounts(root, tid) {
    if (!root) return;
    root.querySelectorAll(".msg-card").forEach((card) => {
      const n = count(people(tid, Number(card.dataset.idx)));
      const b = card.querySelector("[data-mr-count]");
      if (b) b.textContent = n ? String(n) : "";
      const btn = card.querySelector("[data-mr-people]");
      if (btn && n) btn.setAttribute("aria-label", `Para e Cc desta mensagem (${n} ${n === 1 ? "pessoa" : "pessoas"})`);
    });
  }

  function listHTML(title, list) {
    if (!list || !list.length) return "";
    return `<section><h5>${esc(title)} <small>${list.length}</small></h5><ul>${list.map((a) => {
      const name = (a.name || "").replace(/^"|"$/g, "");
      return `<li><span class="mr-who"><span class="mr-n">${esc(name || a.email)}</span>${name ? `<span class="mr-e">${esc(a.email)}</span>` : ""}</span>
        <button type="button" class="mr-copy" data-mr-copy="${esc(a.email)}" title="Copiar ${esc(a.email)}" aria-label="Copiar e-mail ${esc(a.email)}">${COPY}</button></li>`;
    }).join("")}</ul></section>`;
  }
  function popHTML(tid, idx) {
    const p = people(tid, idx);
    const c = cache[tid];
    if (!p) {
      return c && c.status === "loading"
        ? '<p class="mr-muted">Carregando destinatários…</p>'
        : '<p class="mr-muted">Não deu para ler os destinatários agora (Gmail fora?).</p>';
    }
    const body = listHTML("Para", p.to) + listHTML("Cc", p.cc) + listHTML("Cco", p.bcc);
    return `${p.from && p.from.email ? `<p class="mr-from">De <b>${esc((p.from.name || p.from.email).replace(/^"|"$/g, ""))}</b> <span class="mr-e">${esc(p.from.email)}</span></p>` : ""}
      ${body || '<p class="mr-muted">Sem destinatários no cabeçalho.</p>'}
      ${p.thread ? '<p class="mr-note">da conversa: cabeçalhos da última mensagem (os desta não estão disponíveis agora)</p>' : ""}`;
  }

  function place(el, btn) {
    const r = btn.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 16);
    el.style.width = `${w}px`;
    el.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    const h = el.offsetHeight || 0;
    const below = r.bottom + 6;
    el.style.top = `${below + h > window.innerHeight - 8 && r.top - h - 6 > 8 ? r.top - h - 6 : below}px`;
  }
  function closePop() {
    clearTimeout(hideTimer);
    if (!pop) return;
    pop.btn.setAttribute("aria-expanded", "false");
    pop.el.remove();
    pop = null;
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onOutside, true);
  }
  function onKey(e) {
    if (e.key === "Escape" && pop) { e.stopPropagation(); e.preventDefault(); const b = pop.btn; closePop(); b.focus(); }
  }
  function onOutside(e) {
    if (pop && !pop.el.contains(e.target) && !pop.btn.contains(e.target)) closePop();
  }
  async function copy(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch (_) { /* tenta o jeito antigo */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand && document.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch (_) { return false; }
  }
  function renderPop() {
    if (!pop) return;
    pop.el.innerHTML = `<div class="mr-pop-h">Destinatários desta mensagem</div>${popHTML(live.tid, pop.idx)}`;
    pop.el.querySelectorAll("[data-mr-copy]").forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      const ok = await copy(b.dataset.mrCopy);
      b.classList.toggle("done", ok);
      b.title = ok ? "Copiado" : "Não deu para copiar";
      b.setAttribute("aria-label", ok ? `Copiado: ${b.dataset.mrCopy}` : "Não deu para copiar");
    }));
    place(pop.el, pop.btn);
  }
  function openPop(btn, pinned) {
    clearTimeout(hideTimer);
    const idx = Number(btn.closest("[data-mr-idx]").dataset.mrIdx);
    if (pop && pop.btn === btn) { if (pinned) pop.pinned = true; return; }
    closePop();
    const el = document.createElement("div");
    el.className = "mr-pop";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Para e Cc desta mensagem");
    el.setAttribute("data-annot-skip", "");
    el.onmouseenter = () => clearTimeout(hideTimer);
    el.onmouseleave = () => { if (pop && !pop.pinned) hideTimer = setTimeout(closePop, 250); };
    el.addEventListener("click", (e) => e.stopPropagation());
    document.body.appendChild(el);
    pop = { el, btn, idx, pinned: !!pinned };
    btn.setAttribute("aria-expanded", "true");
    renderPop();
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onOutside, true);
    const c = cache[live.tid];
    if (c && c.status === "loading") c.promise.then(() => { if (pop && pop.el === el) renderPop(); });
  }
  const canHover = () => !!(window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches)
    && document.body.dataset.layout !== "mobile";

  function bind(root, tid, opts) {
    if (!root) return;
    if (pop && (!document.body.contains(pop.btn) || live.tid !== tid)) closePop();
    live = { root, tid, opts: opts || {} };
    load(tid);
    paintCounts(root, tid);
    const stop = (e) => e.stopPropagation(); // não abre/recolhe o card
    root.querySelectorAll(".mr-acts").forEach((wrap) => {
      wrap.onclick = stop;
      wrap.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); };
    });
    root.querySelectorAll("[data-mr-people]").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        if (pop && pop.btn === btn && pop.pinned) closePop();
        else openPop(btn, true);
      };
      btn.onmouseenter = () => { if (canHover()) { clearTimeout(hideTimer); hideTimer = setTimeout(() => openPop(btn, false), 120); } };
      btn.onmouseleave = () => { clearTimeout(hideTimer); if (pop && pop.btn === btn && !pop.pinned) hideTimer = setTimeout(closePop, 250); };
    });
    root.querySelectorAll("[data-mr-reply]").forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        closePop();
        const idx = Number(btn.closest("[data-mr-idx]").dataset.mrIdx);
        if (live.opts.onReply) live.opts.onReply(idx, btn.dataset.mrReply === "all");
      };
    });
  }

  function bannerHTML(target, prefix) {
    if (!target) return "";
    return `<div class="mr-target" id="${prefix}-target" role="status">${ic(target.all ? "reply-all" : "reply", 14)}
      <span>Respondendo a: <b>${esc(target.label || "mensagem escolhida")}</b>${target.all ? " <small>(a todos)</small>" : ""}</span>
      <button type="button" class="mr-target-clear" id="${prefix}-target-clear" title="Voltar a responder à última mensagem da conversa">voltar para a última</button></div>`;
  }

  window.MsgReply = { load, get, invalidate, headHTML, bind, recipientsFor, label, bannerHTML, close: closePop, parseAddr };
})();
