// Copiloto (/copilot): o que precisa de você, em 3 camadas -- seu papel, o que
// aconteceu e o que eu faria (com o porquê). Cobrar, Delegar e "Aplicar" só
// preparam rascunho; o envio sai só pelo composer "Responder" do detalhe, com
// confirmação explícita, pelo mesmo endpoint do /mail (/api/threads/{id}/send).
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const PAPEL = { so_copia: "Só cópia", mencionado_opiniao: "Pedem sua opinião", demanda: "Demanda sua", fyi: "Para saber", pode_ignorar: "Pode ignorar" };
  const PAPEL_HINT = {
    so_copia: "Você está em cópia; ninguém pediu nada a você.",
    mencionado_opiniao: "Citaram você ou querem sua opinião.",
    demanda: "Tem algo que depende de você fazer ou decidir.",
    fyi: "Informativo: bom saber, sem ação.",
    pode_ignorar: "Ruído: aviso automático ou divulgação.",
  };
  const ACAO = { direcionar: "Direcionar", estudar_depois_responder: "Estudar e depois responder", pedir_contexto: "Pedir contexto", responder: "Responder", aguardar: "Aguardar" };
  const EVID = { mensagem: "Na mensagem", learning_base: "Learning Base", decisao: "Decisão anterior" };
  const URG = { alta: "urgência alta", media: "urgência média", baixa: "urgência baixa", neutra: "" };
  const STATUS = { assumido: "você acompanha", delegado: "delegado", cobrado: "cobrado", aguardando: "aguardando", resolvido: "resolvido" };
  const PASTEL = ["#ffe6d6", "#e9e4ff", "#dcf3e8", "#dfeeff", "#fff4c8", "#fbe1e4"];
  const WEEK = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"];
  // Quadro = só o que pede atenção (3 colunas). Resolvido sai do quadro (vira
  // lido no Gmail) e aparece na view "Resolvidos"; a chave da API continua "resolvido".
  const COL_HINT = {
    precisa_de_voce: "Depende de você agir ou decidir.",
    bola_com_outros: "Delegado, cobrado ou esperando retorno de alguém.",
    so_conhecimento: "Cópia, aviso ou ruído: só para saber.",
  };
  const COL_COLOR = { precisa_de_voce: "peach", bola_com_outros: "lilac", so_conhecimento: "sky", resolvido: "mint", lidos: "fog" };
  // Soltar um cartão numa coluna = a ação que leva o item para lá.
  const DROP = { precisa_de_voce: "assumir", bola_com_outros: "aguardar", so_conhecimento: "so_saber" };
  const DROP_MSG = {
    assumir: "Você acompanha.",
    aguardar: "Aguardando outras pessoas. Para passar a alguém, use Delegar.",
    so_saber: "Marcado como só para saber.",
  };
  const MODES = {
    quadro: { title: "Quadro", hint: "Não lidos que ainda pedem algo." },
    resolvido: { title: "Resolvidos", hint: "Fechados por você — já marcados como lidos no Gmail." },
    lidos: { title: "Marcados como lido", hint: "Lidos no Gmail que o copiloto já leu ou em que você agiu (sem os resolvidos)." },
  };
  const DESK = window.matchMedia("(min-width: 900px)");
  // detalhe largo (2 colunas): "O que aconteceu" vai para a coluna lateral
  const WIDE = window.matchMedia("(min-width: 1280px)");
  // preferências do usuário (/api/copilot/settings): cards laterais etc.
  let prefs = {};

  const TAB_KEYS = Object.keys(COL_HINT);
  let data = { items: [], tabs: [], historico: [], fila: { count: 0 } };
  let hist = []; // itens de ?all=1 para as views de histórico
  let mode = sessionStorage.getItem("cp_mode");
  if (!(mode in MODES)) mode = "quadro";
  let tab = sessionStorage.getItem("cp_tab");
  if (!TAB_KEYS.includes(tab)) tab = "precisa_de_voce";
  let queueOpen = sessionStorage.getItem("cp_queue_open") === "1"; // fila "Analisando" aberta na lista
  let view = "kanban";
  try { if (localStorage.getItem("cp_view") === "lista") view = "lista"; } catch { /* sem armazenamento */ }
  let current = null;
  let pollTimer = null;
  let shown = null; // item aberto no detalhe (para re-render sem nova busca)
  let threadOpen = true; // conversa completa aberta no detalhe
  let summaryOpen = true; // camada 2 (resumo) visível por padrão
  // Composer "Responder": estado fora do HTML para sobreviver aos re-renders do detalhe.
  let reply = null; // { tid, open, text, aiText, instr, extraCc, all, recipients, busy, status }
  // Citações (trecho do e-mail/resumo ou do próprio rascunho + comentário):
  // mesma mecânica do /mail (static/annotate.js); a lista vive no módulo,
  // aparece como chips numerados no composer e vai como instruction no /draft.
  let annotTid = null;
  const annot = window.Annotate.create({
    areas: () => [$("cp-summary"), $("cp-thread")],
    textareas: () => [$("cp-reply-text")].filter(Boolean),
    enabled: () => !!shown && $("cp-detail").classList.contains("open"),
    onChange: () => renderAnnots(),
    // citou com o composer fechado: abre o composer (sem gerar nem rolar)
    onAdd: () => { if (shown && (!reply || !reply.open)) openReply(shown, { noGenerate: true, noScroll: true }); },
  });
  let canSend = false; // /api/status.can_send (escopo gmail.send)
  let me = "";
  const readingNow = new Set(); // leituras individuais em andamento (abrir / Ler de novo)
  const avatars = {};
  const layout = () => document.body.dataset.layout;
  // Ícones: módulo compartilhado static/icons.js (o mesmo do /mail, /settings, /board).
  const ic = (name, o) => (window.Icons ? window.Icons.svg(name, Object.assign({ size: 22 }, o || {})) : "");
  const ICO = {
    eye: ic("eye"), bell: ic("bell"), bellOff: ic("bell-off"), share: ic("handoff"),
    // Resolvido: duplo check em círculo, em verde (CSS .ic-check-circle-double)
    done: ic("check-circle-double"), reopen: ic("reopen"), thread: ic("thread"), summary: ic("summary"),
    gmail: ic("gmail"), mail: ic("mail"), reply: ic("reply"), send: ic("send"), spark: ic("sparkles"),
    learn: ic("learn"), chat: ic("chat"), trash: ic("trash"), back: ic("back"),
  };
  const ROLE_ICON = { so_copia: "role-copia", mencionado_opiniao: "role-opiniao", demanda: "role-demanda", fyi: "role-fyi", pode_ignorar: "role-ignorar" };
  // tip: texto do tooltip (padrão = label); off: desabilitado mas com tooltip
  // (aria-disabled em vez de disabled, senão o navegador não mostra o hover).
  const iconBtn = (act, label, icon, extra = "", tip = "", off = false) =>
    `<button type="button" class="cp-btn cp-icon-act${act === "acompanhar" || act === "assumir" ? " primary" : ""}${off ? " is-off" : ""}" data-act="${act}" title="${esc(tip || label)}" aria-label="${esc(tip || label)}"${off ? ' aria-disabled="true"' : ""} ${extra}>${icon}<span class="cp-icon-tip">${esc(tip || label)}</span></button>`;

  // A IA precisa ler? (não leu, ou chegou mensagem nova). Propaganda,
  // credencial e corpo ilegível ficam com a leitura por regra de propósito.
  const needsAI = (it) => !!data.llm && ((!it.analisado && !it.lido_por_regra) || it.desatualizado);
  const isReading = (it) => {
    if (readingNow.has(it.thread_id)) return true;
    const job = data.job || {};
    return !!job.running && (job.current_id === it.thread_id || (job.pending || []).includes(it.thread_id));
  };
  function aiChip(it) {
    if (isReading(it)) return `<span class="cp-reading-chip">${it.desatualizado ? "lendo de novo…" : "lendo…"}</span>`;
    if (!it.analisado && !it.lido_por_regra && !data.llm) return '<span class="cp-unread-ai">sem IA: leitura por regra</span>';
    if (it.desatualizado && data.llm) return '<span class="cp-unread-ai">mensagem nova</span>';
    if (needsAI(it)) return '<span class="cp-unread-ai">na fila da IA</span>';
    return "";
  }

  // ── fila "Analisando": o que a IA ainda não leu fica fora das colunas ──
  const queueItems = () => data.items.filter((i) => i.pendente);
  function queueChip(it) {
    const job = data.job || {};
    if (readingNow.has(it.thread_id) || (job.running && job.current_id === it.thread_id)) return '<span class="cp-reading-chip">lendo agora</span>';
    if (it.falhou && !isReading(it)) return `<button type="button" class="cp-chip cp-retry" data-retry="${esc(it.thread_id)}">falhou — tentar de novo</button>`;
    return '<span class="cp-unread-ai">na fila</span>';
  }
  function qcardHTML(it) {
    return `<li class="cp-qcard${it.falhou ? " failed" : ""}${current === it.thread_id ? " sel" : ""}" data-id="${esc(it.thread_id)}" tabindex="0">
      <h3>${esc(it.subject)}</h3><div class="cp-q-from">${esc(it.from_name)}</div><div class="cp-q-meta">${queueChip(it)}</div></li>`;
  }
  function queueHead(items) {
    const fails = items.filter((i) => i.falhou).length;
    return `Analisando<b>${items.length}</b>${fails ? `<span class="cp-q-fail">${fails} com falha</span>` : ""}`;
  }
  function renderQueueList() {
    const items = queueItems();
    const box = $("cp-queue");
    if (!items.length) { box.innerHTML = ""; box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    box.innerHTML = `<button type="button" class="cp-queue-h" id="cp-queue-tog" aria-expanded="${queueOpen}">
        <span>${queueHead(items)}</span><small>${queueOpen ? "esconder" : "a IA ainda não leu — ver"}</small></button>
      ${queueOpen ? `<ul class="cp-queue-list">${items.map(qcardHTML).join("")}</ul>` : ""}`;
    $("cp-queue-tog").onclick = () => { queueOpen = !queueOpen; sessionStorage.setItem("cp_queue_open", queueOpen ? "1" : "0"); renderQueueList(); };
  }
  function queueStripHTML() {
    const items = queueItems();
    if (!items.length) return "";
    return `<section class="cp-qstrip" aria-label="Analisando">
      <header><h2>${queueHead(items)}</h2><p>A IA ainda não leu: cada um entra na coluna certa quando a leitura terminar.</p></header>
      <ul class="cp-qstrip-list">${items.map(qcardHTML).join("")}</ul></section>`;
  }
  function bindQueue(root) {
    root.addEventListener("click", (e) => {
      const retry = e.target.closest("[data-retry]");
      if (retry) { e.stopPropagation(); readNow(retry.dataset.retry, true); return; }
      const c = e.target.closest(".cp-qcard");
      if (c) open(c.dataset.id);
    });
    root.addEventListener("keydown", (e) => { const c = e.target.closest(".cp-qcard"); if (c && e.key === "Enter") open(c.dataset.id); });
  }

  const api = async (url, method, body, timeoutMs) => {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const ms = timeoutMs || (method && method !== "GET" ? 120000 : 30000);
    const timer = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
    try {
      const res = await fetch(url, {
        method: method || "GET",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl ? ctrl.signal : undefined,
      });
      return { ok: res.ok, data: await res.json().catch(() => ({})) };
    } catch (e) {
      const aborted = e && (e.name === "AbortError" || /abort/i.test(String(e.message || e)));
      return { ok: false, data: { detail: aborted ? "A leitura demorou demais. Tente de novo." : "Sem conexão com o servidor." } };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let toastTimer;
  function toast(text) {
    const el = $("cp-toast");
    el.textContent = text; el.classList.remove("hidden");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add("hidden"), 4200);
  }
  function ago(ms) {
    if (!ms) return "";
    const diff = Date.now() - ms;
    const days = Math.floor(diff / 86400000);
    if (days <= 0) {
      const h = Math.floor(diff / 3600000);
      return h <= 0 ? "há menos de 1 h" : `há ${h} h`;
    }
    return days === 1 ? "há 1 dia" : `há ${days} dias`;
  }
  const ddmm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : "");

  // ── avatar: só a fotinha (iniciais em pastel quando não tem foto) ──
  function initials(name, email) {
    const base = (name || email || "?").replace(/["<].*$/, "").trim();
    const parts = base.split(/[\s.@_-]+/).filter(Boolean);
    return ((parts[0] || "?")[0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
  }
  // Sem nome nem e-mail: "–" em cinza (nunca "?"), com title explicando.
  // Mesmo link do /mail (gmailThreadUrl em app.js): o thread_id do app é o id
  // da thread no Gmail; authuser abre na conta certa com várias contas logadas.
  function gmailThreadUrl(id) {
    const authuser = me ? `?authuser=${encodeURIComponent(me)}` : "";
    return `https://mail.google.com/mail/${authuser}#all/${encodeURIComponent(id)}`;
  }
  function avatarHTML(email, name, big, aria, title) {
    const known = !!(name || email);
    const label = name || email || "Ninguém identificado";
    const color = known ? PASTEL[[...(email || label)].reduce((a, c) => a + c.charCodeAt(0), 0) % PASTEL.length] : "var(--fog)";
    const a11y = aria === false ? 'aria-hidden="true"' : `aria-label="${esc(aria || `Com ${label}`)}"`;
    return `<span class="cp-ava${big === "sm" ? " sm" : big ? " big" : ""}${known ? "" : " none"}" data-ava="${esc(email || "")}" style="background:${color}" title="${esc(title || label)}" ${a11y}>${known ? esc(initials(name, email)) : "–"}</span>`;
  }
  // Dono da bola: com você = foto/iniciais da conta; com outros = a pessoa
  // identificada (nome ou e-mail); sem ninguém identificado = "–".
  function ballAvatarHTML(it, big) {
    const b = it.bola || {};
    if (b.com === "ninguem") return "";
    if (b.com === "leo") {
      const acct = b.email || me;
      return avatarHTML(acct, (acct || "você").split("@")[0], big, "Com você", "Bola com: Você");
    }
    const who = b.nome || b.email;
    return avatarHTML(b.email, b.nome, big, who ? `Aguardando: ${who}` : "Aguardando: ninguém identificado", who ? `Bola com: ${who}` : "Ninguém identificado");
  }
  async function hydrateAvatars(root) {
    root.querySelectorAll("[data-ava]").forEach(async (el) => {
      const email = el.dataset.ava;
      if (!email) return;
      if (!(email in avatars)) {
        avatars[email] = api(`/api/avatar?email=${encodeURIComponent(email)}`).then((r) => (r.ok && r.data.photo_url) || null);
      }
      const url = await avatars[email];
      if (url) el.innerHTML = `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer">`;
    });
  }

  // ── lista ──
  function renderTabs() {
    $("cp-tabs").innerHTML = data.tabs
      .map((t) => `<button type="button" role="tab" class="cp-tab${t.key === tab ? " on" : ""}" data-tab="${t.key}" aria-selected="${t.key === tab}">${esc(t.title)}<b>${t.count}</b></button>`)
      .join("");
  }
  // "respondido por Denis" (das mensagens reais) para a lista/kanban
  function answeredBy(it) {
    const c = it.conversa;
    if (!c || c.status !== "respondido" || !c.respondido) return "";
    return c.respondido.voce ? "você respondeu" : `respondido por ${String(c.respondido.nome || "").split(/\s+/)[0]}`;
  }
  function itemHTML(it) {
    const chips = [`<span class="cp-chip p-${it.papel}">${esc(PAPEL[it.papel] || it.papel)}</span>`];
    if (URG[it.urgencia]) chips.push(`<span class="cp-chip u-${it.urgencia}">${URG[it.urgencia]}</span>`);
    if (it.prazo) chips.push(`<span class="cp-chip soft">prazo ${ddmm(it.prazo)}</span>`);
    if (STATUS[it.status]) chips.push(`<span class="cp-chip soft">${STATUS[it.status]}</span>`);
    if (it.sem_resposta_desde && it.tab !== "resolvido") chips.push(`<span class="cp-chip soft">sem resposta ${ago(it.sem_resposta_desde)}</span>`);
    else if (answeredBy(it)) chips.push(`<span class="cp-chip soft ok">${esc(answeredBy(it))}</span>`);
    const ai = aiChip(it);
    if (ai) chips.push(ai);
    const bola = it.bola ? ballAvatarHTML(it) : "";
    return `<li class="cp-item u-${it.urgencia}${current === it.thread_id ? " sel" : ""}" data-id="${esc(it.thread_id)}" tabindex="0">
      <div class="cp-item-main"><h3>${esc(it.subject)}</h3><p>${esc(it.o_que_aconteceu || it.from_name)}</p><div class="cp-meta">${chips.join("")}</div></div>${bola}</li>`;
  }
  const emptyHTML = () => `<li class="cp-empty">${data.show_all ? "Nada por aqui." : "Nenhum não lido aqui."} 🌿</li>`;
  // ── views: Quadro | Resolvidos | Marcados como lido ──
  const histKey = (i) => (i.status === "resolvido" ? "resolvido" : !i.is_unread && i.no_copiloto && !i.pendente ? "lidos" : "");
  // cabeçalho pastel + contador + subtítulo (o mesmo das colunas do quadro)
  const secHead = (title, n, hint, color, tag = "h2") =>
    `<header class="cp-col-h h-${color}"><${tag}>${esc(title)}${n == null ? "" : `<b>${n}</b>`}</${tag}>${hint ? `<p>${esc(hint)}</p>` : ""}</header>`;
  function renderModes() {
    const counts = Object.fromEntries((data.historico || []).map((h) => [h.key, h.count]));
    const board = (data.tabs || []).reduce((a, t) => a + t.count, 0) + ((data.fila && data.fila.count) || 0);
    $("cp-views").innerHTML = Object.entries(MODES)
      .map(([k, m]) => {
        const n = k === "quadro" ? board : counts[k] || 0;
        return `<button type="button" role="tab" class="cp-view${k === mode ? " on" : ""}" data-mode="${k}" aria-selected="${k === mode}">${esc(m.title)}<b>${n}</b></button>`;
      })
      .join("");
    document.body.dataset.mode = mode;
  }
  function renderHistory() {
    const box = $("cp-hist");
    const items = hist.filter((i) => histKey(i) === mode).sort((a, b) => (b.internal_date || 0) - (a.internal_date || 0));
    let secs;
    if (mode === "resolvido") secs = [{ key: "resolvido", title: "Resolvidos", hint: MODES.resolvido.hint, items }];
    else secs = (data.tabs || []).map((t) => ({ key: t.key, title: t.title, hint: `Lido no Gmail · ${COL_HINT[t.key] || ""}`, items: items.filter((i) => i.tab === t.key) }));
    box.innerHTML = `<div class="cp-hsecs">${secs
      .map((s) => `<section class="cp-hsec" aria-label="${esc(s.title)}">${secHead(s.title, s.items.length, s.hint, COL_COLOR[s.key] || "fog")}
        <ul class="cp-list cp-hlist">${s.items.length ? s.items.map(itemHTML).join("") : '<li class="cp-empty">Nada por aqui. 🌿</li>'}</ul></section>`)
      .join("")}</div>`;
    hydrateAvatars(box);
  }
  function setMode(next) {
    if (!(next in MODES) || next === mode) return;
    mode = next;
    sessionStorage.setItem("cp_mode", mode);
    renderModes();
    if (mode === "quadro") renderList();
    else { $("cp-hist").innerHTML = '<p class="cp-empty">Carregando…</p>'; load(); }
  }
  function renderList() {
    if (mode !== "quadro") { renderHistory(); return; }
    if (layout() === "kanban") { renderBoard(); return; }
    if (!data.tabs.some((t) => t.key === tab)) tab = "precisa_de_voce";
    renderTabs();
    renderQueueList();
    const items = data.items.filter((i) => i.tab === tab);
    $("cp-list").innerHTML = items.length ? items.map(itemHTML).join("") : emptyHTML();
    hydrateAvatars($("cp-list"));
  }

  // ── kanban (desktop) ──
  function kcardHTML(it) {
    const bola = it.bola ? ballAvatarHTML(it) : "";
    const from = [it.from_name, it.sem_resposta_desde && it.tab !== "resolvido" ? `sem resposta ${ago(it.sem_resposta_desde)}` : answeredBy(it)].filter(Boolean).join(" · ");
    const op = (it.opcoes || [])[0];
    let faria;
    if (it.analisado || it.lido_por_regra) faria = op ? `${ACAO[op.acao] || op.acao}${op.texto ? `: ${op.texto}` : ""}` : it.needs_context ? "Preciso de contexto" : "Nada a fazer";
    else faria = isReading(it) ? "Lendo…" : "";
    const layers = `<ul class="cp-layers">
        <li><i>1</i><span><span class="cp-chip p-${it.papel}">${esc(PAPEL[it.papel] || it.papel)}</span></span></li>
        ${it.o_que_aconteceu ? `<li><i>2</i><span>${esc(it.o_que_aconteceu)}</span></li>` : ""}
        ${faria ? `<li class="${faria === "Lendo…" ? "cp-reading" : ""}"><i>3</i><span>${esc(faria)}</span></li>` : ""}</ul>`;
    const meta = [];
    if (URG[it.urgencia]) meta.push(`<span class="cp-chip u-${it.urgencia}">${URG[it.urgencia]}</span>`);
    if (it.prazo) meta.push(`<span class="cp-chip soft">prazo ${ddmm(it.prazo)}</span>`);
    if (STATUS[it.status] && it.tab !== "resolvido") meta.push(`<span class="cp-chip soft">${STATUS[it.status]}</span>`);
    const ai = aiChip(it);
    if (ai) meta.push(ai);
    return `<li class="cp-kcard u-${it.urgencia}${current === it.thread_id ? " sel" : ""}" draggable="true" data-id="${esc(it.thread_id)}" tabindex="0">
      <div class="cp-k-top"><h3>${esc(it.subject)}</h3>${bola}</div>
      ${from ? `<div class="cp-k-from">${esc(from)}</div>` : ""}${layers}
      ${meta.length ? `<div class="cp-k-meta">${meta.join("")}</div>` : ""}</li>`;
  }
  function renderBoard() {
    const board = $("cp-board");
    const scroll = {};
    board.querySelectorAll(".cp-col").forEach((c) => (scroll[c.dataset.col] = c.querySelector(".cp-col-list").scrollTop));
    const strip = board.querySelector(".cp-qstrip-list");
    const stripScroll = strip ? strip.scrollLeft : 0;
    const queue = queueStripHTML();
    board.classList.toggle("has-queue", !!queue);
    board.innerHTML = queue + data.tabs
      .map((t) => {
        const items = data.items.filter((i) => i.tab === t.key);
        return `<section class="cp-col t-${t.key}" data-col="${t.key}" aria-label="${esc(t.title)}">
          ${secHead(t.title, items.length, COL_HINT[t.key] || "", COL_COLOR[t.key] || "fog")}
          <ul class="cp-col-list">${items.length ? items.map(kcardHTML).join("") : emptyHTML()}</ul></section>`;
      })
      .join("");
    board.querySelectorAll(".cp-col").forEach((c) => (c.querySelector(".cp-col-list").scrollTop = scroll[c.dataset.col] || 0));
    if (board.querySelector(".cp-qstrip-list")) board.querySelector(".cp-qstrip-list").scrollLeft = stripScroll;
    hydrateAvatars(board);
  }
  async function moveTo(id, col) {
    const it = data.items.find((i) => i.thread_id === id);
    if (!it || it.pendente || it.tab === col || !DROP[col]) return; // pendente não se arrasta: espera a leitura
    const action = DROP[col];
    const prev = it.tab;
    it.tab = col; // otimista: o cartão já aparece na coluna nova
    renderBoard();
    const card = $("cp-board").querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (card) card.classList.add("pending");
    const r = await api(`/api/copilot/${encodeURIComponent(id)}/action`, "POST", { action });
    if (!r.ok) { it.tab = prev; renderBoard(); toast(r.data.detail || "Não deu certo."); return; }
    toast(DROP_MSG[action]);
    if (current === id && $("cp-detail").classList.contains("open")) renderDetail(r.data.item);
    load();
  }
  function bindBoard() {
    const board = $("cp-board");
    let dragId = null;
    board.addEventListener("dragstart", (e) => {
      const card = e.target.closest(".cp-kcard");
      if (!card) return;
      dragId = card.dataset.id;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragId);
      requestAnimationFrame(() => card.classList.add("dragging"));
    });
    board.addEventListener("dragend", () => {
      dragId = null;
      board.querySelectorAll(".dragging,.over").forEach((el) => el.classList.remove("dragging", "over"));
    });
    board.addEventListener("dragover", (e) => {
      const col = e.target.closest(".cp-col");
      if (!col || !dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      board.querySelectorAll(".cp-col.over").forEach((c) => c !== col && c.classList.remove("over"));
      col.classList.add("over");
    });
    board.addEventListener("dragleave", (e) => {
      const col = e.target.closest(".cp-col");
      if (col && !col.contains(e.relatedTarget)) col.classList.remove("over");
    });
    board.addEventListener("drop", (e) => {
      const col = e.target.closest(".cp-col");
      if (!col || !dragId) return;
      e.preventDefault();
      col.classList.remove("over");
      moveTo(dragId, col.dataset.col);
    });
    board.addEventListener("click", (e) => { const c = e.target.closest(".cp-kcard"); if (c) open(c.dataset.id); });
    board.addEventListener("keydown", (e) => { const c = e.target.closest(".cp-kcard"); if (c && e.key === "Enter") open(c.dataset.id); });
    bindQueue(board);
  }

  // ── layout: celular (lista → detalhe) ou desktop (kanban | lista) ──
  function applyLayout() {
    const next = DESK.matches ? view : "mobile";
    const changed = layout() !== next;
    document.body.dataset.layout = next;
    document.querySelectorAll(".cp-viewtog [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    $("cp-scrim").classList.remove("open");
    document.body.classList.toggle("cp-page", next === "kanban" && $("cp-detail").classList.contains("open"));
    if (changed && data.tabs.length) renderList();
    if (changed && shown && $("cp-detail").classList.contains("open")) renderDetail(shown); // botão Voltar / colunas mudam
  }
  async function load() {
    const want = mode;
    const [r, h] = await Promise.all([api("/api/copilot"), want === "quadro" ? null : api("/api/copilot?all=1")]);
    if (!r.ok) { toast(r.data.detail || "Falha ao carregar."); return; }
    data = r.data;
    if (h && want === mode) hist = h.ok ? h.data.items || [] : [];
    renderModes();
    $("cp-hello").textContent = data.saudacao;
    const day = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
    $("cp-date").textContent = countLine(day);
    $("cp-date").title = COUNT_HINT;
    $("cp-n-hoje").textContent = data.cards.hoje;
    $("cp-n-esp").textContent = data.cards.esperando_outros;
    renderList();
    showJob(data.job);
    // o lote acabou de ler o item aberto: atualiza o detalhe sem o Leo pedir
    if (shown && current === shown.thread_id && $("cp-detail").classList.contains("open") && !readingNow.has(current)) {
      const fresh = data.items.concat(hist).find((i) => i.thread_id === current);
      if (fresh && fresh.analisado && (!shown.analisado || fresh.analyzed_at !== shown.analyzed_at)) open(current, true);
      else if (fresh && isReading(fresh) !== isReading(shown)) renderDetail(shown);
    }
  }

  // Contagem: o Gmail mostra os não lidos da aba Principal; o quadro mostra só
  // os não lidos que ainda pedem algo (sem respondidos/resolvidos/automáticos).
  const COUNT_HINT = "Gmail Principal = o número da aba Principal do Gmail (não lidos). Promoções, Atualizações, Fóruns e Social não entram no copiloto. "
    + "No quadro ficam só os não lidos que ainda pedem algo: os que você já respondeu, os resolvidos e os avisos automáticos saem. "
    + "Em \"só não lidos\" as colunas (Aguardando, Só conhecimento) contam apenas não lidos — ative \"Mostrar todos\" nos ajustes para ver os lidos.";
  function countLine(day) {
    const sy = data.sync || {};
    const parts = [day];
    const gm = sy.gmail_primary_unread;
    if (gm != null) parts.push(`Gmail Principal: ${gm} não lido${gm === 1 ? "" : "s"}`);
    const n = data.items.length;
    parts.push(data.show_all ? `copiloto: ${data.total}` : `no quadro: ${n} não lido${n === 1 ? "" : "s"}`);
    if (sy.last_sync_label) parts.push(`${sy.minutes_since_sync >= 30 ? "⚠ último sync" : "sincronizado"} ${sy.last_sync_label}`);
    return parts.join(" · ");
  }
  const offlineToast = (st) => toast(st === "auth_error" ? "O acesso ao Gmail expirou: entre no Gmail de novo para baixar e-mails novos." : "Sem conexão: não consegui baixar e-mails novos. Mostro o que já estava aqui.");

  // ── leitura da IA em lote ──
  function showJob(job) {
    const el = $("cp-progress");
    $("cp-run").classList.toggle("spin", !!(job && job.running));
    if (job && job.running) {
      el.textContent = `A IA está lendo ${Math.min(job.done + 1, job.total)} de ${job.total}${job.current ? ` · ${job.current}` : ""}`;
      el.classList.remove("hidden");
      clearTimeout(pollTimer);
      pollTimer = setTimeout(async () => {
        const r = await api("/api/copilot/status");
        if (!r.ok) { showJob(job); return; }
        // terminou ou leu mais um: recarrega (cartões trocam "lendo…" pela leitura,
        // e ao fim o servidor já emenda o próximo lote se ainda faltar)
        if (!r.data.running || r.data.done !== job.done) { if (!r.data.running) el.classList.add("hidden"); load(); }
        else showJob(r.data);
      }, 2500);
    } else if (job && job.paused) {
      el.textContent = "Leitura da IA pausada: sem conexão com o Gmail. Volta sozinha quando a conexão voltar.";
      el.classList.remove("hidden");
    } else el.classList.add("hidden");
  }
  // ⟳: primeiro baixa o Gmail (antes só relia o banco local, e "Nada novo"
  // aparecia mesmo com dias sem sincronizar), depois põe a IA para ler.
  $("cp-run").onclick = async () => {
    const btn = $("cp-run");
    if (btn.classList.contains("spin")) return;
    btn.classList.add("spin");
    const s = await api("/api/sync/now", "POST", undefined, 120000);
    btn.classList.remove("spin");
    if (window.NetStatus) window.NetStatus.refresh();
    const st = s.ok ? s.data : {};
    if (!s.ok || (st.status && st.status !== "online")) { offlineToast(st.status); load(); return; }
    const fetched = (st.result && st.result.fetched) || 0;
    const synced = fetched ? `Gmail sincronizado: ${fetched} conversa${fetched === 1 ? "" : "s"} nova${fetched === 1 ? "" : "s"}/atualizada${fetched === 1 ? "" : "s"}.` : "Gmail sincronizado: nada novo.";
    if (!data.llm) { toast(`${synced} Sem chave de IA: sigo só com a leitura por regra.`); load(); return; }
    const r = await api("/api/copilot/run?limit=12", "POST");
    if (!r.ok) { toast(r.data.detail || "Falha ao iniciar."); load(); return; }
    if (r.data.paused) offlineToast(r.data.paused);
    else if (!r.data.running) toast(`${synced} A IA já leu tudo.`);
    else { toast(synced); showJob(r.data); }
    load();
  };

  // ── detalhe ──
  function evidenceHTML(ev) {
    return `<div class="cp-ev"><b>${esc(EVID[ev.tipo] || ev.tipo)} · ${esc(ev.titulo)}</b><q>${esc(ev.trecho)}</q>${ev.porque ? `<small>${esc(ev.porque)}</small>` : ""}</div>`;
  }
  // Resumo do card: camada 2 + quem abriu pedindo o quê, o que você respondeu
  // e quem escreveu por último (montado no servidor a partir das mensagens).
  function resumoHTML(it) {
    const rc = it.resumo_contexto || {};
    const who = (p) => (p.voce ? "Você" : p.nome || p.email || "Alguém");
    const when = (p) => (p.data ? ` <small>${esc(fmtDate(p.data))}</small>` : "");
    const rows = [];
    if (rc.o_que_aconteceu || it.o_que_aconteceu) rows.push(["Em uma linha", `<p>${esc(rc.o_que_aconteceu || it.o_que_aconteceu)}</p>`]);
    if (rc.abertura) rows.push([`Quem abriu${rc.abertura.voce ? "" : " e o que pediu"}`, `<p><b>${esc(who(rc.abertura))}</b>${when(rc.abertura)}</p>${rc.abertura.trecho ? `<q>${esc(rc.abertura.trecho)}</q>` : ""}`]);
    rows.push(["O que você respondeu", rc.sua_resposta ? `<p>${when(rc.sua_resposta).trim() || ""}</p><q>${esc(rc.sua_resposta.trecho)}</q>` : '<p class="cp-from">Você ainda não respondeu nesta conversa.</p>']);
    if (rc.ultima) rows.push(["Último a escrever", `<p><b>${esc(who(rc.ultima))}</b>${when(rc.ultima)}</p>${rc.ultima.trecho ? `<q>${esc(rc.ultima.trecho)}</q>` : ""}`]);
    const n = rc.total_mensagens || 0;
    return `<details class="cp-why cp-resumo"><summary>Resumo${n ? ` · ${n} ${n === 1 ? "mensagem" : "mensagens"}` : ""}</summary>
      <dl class="cp-rc">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl></details>`;
  }
  function optionHTML(it, op, i) {
    const pct = Math.round((op.confianca || 0) * 100);
    return `<div class="cp-opt"><div class="cp-opt-h"><strong>${esc(ACAO[op.acao] || op.acao)}</strong>
      <button type="button" class="cp-btn" data-apply="${i}">Aplicar</button></div>
      ${op.texto ? `<p>${esc(op.texto)}</p>` : ""}${op.para ? `<p class="cp-from">para ${esc(op.para)}</p>` : ""}
      <div class="cp-conf">confiança <span><i style="width:${pct}%"></i></span> ${pct}%</div>
      <div class="cp-opt-more">${resumoHTML(it)}
      <details class="cp-why"><summary>Por quê?</summary>${op.evidencias.map(evidenceHTML).join("")}</details></div></div>`;
  }

  // ── thread: mesmo desenho do /mail (cartão por mensagem, citação recolhida, links) ──
  const QUOTE_RE = /\n(?=>? ?(?:Em [\s\S]{0,160}?escreveu:|On [\s\S]{0,160}?wrote:))/;
  function splitQuoted(text) {
    const m = text.match(QUOTE_RE);
    if (!m || m.index === undefined) return { main: text, quoted: null };
    return { main: text.slice(0, m.index).trimEnd(), quoted: text.slice(m.index).trim() };
  }
  // links clicáveis; desembrulha o redirect de rastreio do Gmail (google.com/url?q=)
  function linkify(text) {
    const urlRe = /https?:\/\/[^\s<>"')]+/g;
    let out = "", last = 0, m;
    while ((m = urlRe.exec(text))) {
      out += esc(text.slice(last, m.index));
      let raw = m[0], trail = "";
      const t = raw.match(/[.,;:!?]+$/);
      if (t) { trail = t[0]; raw = raw.slice(0, -trail.length); }
      let href = raw;
      if (/^https?:\/\/(www\.)?google\.com\/url\?/.test(raw)) {
        try { href = new URL(raw).searchParams.get("q") || raw; } catch { /* mantém raw */ }
      }
      out += `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(href)}</a>${esc(trail)}`;
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }
  function parseFrom(raw) {
    const m = (raw || "").match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
    if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim().toLowerCase() };
    return { name: (raw || "").trim(), email: /@/.test(raw || "") ? raw.trim().toLowerCase() : "" };
  }
  function fmtDate(raw) {
    const d = new Date(raw);
    if (!raw || isNaN(d)) return raw || "";
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function messageHTML(m, i, n) {
    const { name, email } = parseFrom(m.de);
    const { main, quoted } = splitQuoted(m.texto || "");
    const last = i === n - 1;
    return `<div class="msg-card${last ? " open" : ""}">
      <div class="msg-head" role="button" tabindex="0" aria-expanded="${last}">
        ${avatarHTML(email, name, "sm", false)}
        <span class="msg-from">${esc(name || "—")}${email && email !== name.toLowerCase() ? ` <small>&lt;${esc(email)}&gt;</small>` : ""}</span>
        ${quoted ? `<button type="button" class="msg-quoted-hint" title="Esta mensagem cita um e-mail anterior">${ic("reply", { size: 14 })} e-mail anterior citado</button>` : ""}
        <span class="msg-date">${esc(fmtDate(m.data))}</span>
      </div>
      <div class="msg-text">${linkify(main)}${quoted ? `<div class="quote-toggle-row"><button type="button" class="quote-toggle">Ver texto completo</button></div>
        <div class="msg-quoted hidden">${linkify(quoted)}</div>` : ""}</div></div>`;
  }
  function bindThread(root) {
    const toggleQuote = (card, show) => {
      const q = card.querySelector(".msg-quoted");
      const hidden = q.classList.toggle("hidden", show === undefined ? undefined : !show);
      card.querySelector(".quote-toggle").textContent = hidden ? "Ver texto completo" : "Ocultar texto citado";
      return { q, hidden };
    };
    root.querySelectorAll(".msg-head").forEach((head) => {
      const flip = () => { const c = head.closest(".msg-card"); head.setAttribute("aria-expanded", c.classList.toggle("open")); };
      head.onclick = flip;
      head.onkeydown = (e) => { if ((e.key === "Enter" || e.key === " ") && e.target === head) { e.preventDefault(); flip(); } };
    });
    root.querySelectorAll(".quote-toggle").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); toggleQuote(b.closest(".msg-card")); }));
    root.querySelectorAll(".msg-quoted-hint").forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      const card = b.closest(".msg-card");
      card.classList.add("open");
      const { q, hidden } = toggleQuote(card, true);
      if (!hidden) q.scrollIntoView({ behavior: "smooth", block: "center" });
    }));
  }
  // "Respondido por Denis · 05/10 17:48" ou "Sem resposta: há 2 h · desde 05/10 15:25"
  function answerFact(it) {
    const conv = it.conversa;
    if (conv && conv.status === "respondido" && conv.rotulo_resposta) return ["Resposta", conv.rotulo_resposta];
    if (it.sem_resposta_desde) {
      const since = conv && conv.status === "aguardando" ? (conv.rotulo_resposta || "").replace(/^Sem resposta\s*/, "") : "";
      return ["Sem resposta", `${ago(it.sem_resposta_desde)}${since ? ` · ${since}` : ""}`];
    }
    return null;
  }
  // Cabeçalho: quem pediu · se já responderam · com quem está o próximo passo
  // (mesma fonte do card "Quem pediu / Resposta" -- it.conversa).
  function headLine(it, ballLabel) {
    const conv = it.conversa;
    const parts = [];
    if (conv && conv.solicitante) parts.push(conv.solicitante.voce ? "Você pediu" : `${esc(conv.solicitante.nome)} pediu`);
    else parts.push(esc(it.from_name));
    if (conv && conv.status === "respondido" && conv.rotulo_resposta) parts.push(`<span class="cp-answered">${ic("check", { size: 14 })}${esc(conv.rotulo_resposta)}</span>`);
    else if (it.sem_resposta_desde) parts.push(`sem resposta ${esc(ago(it.sem_resposta_desde))}`);
    parts.push(esc(ballLabel));
    return parts.join(" · ");
  }
  // Por que "Cobrar" está desligado (tooltip do sino riscado)
  function cobrarOffReason(it) {
    const conv = it.conversa;
    if (conv && conv.status === "respondido" && conv.respondido && !conv.respondido.voce) return `${conv.respondido.nome} já respondeu${it.bola.com === "leo" ? " e o próximo passo é seu" : ""}.`;
    if (it.bola.com === "leo") return "o próximo passo é seu; ninguém está te devendo resposta.";
    return "ninguém está devendo resposta nesta conversa.";
  }
  function renderDetail(it) {
    const box = $("cp-detail");
    if (!shown || shown.thread_id !== it.thread_id) { threadOpen = true; summaryOpen = true; }
    shown = it;
    // outra conversa aberta: as citações da anterior não valem mais
    if (annotTid !== it.thread_id) { if (annot.count()) annot.reset(); annotTid = it.thread_id; }
    syncReply(it);
    // re-render no meio da digitação (leitura da IA terminou, etc.): não perde o cursor
    const typing = document.activeElement && ["cp-reply-text", "cp-reply-instr"].includes(document.activeElement.id) ? document.activeElement : null;
    const caret = typing ? [typing.id, typing.selectionStart, typing.selectionEnd, typing.scrollTop] : null;
    const reading = isReading(it);
    const msgs = it.mensagens || [];
    // quem pediu / respondido / sem resposta: das mensagens reais (it.conversa,
    // montado no servidor) -- a mesma fonte para o cabeçalho e para o card
    const conv = it.conversa || null;
    const facts = [];
    if (conv && conv.solicitante) facts.push(["Quem pediu", `${conv.solicitante.nome}${conv.solicitante.quando ? ` · ${conv.solicitante.quando}` : ""}`]);
    else if (it.quem_pediu && it.quem_pediu.email) facts.push(["Quem pediu", it.quem_pediu.nome || it.quem_pediu.email]);
    if (it.prazo) facts.push(["Prazo", ddmm(it.prazo)]);
    const ans = answerFact(it);
    if (ans) facts.push(ans);
    if (conv && conv.ultimo && conv.status !== "respondido") facts.push(["Último a escrever", conv.rotulo_ultimo]);
    facts.push(["Depende de outros", it.depende_de_outros ? "sim" : "não"]);
    if (it.delegado && it.delegado.para) facts.push(["Delegado para", it.delegado.para]);
    const opts = it.opcoes || [];
    const ballLabel = it.bola.com === "leo" ? "próximo passo com você" : it.bola.com === "outros" ? `aguardando ${it.bola.nome || it.bola.email || "outra pessoa"}` : "ninguém precisa agir";
    const desk = layout() !== "mobile";
    const page = layout() === "kanban"; // desktop kanban: detalhe em página inteira (/copilot/{id})
    const side = desk && WIDE.matches; // 2 colunas: camada 2 vai para a lateral
    const showTasks = prefs.show_tasks_card !== false && it.tarefas && it.tarefas.length;
    const showFacts = prefs.show_facts_card !== false;
    const urgTip = { alta: "Urgência alta", media: "Urgência média", baixa: "Urgência baixa" }[it.urgencia] || "";
    const papel = PAPEL[it.papel] || it.papel;
    const layer1 = `<div class="cp-block cp-l1"><div class="cp-lbl"><i>1</i>Seu papel</div>
        <div class="cp-rchips">
          <span class="cp-rchip p-${esc(it.papel)}" tabindex="0" title="${esc(`${papel}: ${PAPEL_HINT[it.papel] || ""}`)}" aria-label="${esc(`Seu papel: ${papel}. ${PAPEL_HINT[it.papel] || ""}`)}">${ic(ROLE_ICON[it.papel] || "role-fyi", { size: 18 })}<span class="cp-rchip-t">${esc(papel)}</span><span class="cp-icon-tip"><b>${esc(papel)}</b> ${esc(PAPEL_HINT[it.papel] || "")}</span></span>
          ${urgTip ? `<span class="cp-rchip u-${it.urgencia}" tabindex="0" title="${urgTip}" aria-label="${urgTip}">${ic(`urg-${it.urgencia}`, { size: 18 })}<span class="cp-rchip-t">${esc(URG[it.urgencia])}</span><span class="cp-icon-tip">${urgTip}</span></span>` : ""}
          ${it.prazo ? `<span class="cp-rchip soft" tabindex="0" title="Prazo ${ddmm(it.prazo)}">${ic("calendar", { size: 18 })}<span class="cp-rchip-t cp-rchip-keep">${ddmm(it.prazo)}</span><span class="cp-icon-tip">Prazo ${ddmm(it.prazo)}</span></span>` : ""}
        </div>
        ${desk ? "" : `<p class="cp-from cp-l1-hint">${esc(PAPEL_HINT[it.papel] || "")}</p>`}</div>`;
    const layer2 = `<div class="cp-block cp-l2"><div class="cp-lbl"><i>2</i>O que aconteceu
          <span class="cp-layer-tools">
            <button type="button" class="cp-icon cp-mini" id="cp-summary-tog" title="Ver resumo" aria-label="Ver resumo" aria-expanded="${summaryOpen}">${ICO.summary}</button>
            ${msgs.length ? `<button type="button" class="cp-icon cp-mini" id="cp-thread-go" title="Ir para a conversa completa (${msgs.length})" aria-label="Ir para a conversa completa (${msgs.length})">${ICO.thread}<span class="cp-badge">${msgs.length}</span></button>` : ""}
          </span></div>
        <div id="cp-summary" class="${summaryOpen ? "" : "hidden"}"><p class="cp-big">${esc(it.o_que_aconteceu || "—")}</p>
        ${!it.analisado && !it.lido_por_regra ? `<p class="cp-from">${reading ? "Resumo provisório: a IA está lendo…" : "Resumo provisório, pela regra."}</p>` : ""}</div></div>`;
    const head = headLine(it, ballLabel);
    const cobrarOk = it.bola.com === "outros" || !!(it.delegado && it.delegado.para);
    box.innerHTML = `<div class="cp-dbody">
      <div class="cp-dtop"><button type="button" class="cp-icon cp-back${page ? " cp-back-page" : ""}" id="cp-back" aria-label="${page ? "Voltar ao quadro" : layout() === "lista" ? "Fechar" : "Voltar à lista"}">${page ? `${ICO.back}<span>Copiloto</span>` : "←"}</button>
        <h2>${esc(it.subject)}</h2>${ballAvatarHTML(it, true)}</div>
      <div class="cp-from cp-headline">${head}${it.desatualizado ? " · chegou mensagem nova" : ""}${it.pendente ? ` · <b class="cp-d-queue">${it.falhou && !reading ? "leitura falhou: ainda fora das colunas" : "analisando: entra numa coluna quando a IA terminar"}</b>` : ""}</div>
      <div class="cp-dgrid"><div class="cp-dmain">
      ${layer1}
      ${side ? "" : layer2}
      <div class="cp-block cp-block-h"><div class="cp-sec">${secHead("O que eu faria", opts.length, "Sugestões com evidência. Nada é enviado: Aplicar só prepara.", "lilac", "h3")}</div>
        <div class="cp-sec-body">
        ${opts.length ? opts.map((op, i) => optionHTML(it, op, i)).join("") : ""}
        ${it.needs_context ? `<div class="cp-opt cp-need"><strong>Preciso de contexto</strong><p>${esc(it.o_que_falta)}</p>${it.pergunta ? `<p><b>${esc(it.pergunta)}</b></p>` : ""}<div class="cp-opt-more">${resumoHTML(it)}</div></div>` : ""}
        ${!opts.length && !it.needs_context ? resumoHTML(it) : ""}
        ${!opts.length && !it.needs_context ? `<p class="cp-from${reading ? " cp-reading" : ""}">${
          reading ? "Lendo o e-mail e procurando base no cérebro…"
          : it.analisado || it.lido_por_regra ? "Nada a sugerir: não pede ação sua."
          : data.llm ? "A leitura da IA falhou; peça de novo." : "Sem chave de IA: só a leitura por regra."}</p>` : ""}
        <div class="cp-row">
          <button type="button" class="cp-btn cp-icon-act" id="cp-reread" title="${reading ? "Lendo…" : it.analisado ? "Ler de novo" : "Pedir leitura da IA"}" aria-label="${reading ? "Lendo…" : it.analisado ? "Ler de novo" : "Pedir leitura da IA"}" ${readingNow.has(it.thread_id) ? "disabled" : ""}>${ICO.spark}<span class="cp-icon-tip">${reading ? "Lendo…" : it.analisado ? "Ler de novo" : "Pedir leitura da IA"}</span></button>
          <a class="cp-btn cp-icon-act" href="/mail/${encodeURIComponent(it.thread_id)}" style="text-decoration:none" title="Abrir e-mail" aria-label="Abrir e-mail">${ICO.mail}<span class="cp-icon-tip">Abrir e-mail</span></a>
          <a class="cp-btn cp-icon-act" href="${esc(gmailThreadUrl(it.thread_id))}" target="_blank" rel="noopener" style="text-decoration:none" title="Abrir no Gmail" aria-label="Abrir no Gmail">${ICO.gmail}<span class="cp-icon-tip">Abrir no Gmail</span></a>
        </div></div></div>
      ${outboxHTML(it)}
      ${replyHTML(it)}
      ${msgs.length ? `<div class="cp-block cp-block-h" id="cp-thread-block">
        <div class="cp-sec cp-sec-tog" id="cp-thread-tog" role="button" tabindex="0" aria-expanded="${threadOpen}" aria-controls="cp-thread">${secHead("Conversa completa", msgs.length, threadOpen ? "Clique numa mensagem para abrir ou recolher." : "Mostrar a thread inteira", "sky", "h3")}</div>
        <div class="cp-thread${threadOpen ? "" : " hidden"}" id="cp-thread">${msgs.map((m, i) => messageHTML(m, i, msgs.length)).join("")}</div></div>` : ""}
      </div><div class="cp-dside">
      ${side ? layer2 : ""}
      ${showTasks ? `<div class="cp-block"><div class="cp-lbl">Tarefas</div><ul class="cp-tasks">${it.tarefas
        .map((t, i) => `<li class="${t.feita ? "done" : ""}"><input type="checkbox" data-task="${i}" ${t.feita ? "checked" : ""} aria-label="Concluir"><span>${esc(t.texto)}</span></li>`)
        .join("")}</ul></div>` : ""}
      ${showFacts ? `<div class="cp-block cp-facts-card"><dl class="cp-facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl></div>` : ""}
      ${it.historico && it.historico.length ? `<div class="cp-block"><div class="cp-lbl">Histórico</div><ul class="cp-hist">${it.historico
        .map((h) => `<li>${new Date(h.at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} · ${esc(h.acao)}${h.para ? ` → ${esc(h.para)}` : ""}</li>`)
        .join("")}</ul></div>` : ""}
      </div></div>
      <div class="cp-actions">
        ${iconBtn("responder", "Responder", ICO.reply)}
        ${iconBtn("acompanhar", "Acompanhar", ICO.eye)}
        ${cobrarOk ? iconBtn("cobrar", "Cobrar", ICO.bell, "", "Cobrar (prepara um rascunho, nada é enviado)") : iconBtn("cobrar", "Cobrar", ICO.bellOff, "", `Cobrar indisponível: ${cobrarOffReason(it)}`, true)}
        ${iconBtn("delegar", "Delegar", ICO.share, "", "Delegar (passar para outra pessoa)")}
        ${iconBtn("aprender", "Aprender", ICO.learn)}
        ${it.status === "resolvido"
          ? iconBtn("reabrir", "Reabrir", ICO.reopen)
          : iconBtn("resolver", "Resolvido", ICO.done, "", "Resolvido (marca como lido no Gmail)")}
      </div></div>`;
    box.classList.add("open");
    document.body.classList.toggle("cp-page", page);
    $("cp-scrim").classList.remove("open");
    hydrateAvatars(box);
    $("cp-back").onclick = closeDetail;
    $("cp-reread").onclick = () => readNow(it.thread_id, true);
    const sumTog = $("cp-summary-tog");
    if (sumTog) sumTog.onclick = () => {
      summaryOpen = !summaryOpen;
      $("cp-summary").classList.toggle("hidden", !summaryOpen);
      sumTog.setAttribute("aria-expanded", summaryOpen);
    };
    const tog = $("cp-thread-tog");
    const flipThread = (show) => {
      threadOpen = show === undefined ? !threadOpen : show;
      $("cp-thread").classList.toggle("hidden", !threadOpen);
      tog.setAttribute("aria-expanded", threadOpen);
      tog.querySelector("p").textContent = threadOpen ? "Clique numa mensagem para abrir ou recolher." : "Mostrar a thread inteira";
    };
    if (tog) {
      tog.onclick = () => flipThread();
      tog.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flipThread(); } };
      bindThread($("cp-thread"));
    }
    const go = $("cp-thread-go");
    if (go) go.onclick = () => { flipThread(true); $("cp-thread-block").scrollIntoView({ behavior: "smooth", block: "start" }); };
    box.querySelectorAll("[data-apply]").forEach((b) => (b.onclick = () => apply(it, Number(b.dataset.apply))));
    box.querySelectorAll("[data-task]").forEach((c) => (c.onchange = () => act(it, "tarefa", { index: Number(c.dataset.task), feita: c.checked })));
    box.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => (
      b.getAttribute("aria-disabled") === "true" ? toast(b.getAttribute("aria-label"))
      : b.dataset.act === "delegar" ? openDelegate(it)
        : b.dataset.act === "responder" ? openReply(it)
          : b.dataset.act === "aprender" ? openLearn(it)
            : act(it, b.dataset.act))));
    bindReply(it);
    box.querySelectorAll("[data-outbox-cancel]").forEach((b) => (b.onclick = async () => {
      if (!window.confirm("Cancelar este envio? O texto não será enviado.")) return;
      b.disabled = true;
      const r = await api(`/api/outbox/${encodeURIComponent(b.dataset.outboxCancel)}/cancel`, "POST");
      toast(r.ok ? "Envio cancelado." : r.data.detail || "Não deu para cancelar.");
      if (window.NetStatus) window.NetStatus.refresh();
      open(it.thread_id, true);
    }));
    annot.reapply(); // o innerHTML apagou as marcas dos trechos citados
    if (caret && $(caret[0])) {
      const ta = $(caret[0]);
      ta.focus(); ta.setSelectionRange(caret[1], caret[2]); ta.scrollTop = caret[3];
    }
  }

  // ── responder: rascunho da IA (o mesmo do /mail) + envio com confirmação ──
  function syncReply(it) {
    const draft = it.draft || "";
    if (!reply || reply.tid !== it.thread_id) {
      reply = { tid: it.thread_id, open: false, text: draft, aiText: draft, instr: "", extraCc: [], all: true, recipients: null, busy: false, status: "",
        chat: Array.isArray(it.chat) ? it.chat.slice() : [], pending: "", chatOpen: true };
    } else if (!reply.busy && draft && draft !== reply.aiText && reply.text === reply.aiText) {
      // rascunho novo no servidor (Aplicar, /mail) e o texto não foi editado aqui
      reply.text = draft; reply.aiText = draft;
    }
    // conversa com a IA mais nova no servidor (gerada no /mail, Aplicar…)
    if (!reply.busy && Array.isArray(it.chat) && it.chat.length > reply.chat.length) reply.chat = it.chat.slice();
  }
  const lower = (e) => String(e || "").trim().toLowerCase();
  function replyTo(it) {
    if (lower(it.from_email) !== me) return it.from_email || "";
    const other = ((reply.recipients && reply.recipients.to) || []).find((a) => lower(a.email) !== me);
    return (other && other.email) || it.from_email || "";
  }
  // Mesma sugestão do "responder a todos" do /mail: quem mais estava em Para/Cc
  // na última mensagem, menos você e quem já vai no Para.
  function replyCc(it) {
    const seen = new Set([me, lower(replyTo(it))]);
    const out = [];
    const r = reply.recipients || { to: [], cc: [] };
    const all = reply.all ? [...(r.to || []), ...(r.cc || [])].map((a) => a.email) : [];
    [...all, ...reply.extraCc].forEach((e) => {
      const email = lower(e);
      if (email && !seen.has(email)) { seen.add(email); out.push(email); }
    });
    return out.join(", ");
  }
  // Respostas desta thread já confirmadas que ainda não saíram (sem conexão).
  function outboxHTML(it) {
    const q = (it.outbox || []).filter((o) => o.status === "queued" || o.status === "sending" || o.status === "failed");
    if (!q.length) return "";
    return `<div class="cp-block cp-outbox">${q.map((o) => `<p class="cp-warn queued"><b>${o.status === "failed" ? "Envio não saiu" : o.status === "sending" ? "Enviando…" : "Na fila de envio"}</b>
      · confirmado ${esc(new Date(o.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }))}
      ${o.status === "failed" && o.last_error ? `<br><small>${esc(o.last_error.slice(0, 180))}</small>` : o.status === "queued" ? "<br><small>Sai sozinho quando a conexão com o Gmail voltar.</small>" : ""}
      ${o.status !== "sending" ? `<button type="button" class="cp-btn" data-outbox-cancel="${esc(o.id)}">Cancelar envio</button>` : ""}</p>`).join("")}</div>`;
  }
  function replyHTML(it) {
    if (!reply || !reply.open) return "";
    const cc = replyCc(it);
    const edited = reply.text.trim() && reply.text !== reply.aiText;
    const sendTip = canSend ? "Enviar (pede confirmação)" : "Reautorize o Gmail (Entrar no Gmail) para poder enviar.";
    const nChat = (reply.chat || []).filter((m) => !m.placeholder && !m.typing).length;
    return `<div class="cp-block cp-block-h cp-reply" id="cp-reply">
      <div class="cp-sec">${secHead("Responder", null, "Rascunho da IA, o mesmo do /mail. Edite à vontade: nada sai sem você confirmar.", "mint", "h3")}</div>
      <div class="cp-sec-body cmp">
        <div class="cp-seg cp-rmode" role="group" aria-label="Destinatários">
          <button type="button" data-rmode="one" class="${reply.all ? "" : "on"}">Responder</button>
          <button type="button" data-rmode="all" class="${reply.all ? "on" : ""}">Responder a todos</button>
        </div>
        <p class="cmp-rcpt cp-rcpt"><b>Para:</b> ${esc(replyTo(it) || "?")}${cc ? `<br><b>Cc:</b> ${esc(cc)}` : reply.recipients ? " · sem cópia" : " · carregando cópias…"}</p>
        <details class="cmp-chat" id="cp-chat-box" ${reply.chatOpen ? "open" : ""}>
          <summary>${ic("chat", { size: 15 })}Conversa com a IA <b>${nChat}</b></summary>
          <div id="cp-chat" class="chat-messages"></div>
        </details>
        <textarea id="cp-reply-text" class="cmp-draft cp-reply-text" rows="9" placeholder="${reply.busy ? "A IA está escrevendo…" : "Escreva a resposta ou peça um rascunho à IA."}" ${reply.busy ? "disabled" : ""}>${esc(reply.text)}</textarea>
        <p class="cmp-status" id="cp-reply-status" role="status">${esc(reply.busy ? "Gerando rascunho…" : reply.status || (edited ? "Editado por você." : reply.text ? "Sugestão da IA." : ""))}</p>
        <div class="cmp-instr">
          <label for="cp-reply-instr">Ideia principal / instrução para a IA</label>
          <div class="cmp-annots" id="cp-annots">${annotsHTML()}</div>
          <div class="cmp-instr-row">
            <textarea id="cp-reply-instr" rows="1" placeholder="Diga o que quer responder ou pergunte algo à IA…" ${reply.busy ? "disabled" : ""}>${esc(reply.instr)}</textarea>
            <button type="button" class="cmp-gen" id="cp-reply-gen" title="${reply.text.trim() ? "Ajustar o rascunho com a instrução" : "Gerar o rascunho com a instrução"}" ${genReady() ? "" : "disabled"}>${ic("sparkles", { size: 16 })}<span>${reply.text.trim() ? "Ajustar" : "Gerar"}</span></button>
          </div>
        </div>
        <p class="cmp-hint">Enter gera · Shift+Enter quebra linha · selecione um trecho do e-mail ou do rascunho para citar · perguntas viram resposta na conversa.</p>
        <div class="cmp-tools">
          <button type="button" class="cmp-tool" id="cp-reply-regen" title="Regenerar (sem instrução)" aria-label="Regenerar" ${reply.busy ? "disabled" : ""}>${ic("refresh", { size: 18 })}</button>
          <button type="button" class="cmp-tool" id="cp-reply-learn" title="Aprender" aria-label="Aprender">${ic("learn", { size: 18 })}</button>
          <button type="button" class="cmp-tool" id="cp-chat-reset" title="Limpar a conversa com a IA e o rascunho" aria-label="Limpar conversa" ${reply.busy || (!nChat && !reply.text.trim()) ? "disabled" : ""}>${ic("trash", { size: 18 })}</button>
          <a class="cmp-tool" href="/mail/${encodeURIComponent(it.thread_id)}" title="Abrir no /mail (anexos, exportar contexto)" aria-label="Abrir no /mail">${ic("mail", { size: 18 })}</a>
          <div class="cmp-sendwrap">
            <button type="button" class="cmp-send cp-reply-send" id="cp-reply-send" title="${esc(sendTip)}" ${canSend && reply.text.trim() && !reply.busy ? "" : "disabled"}>${ic("send", { size: 17 })}<span>Enviar…</span></button>
          </div>
        </div>
      </div></div>`;
  }
  // Conversa com a IA (ChatUI, static/chat.js -- o mesmo do /mail): instruções
  // + respostas (kind=answer) e rascunhos (kind=draft, resumidos; o texto
  // inteiro está na caixa). Enquanto gera: a instrução + bolha "escrevendo".
  function renderChatBox(it) {
    const el = $("cp-chat");
    if (!el || !window.ChatUI) return;
    const hist = reply.busy
      ? reply.chat.concat(reply.pending ? [{ role: "user", text: reply.pending }] : [], [{ role: "ai", typing: true, text: "" }])
      : reply.chat;
    window.ChatUI.render(el, hist, {
      compactDrafts: true,
      empty: "Peça um rascunho ou pergunte algo sobre o e-mail: a conversa aparece aqui.",
      onCcPick: (_m, _c, email) => { if (email && !reply.extraCc.includes(email)) { reply.extraCc.push(email); renderDetail(shown); } },
      onUseDraft: (text) => { reply.text = text; reply.aiText = text; reply.status = "Versão anterior do rascunho na caixa."; renderDetail(shown); },
    });
  }
  function bindReply(it) {
    if (!reply || !reply.open || !$("cp-reply")) return;
    const ta = $("cp-reply-text");
    ta.oninput = () => {
      reply.text = ta.value; reply.status = "";
      $("cp-reply-send").disabled = !(canSend && reply.text.trim());
      $("cp-reply-status").textContent = reply.text.trim() && reply.text !== reply.aiText ? "Editado por você." : "";
    };
    $("cp-reply").querySelectorAll("[data-rmode]").forEach((b) => (b.onclick = () => { reply.all = b.dataset.rmode === "all"; renderDetail(it); }));
    renderChatBox(it);
    $("cp-chat-box").ontoggle = () => { reply.chatOpen = $("cp-chat-box").open; };
    $("cp-chat-reset").onclick = async () => {
      if (!window.confirm("Limpar a conversa com a IA e o rascunho desta thread (também no /mail)?")) return;
      const r = await api(`/api/threads/${encodeURIComponent(it.thread_id)}/chat/reset`, "POST");
      if (!r.ok) { toast(r.data.detail || "Não deu para limpar."); return; }
      reply.chat = []; reply.text = ""; reply.aiText = ""; reply.status = "Conversa limpa."; shown.draft = ""; shown.chat = [];
      annot.clear();
      renderDetail(shown);
    };
    $("cp-reply-regen").onclick = () => regenerate(it);
    $("cp-reply-send").onclick = () => confirmSend(it);
    $("cp-reply-learn").onclick = () => openLearn(it);
    // instrução: cresce com o texto; Enter gera, Shift+Enter quebra linha (igual ao /mail)
    const instr = $("cp-reply-instr");
    const fit = () => { instr.style.height = "auto"; instr.style.height = `${Math.min(instr.scrollHeight, 200)}px`; };
    fit();
    instr.oninput = () => { reply.instr = instr.value; fit(); $("cp-reply-gen").disabled = !genReady(); };
    instr.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (genReady()) generate(it, true); }
    };
    $("cp-reply-gen").onclick = () => generate(it, true);
  }
  // Chips numerados das citações: trecho curto + comentário; clicar edita, × remove
  // (os cliques são tratados no annotate.js via data-annot-open / data-annot-rm).
  // (mesmo desenho do /mail: Composer.annotChipsHTML em static/composer.js)
  const annotsHTML = () => window.Composer.annotChipsHTML(annot.list());
  function renderAnnots() {
    const box = $("cp-annots");
    if (box) box.innerHTML = annotsHTML();
    const gen = $("cp-reply-gen");
    if (gen) gen.disabled = !genReady();
  }
  const genReady = () => !!reply && !reply.busy && !!(reply.instr.trim() || annot.count());
  async function loadRecipients(it) {
    if (reply.recipients) return;
    const r = await api(`/api/threads/${encodeURIComponent(it.thread_id)}/recipients`);
    if (!reply || reply.tid !== it.thread_id) return;
    reply.recipients = r.ok ? { to: r.data.to || [], cc: r.data.cc || [] } : { to: [], cc: [] };
    if (shown && shown.thread_id === it.thread_id) renderDetail(shown);
  }
  // opts.text: rascunho que a ação acabou de preparar (Aplicar / Cobrar);
  // sem ele, usa o rascunho salvo e só gera se não houver nenhum.
  function openReply(it, opts) {
    opts = opts || {};
    syncReply(it);
    reply.open = true;
    if (opts.text) { reply.text = opts.text; reply.aiText = opts.text; reply.status = opts.status || ""; }
    if (opts.cc) reply.extraCc = opts.cc;
    renderDetail(shown && shown.thread_id === it.thread_id ? shown : it);
    loadRecipients(it);
    const box = $("cp-reply");
    if (box && !opts.noScroll) box.scrollIntoView({ behavior: "smooth", block: "start" });
    if (!reply.text.trim() && !opts.noGenerate) regenerate(it);
    else if ($("cp-reply-text")) $("cp-reply-text").focus({ preventScroll: true });
  }
  const regenerate = (it) => generate(it, false);
  // withInstruction=false: Regenerar (sem instrução). true: Gerar/Ajustar com a
  // ideia principal + citações numeradas (Annotate.compose, o mesmo texto do /mail).
  async function generate(it, withInstruction) {
    if (reply.busy) return;
    const instruction = withInstruction ? window.Annotate.compose(reply.instr, annot.list()) : "";
    if (withInstruction && !instruction) return;
    const edited = reply.text.trim() && reply.text !== reply.aiText;
    const ask = withInstruction
      ? "A IA vai reescrever a partir do texto que você editou. Trocar o texto da caixa pelo resultado?"
      : "Trocar o texto que você editou por um rascunho novo da IA?";
    if (edited && !window.confirm(ask)) return;
    const tid = it.thread_id;
    reply.busy = true; reply.status = "";
    reply.pending = withInstruction ? (reply.instr.trim() || `${annot.count()} citação(ões)`) : "";
    renderDetail(shown);
    // mesma geração do /mail (assistant.draft): o rascunho fica salvo na thread.
    // Com instrução, o texto atual da caixa vai como "Rascunho anterior".
    const body = { instruction, comment: "" };
    if (instruction && reply.text.trim()) body.current_draft = reply.text;
    const r = await api(`/api/threads/${encodeURIComponent(tid)}/draft`, "POST", body);
    if (!reply || reply.tid !== tid) return;
    reply.busy = false; reply.pending = "";
    if (r.ok && Array.isArray(r.data.chat)) { reply.chat = r.data.chat.slice(); shown.chat = reply.chat; }
    const last = r.ok ? (r.data.chat || []).slice(-1)[0] : null;
    if (!r.ok) reply.status = r.data.detail || "Falha no rascunho.";
    // pergunta pra IA (kind=answer): a resposta aparece na conversa, o rascunho fica
    else if (last && last.kind === "answer") { reply.chatOpen = true; reply.status = "A IA respondeu na conversa acima; o rascunho da caixa continua o mesmo."; }
    else if (r.data.draft) { reply.text = r.data.draft; reply.aiText = r.data.draft; shown.draft = r.data.draft; }
    else reply.status = (last && last.text) || "A IA não devolveu rascunho.";
    if (r.ok && withInstruction) { reply.instr = ""; annot.clear(); }
    if (shown && shown.thread_id === tid) renderDetail(shown);
  }
  // Mesma confirmação do /mail: Para, Cc editável, assunto, prévia, aviso de
  // anexo esquecido e "ação definitiva". Só envia no clique de "Enviar agora".
  async function confirmSend(it) {
    const text = reply.text.trim();
    if (!text) return;
    if (!canSend) { toast("Reautorize o Gmail (Entrar no Gmail) para poder enviar."); return; }
    const tid = it.thread_id;
    const att = await api(`/api/threads/${encodeURIComponent(tid)}/attachments`);
    const nFiles = att.ok ? (att.data.files || []).length : 0;
    const mentions = /anex/i.test(text) && nFiles === 0;
    const subject = it.subject || "(sem assunto)";
    const offline = !!(window.NetStatus && window.NetStatus.isOffline());
    sheet(`<h3>Enviar e-mail?</h3>
      <p class="cp-mrow"><b>Para:</b> ${esc(replyTo(it) || "?")}</p>
      <label class="cp-field"><span>Cc</span><input id="sd-cc" type="text" value="${esc(replyCc(it))}" placeholder="opcional, e-mails separados por vírgula" autocomplete="off"></label>
      <p class="cp-mrow"><b>Assunto:</b> ${esc(/^re:/i.test(subject) ? subject : `Re: ${subject}`)}</p>
      <div class="cp-pre">${esc(text)}</div>
      ${nFiles ? `<p class="cp-from">${nFiles} anexo(s) preparado(s) no /mail vão junto.</p>` : ""}
      ${mentions ? '<p class="cp-warn attach">⚠️ O texto menciona anexo, mas nenhum arquivo foi anexado a essa resposta.</p>' : ""}
      ${offline ? `<p class="cp-warn queued">${esc(window.NetStatus.message(window.NetStatus.state.status === "auth_error" ? "auth_error" : "offline"))}</p>` : ""}
      <p class="cp-warn">${offline ? "Ao confirmar, a resposta vai para a fila de envio e sai sozinha quando a conexão voltar (você pode cancelar até lá)." : "Essa ação é definitiva — o e-mail sai imediatamente e não pode ser desfeito."}</p>
      <div class="cp-row"><button type="button" class="cp-btn" data-close>Cancelar</button>
        <button type="button" class="cp-btn primary" id="sd-go">${offline ? "Pôr na fila de envio" : "Enviar agora"}</button></div>`);
    $("sd-go").onclick = async () => {
      if (mentions && !window.confirm("O texto menciona anexo, mas nenhum arquivo foi anexado a essa resposta. Enviar mesmo assim?")) return;
      const go = $("sd-go");
      go.disabled = true; go.textContent = "Enviando…";
      const r = await api(`/api/threads/${encodeURIComponent(tid)}/send`, "POST", { text, cc: $("sd-cc").value.trim(), source: "copilot" });
      closeSheet();
      if (!r.ok) { toast(r.data.detail || "Falha ao enviar."); return; }
      // sem conexão: o servidor guardou na fila de envio (202 queued)
      if (r.data.queued) toast(`Na fila de envio. ${r.data.message || "Sai quando a conexão voltar."}`);
      else toast(r.data.cc ? `Enviado para ${r.data.to} (Cc: ${r.data.cc}).` : `Enviado para ${r.data.to}.`);
      if (window.NetStatus) window.NetStatus.refresh();
      if (reply && reply.tid === tid) { reply = null; annot.clear(); }
      if (current === tid) open(tid, true);
      load();
    };
  }
  // Leitura da IA de um item só (abrir o detalhe ou "Ler de novo").
  async function readNow(id, force) {
    // force=true (botão Pedir leitura / Ler de novo): reentra mesmo se já
    // estiver na fila do lote — antes o early-return fazia o clique "não fazer nada".
    if (!force && readingNow.has(id)) return;
    readingNow.add(id);
    if (shown && shown.thread_id === id) renderDetail(shown);
    renderList();
    try {
      const r = await api(`/api/copilot/${encodeURIComponent(id)}?refresh=1`, "GET", undefined, 120000);
      if (!r.ok) toast(r.data.detail || "Falha na leitura.");
      else if (force) toast(r.data.analisado ? "Leitura da IA atualizada." : "Leitura concluída.");
      if (current === id) renderDetail(r.ok ? r.data : shown);
      load();
    } finally {
      readingNow.delete(id);
      if (current === id && shown && shown.thread_id === id) renderDetail(shown);
      renderList();
    }
  }
  async function open(id, quiet) {
    current = id;
    if (!quiet) renderList();
    const r = await api(`/api/copilot/${encodeURIComponent(id)}`);
    if (!r.ok) { toast(r.data.detail || "Falha ao abrir."); return; }
    if (current !== id) return; // outro cartão foi aberto enquanto carregava
    renderDetail(r.data);
    if (!quiet) {
      // celular: #id (voltar do aparelho fecha). Desktop: /copilot/{id}, deep link
      // e Voltar do navegador. Outro cartão com um já aberto (lista) só troca a URL.
      if (layout() === "mobile") { if (!location.hash && !pathId()) history.pushState({ cp: id }, "", `#${id}`); }
      else if (pathId() !== id) {
        const url = `/copilot/${encodeURIComponent(id)}`;
        if (pathId()) history.replaceState({ cp: id }, "", url);
        else { history.pushState({ cp: id }, "", url); pushedDetail = true; }
      }
    }
    // ainda sem leitura da IA: lê agora (se o lote já não estiver nele)
    const job = data.job || {};
    if (needsAI(r.data) && !(job.running && job.current_id === id)) readNow(id);
  }
  // /copilot/{id}: detalhe em página inteira no desktop (deep link)
  function pathId() {
    const m = location.pathname.match(/^\/copilot\/([^/]+)\/?$/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  let pushedDetail = false; // abrimos o detalhe com pushState (Voltar = history.back)
  function hideDetail() {
    $("cp-detail").classList.remove("open");
    $("cp-scrim").classList.remove("open");
    document.body.classList.remove("cp-page");
    if (layout() === "kanban" || mode !== "quadro") { current = null; renderList(); }
  }
  function closeDetail() {
    hideDetail();
    if (location.hash) { history.back(); return; }
    if (pathId()) {
      if (pushedDetail) history.back();
      else history.replaceState({}, "", "/copilot"); // veio por deep link: fica no quadro
    }
    pushedDetail = false;
  }
  window.addEventListener("popstate", () => {
    const id = pathId();
    if (layout() !== "mobile" && id) { if (id !== current || !$("cp-detail").classList.contains("open")) open(id, true); return; }
    if (layout() === "mobile" && (location.hash || id)) return;
    pushedDetail = false;
    hideDetail();
  });
  $("cp-scrim").onclick = closeDetail;

  // ── ações ──
  function afterDraft(res, verb, it) {
    // rascunho na própria conversa: abre o composer do detalhe já preenchido
    if (it && res.open_url && res.open_url.startsWith("/mail/")) {
      const cc = new URLSearchParams(res.open_url.split("?")[1] || "").get("cc") || "";
      openReply(it, { text: res.draft || "", cc: cc.split(",").map((e) => e.trim()).filter(Boolean), noGenerate: true,
        status: `${verb} preparado pela IA. Nada foi enviado: revise e envie daqui.` });
      return;
    }
    if (res.open_url) {
      sheet(`<h3>${esc(verb)} preparado</h3><p class="cp-from">Nada foi enviado. Revise e envie pela tela do e-mail.</p>
        ${res.draft ? `<div class="cp-pre">${esc(res.draft)}</div>` : ""}
        <div class="cp-row"><a class="cp-btn primary" style="text-decoration:none" href="${esc(res.open_url)}">Abrir rascunho</a>
        <button type="button" class="cp-btn" data-close>Depois</button></div>`);
    } else toast(`${verb}: feito.`);
  }
  async function act(it, action, extra) {
    const r = await api(`/api/copilot/${encodeURIComponent(it.thread_id)}/action`, "POST", { action, ...(extra || {}) });
    if (!r.ok) { toast(r.data.detail || "Não deu certo."); return null; }
    // Resolvido = lido no Gmail: sai do quadro de não lidos e o detalhe fecha.
    if (action === "resolver") closeDetail();
    else renderDetail(r.data.item);
    load();
    if (action === "cobrar") afterDraft(r.data, "Cobrança", r.data.item);
    else if (action !== "tarefa") toast({ assumir: "Você acompanha.", acompanhar: "Você acompanha.", resolver: "Resolvido e marcado como lido — está em Resolvidos.", reabrir: "Reaberto." }[action] || "Pronto.");
    return r.data;
  }
  async function apply(it, idx) {
    const op = it.opcoes[idx];
    if (op.acao === "direcionar" && !op.para) { openDelegate(it); return; }
    toast("Preparando…");
    const r = await api(`/api/copilot/${encodeURIComponent(it.thread_id)}/action`, "POST", { action: "aplicar", opcao: idx });
    if (!r.ok) { toast(r.data.detail || "Não deu certo."); return; }
    renderDetail(r.data.item);
    load();
    afterDraft(r.data, op.acao === "direcionar" ? "Delegação" : op.acao === "pedir_contexto" ? "Pedido de contexto" : "Rascunho", r.data.item);
  }

  // ── delegar: Cc dos originários OU e-mail novo silencioso ──
  function openDelegate(it) {
    const orig = (it.originarios || []).map((a) => a.email).join(", ") || "ninguém";
    sheet(`<h3>Delegar</h3>
      <label class="cp-field"><span>Para quem</span><input id="dg-to" type="email" placeholder="nome ou e-mail" autocomplete="off"><ul id="dg-sug" class="cp-suggest hidden"></ul></label>
      <label class="cp-radio"><input type="radio" name="dg-mode" value="cc_originais" checked><span>Às claras, na própria conversa<small>Rascunho na thread com Cc de quem já está nela (${esc(orig)}).</small></span></label>
      <label class="cp-radio"><input type="radio" name="dg-mode" value="novo_silencioso"><span>E-mail novo, silencioso<small>Só para a pessoa, sem copiar ninguém da conversa.</small></span></label>
      <label class="cp-field"><span>Recado (opcional)</span><textarea id="dg-note" rows="2"></textarea></label>
      <div class="cp-row"><button type="button" class="cp-btn primary" id="dg-go">Preparar rascunho</button><button type="button" class="cp-btn" data-close>Cancelar</button></div>
      <p class="cp-from" style="margin-top:10px">Nada é enviado: você revisa antes.</p>`);
    let chosenName = "";
    const input = $("dg-to");
    input.focus();
    input.oninput = async () => {
      chosenName = "";
      const q = input.value.trim();
      const list = $("dg-sug");
      if (q.length < 2 || q.includes("@")) { list.classList.add("hidden"); return; }
      const r = await api(`/api/settings/alias-suggest?q=${encodeURIComponent(q)}`);
      const sug = (r.ok && r.data.suggestions) || [];
      list.innerHTML = sug.map((s) => `<li data-email="${esc(s.email)}" data-name="${esc(s.name)}">${esc(s.name)} &lt;${esc(s.email)}&gt;</li>`).join("");
      list.classList.toggle("hidden", !sug.length);
      list.querySelectorAll("li").forEach((li) => (li.onclick = () => { input.value = li.dataset.email; chosenName = li.dataset.name; list.classList.add("hidden"); }));
    };
    $("dg-go").onclick = async () => {
      const modo = document.querySelector('input[name="dg-mode"]:checked').value;
      const r = await api(`/api/copilot/${encodeURIComponent(it.thread_id)}/action`, "POST", { action: "delegar", para: input.value.trim(), nome: chosenName, modo, nota: $("dg-note").value.trim() });
      if (!r.ok) { toast(r.data.detail || "Não deu certo."); return; }
      closeSheet();
      renderDetail(r.data.item);
      load();
      afterDraft(r.data, "Delegação", r.data.item);
    };
  }

  // ── aprender: regra/contexto para os PRÓXIMOS e-mails (não gera rascunho) ──
  const LEARN_SCOPE = { thread: "neste assunto", person: "pessoa", general: "geral" };
  function learnPerson(it) {
    const from = lower(it.from_email);
    if (from && from !== me) return from;
    return lower((it.quem_pediu && it.quem_pediu.email) || (it.bola && it.bola.com === "outros" && it.bola.email) || "");
  }
  async function loadLearned(it) {
    const box = $("ln-list");
    if (!box) return;
    const r = await api(`/api/learned?thread_id=${encodeURIComponent(it.thread_id)}`);
    if (!$("ln-list")) return;
    const notes = (r.ok && r.data.notes) || [];
    box.innerHTML = notes.length
      ? `<h4>Já vale para esta conversa</h4><ul>${notes
          .map((n) => `<li><span>${esc(n.text)}<small>${esc(LEARN_SCOPE[n.scope] || n.scope)}${n.scope === "person" ? ` · ${esc(n.person_email)}` : ""}</small></span>
            <button type="button" data-ln-rm="${n.id}" title="Remover" aria-label="Remover este aprendizado">×</button></li>`)
          .join("")}</ul>`
      : '<p class="cp-from">Nada aprendido ainda para esta conversa.</p>';
    box.querySelectorAll("[data-ln-rm]").forEach((b) => (b.onclick = async () => {
      const d = await api(`/api/learned/${b.dataset.lnRm}`, "DELETE");
      toast(d.ok ? "Aprendizado removido." : d.data.detail || "Não removeu.");
      loadLearned(it);
    }));
  }
  function openLearn(it) {
    const person = learnPerson(it);
    sheet(`<h3>Aprender</h3>
      <p class="cp-from">A IA guarda isto e usa nos próximos rascunhos e leituras. Não gera rascunho nem envia nada.</p>
      <label class="cp-field"><span>O que a IA deve saber/lembrar</span><textarea id="ln-text" rows="3" maxlength="1000" placeholder="Ex.: pix estático é com o time de Produto; com a Ana, respostas curtas."></textarea></label>
      <label class="cp-radio"><input type="radio" name="ln-scope" value="thread" checked><span>Esta conversa/assunto<small>${esc(it.subject || "(sem assunto)")} — e outras com o mesmo assunto.</small></span></label>
      ${person ? `<label class="cp-radio"><input type="radio" name="ln-scope" value="person"><span>Esta pessoa (${esc(person)})<small>Qualquer e-mail em que ela esteja.</small></span></label>` : ""}
      <label class="cp-radio"><input type="radio" name="ln-scope" value="general"><span>Geral<small>Vale para todos os e-mails.</small></span></label>
      <div class="cp-row"><button type="button" class="cp-btn primary" id="ln-go">Salvar</button><button type="button" class="cp-btn" data-close>Cancelar</button></div>
      <div id="ln-list" class="cp-learned"></div>`);
    $("ln-text").focus();
    loadLearned(it);
    $("ln-go").onclick = async () => {
      const text = $("ln-text").value.trim();
      if (!text) { $("ln-text").focus(); return; }
      const scope = document.querySelector('input[name="ln-scope"]:checked').value;
      const go = $("ln-go");
      go.disabled = true;
      const r = await api("/api/learned", "POST", { scope, text, thread_id: it.thread_id, person_email: scope === "person" ? person : "" });
      go.disabled = false;
      if (!r.ok) { toast(r.data.detail || "Não salvou."); return; }
      $("ln-text").value = "";
      toast(`Aprendido: vale para ${scope === "person" ? person : scope === "general" ? "todos os e-mails" : "esta conversa/assunto"}.`);
      loadLearned(it);
    };
  }

  // ── ajustes: skin, filtro de não lidos e horários do digest (por usuário) ──
  async function openPrefs() {
    const r = await api("/api/copilot/settings");
    const p = r.ok ? r.data : { skin: "clean", digest_daily: "08:00", digest_weekly_day: 0, digest_weekly_time: "08:30", digest_enabled: true, show_all: false };
    sheet(`<h3>Ajustes do copiloto</h3>
      <div class="cp-field"><span>Visual</span><div class="cp-seg"><button type="button" data-skin="clean" class="${p.skin === "clean" ? "on" : ""}">Clean pastel</button><button type="button" data-skin="caderno" class="${p.skin === "caderno" ? "on" : ""}">Caderno</button></div></div>
      <label class="cp-radio"><input type="checkbox" id="pf-all" ${p.show_all ? "checked" : ""}><span>Mostrar todos os e-mails<small>Desligado: o painel mostra só os não lidos (colunas, abas e contadores).</small></span></label>
      <label class="cp-radio"><input type="checkbox" id="pf-tasks" ${p.show_tasks_card !== false ? "checked" : ""}><span>Card "Tarefas" no detalhe<small>Lista de tarefas que a IA tirou do e-mail (coluna lateral).</small></span></label>
      <label class="cp-radio"><input type="checkbox" id="pf-facts" ${p.show_facts_card !== false ? "checked" : ""}><span>Card "Quem pediu / Resposta / Depende de outros"<small>Também em Configurações → Copiloto.</small></span></label>
      <label class="cp-field"><span>Resumo diário (manhã)</span><input id="pf-daily" type="time" value="${esc(p.digest_daily)}"></label>
      <label class="cp-field"><span>Resumo semanal</span><select id="pf-wday">${WEEK.map((d, i) => `<option value="${i}" ${i === Number(p.digest_weekly_day) ? "selected" : ""}>${d}</option>`).join("")}</select></label>
      <label class="cp-field"><span>Horário do semanal</span><input id="pf-wtime" type="time" value="${esc(p.digest_weekly_time)}"></label>
      <label class="cp-radio"><input type="checkbox" id="pf-on" ${p.digest_enabled ? "checked" : ""}><span>Gerar os resumos<small>Nesta versão o resumo só é montado; a entrega automática vem depois.</small></span></label>
      <div class="cp-row"><button type="button" class="cp-btn primary" id="pf-save">Salvar</button>
        <button type="button" class="cp-btn" id="pf-day">Ver resumo de hoje</button><button type="button" class="cp-btn" id="pf-week">Ver semanal</button></div>
      <div id="pf-out"></div>`);
    let skin = p.skin;
    document.querySelectorAll("#cp-sheet [data-skin]").forEach((b) => (b.onclick = () => {
      skin = b.dataset.skin; applySkin(skin);
      document.querySelectorAll("#cp-sheet [data-skin]").forEach((x) => x.classList.toggle("on", x === b));
    }));
    $("pf-save").onclick = async () => {
      const s = await api("/api/copilot/settings", "POST", { skin, digest_daily: $("pf-daily").value, digest_weekly_day: Number($("pf-wday").value), digest_weekly_time: $("pf-wtime").value, digest_enabled: $("pf-on").checked, show_all: $("pf-all").checked, show_tasks_card: $("pf-tasks").checked, show_facts_card: $("pf-facts").checked });
      toast(s.ok ? "Ajustes salvos." : s.data.detail || "Não salvou.");
      if (s.ok) { prefs = s.data; load(); if (shown && $("cp-detail").classList.contains("open")) renderDetail(shown); }
    };
    const preview = async (period) => {
      const d = await api(`/api/copilot/digest?period=${period}`);
      $("pf-out").innerHTML = d.ok ? `<p class="cp-from" style="margin-top:12px">Próximo: ${esc(d.data.agendamento)}</p><div class="cp-pre">${esc(d.data.texto)}</div>` : "";
    };
    $("pf-day").onclick = () => preview("daily");
    $("pf-week").onclick = () => preview("weekly");
  }
  function applySkin(skin) {
    document.body.dataset.skin = skin === "caderno" ? "caderno" : "clean";
    try { localStorage.setItem("cp_skin", document.body.dataset.skin); } catch { /* sem armazenamento */ }
  }
  $("cp-prefs-btn").onclick = openPrefs;
  // atalho no cabeçalho: alterna clean ↔ caderno e guarda no perfil
  $("cp-skin").onclick = async () => {
    const skin = document.body.dataset.skin === "caderno" ? "clean" : "caderno";
    applySkin(skin);
    const r = await api("/api/copilot/settings");
    if (r.ok) api("/api/copilot/settings", "POST", { ...r.data, skin });
  };

  // ── folha (bottom sheet no celular, modal no desktop) ──
  function sheet(html) {
    $("cp-sheet-body").innerHTML = html;
    $("cp-sheet").classList.remove("hidden");
    $("cp-sheet-body").querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeSheet));
  }
  function closeSheet() { $("cp-sheet").classList.add("hidden"); }
  $("cp-sheet-x").onclick = closeSheet;
  $("cp-sheet").onclick = (e) => { if (e.target === $("cp-sheet")) closeSheet(); };
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("cp-sheet").classList.contains("hidden")) closeSheet();
    else if (layout() === "kanban" && $("cp-detail").classList.contains("open") && !(e.target && /^(TEXTAREA|INPUT)$/.test(e.target.tagName))) closeDetail();
  });

  // ── eventos da lista ──
  $("cp-tabs").onclick = (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    tab = b.dataset.tab; sessionStorage.setItem("cp_tab", tab); renderList();
  };
  document.querySelectorAll(".cp-card").forEach((c) => (c.onclick = () => {
    if (mode !== "quadro") { setMode("quadro"); }
    if (layout() === "kanban") {
      const col = $("cp-board").querySelector(`[data-col="${c.dataset.tab}"]`);
      if (col) { col.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" }); col.classList.remove("flash"); void col.offsetWidth; col.classList.add("flash"); }
      return;
    }
    tab = c.dataset.tab; sessionStorage.setItem("cp_tab", tab); renderList();
  }));
  $("cp-views").onclick = (e) => { const b = e.target.closest("[data-mode]"); if (b) setMode(b.dataset.mode); };
  $("cp-hist").onclick = (e) => { const li = e.target.closest("[data-id]"); if (li) open(li.dataset.id); };
  $("cp-hist").onkeydown = (e) => { const li = e.target.closest("[data-id]"); if (li && e.key === "Enter") open(li.dataset.id); };
  $("cp-list").onclick = (e) => { const li = e.target.closest("[data-id]"); if (li) open(li.dataset.id); };
  $("cp-list").onkeydown = (e) => { const li = e.target.closest("[data-id]"); if (li && e.key === "Enter") open(li.dataset.id); };
  document.querySelectorAll(".cp-viewtog [data-view]").forEach((b) => (b.onclick = () => {
    view = b.dataset.view;
    try { localStorage.setItem("cp_view", view); } catch { /* sem armazenamento */ }
    $("cp-detail").classList.toggle("open", !!current);
    applyLayout();
  }));
  document.body.dataset.mode = mode;
  DESK.addEventListener("change", applyLayout);
  WIDE.addEventListener("change", () => { if (shown && $("cp-detail").classList.contains("open")) renderDetail(shown); });
  bindBoard();
  bindQueue($("cp-queue"));
  applyLayout();

  try { applySkin(localStorage.getItem("cp_skin") || "clean"); } catch { /* ok */ }
  api("/api/copilot/settings").then((r) => {
    if (!r.ok) return;
    prefs = r.data; applySkin(r.data.skin);
    if (shown && $("cp-detail").classList.contains("open")) renderDetail(shown); // cards laterais
  });
  // Sem conexão/acesso expirado: aviso no topo + chip "Na fila de envio".
  // Quando a conexão volta, recarrega a lista (o sync já trouxe o que chegou).
  let lastNet = null;
  if (window.NetStatus) window.NetStatus.init({
    chipHost: document.querySelector(".cp-top"),
    onChange: (st) => {
      const now = st.server_down ? "down" : st.status;
      if (lastNet && lastNet !== "online" && now === "online") load();
      lastNet = now;
    },
  });
  api("/api/status").then((r) => {
    if (!r.ok) return;
    canSend = !!r.data.can_send; me = lower(r.data.account);
    if (shown && reply && reply.open) renderDetail(shown);
  });
  load();
  // deep link /copilot/{id}: abre o detalhe direto (página inteira no desktop)
  if (pathId()) open(pathId(), true);
})();
