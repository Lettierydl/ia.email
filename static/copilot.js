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
  let reply = null; // { tid, open, text, aiText, instr, extraCc, all, recipients, busy, status, draftLoading }
  function flushReplyDraft() {
    // só texto editado aqui: rascunho da IA já está salvo, e caixa ainda carregando
    // (vazia) apagava o rascunho salvo da thread
    if (!reply || !window.DraftPersist || reply.draftLoading || reply.text === reply.aiText) return;
    window.DraftPersist.flush(reply.tid, reply.text);
  }
  function knownDraftText(it) {
    if (reply && reply.tid === it.thread_id && (reply.text || "").trim()) return reply.text;
    if ((it.draft || "").trim()) return it.draft;
    if (window.DraftPersist) {
      const c = window.DraftPersist.cacheGet(it.thread_id);
      if (c && c.trim()) return c;
    }
    return "";
  }
  function prefetchDraft(it) {
    if (!it || !window.DraftPersist) return Promise.resolve(null);
    return window.DraftPersist.prefetch(it.thread_id).then((text) => {
      if (text == null) return null;
      if (shown && shown.thread_id === it.thread_id) {
        shown.draft = text;
        if (reply && reply.tid === it.thread_id) {
          const edited = reply.text.trim() && reply.text !== reply.aiText;
          if (!edited) { reply.text = text; reply.aiText = text; }
          reply.draftLoading = false;
        }
        if ($("cp-detail").classList.contains("open")) renderDetail(shown);
      }
      return text;
    }).catch(() => null);
  }
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
    // "Reescrever" na seleção do rascunho: só o trecho (sem regerar nem Ajustar);
    // o annotate.js troca no textarea e dispara input -> reply.text + autosave.
    rewrite: async (req) => {
      if (!shown) throw new Error("Abra uma conversa.");
      const r = await api(`/api/threads/${encodeURIComponent(shown.thread_id)}/rewrite-passage`, "POST", req);
      if (!r.ok) throw new Error(r.data.detail || "Não deu para reescrever o trecho.");
      return r.data.replacement;
    },
    // "Corrigir português" na seleção do rascunho: só ortografia/pontuação do trecho
    fixPortuguese: async (req) => {
      if (!shown) throw new Error("Abra uma conversa.");
      const d = await window.Composer.fixPortuguese(shown.thread_id, { draft: req.draft, start: req.start, end: req.end });
      return d.replacement;
    },
  });
  let canSend = false; // /api/status.can_send (escopo gmail.send)
  let me = "";
  const readingNow = new Set(); // leituras individuais em andamento (abrir / Ler de novo)
  // Anexos recebidos (Gmail) da thread aberta — mesma API do /mail.
  let gmailAtt = { tid: null, files: [], message_ids: [] };
  function gmailAttUrl(tid, f, asDownload) {
    const q = new URLSearchParams({ filename: f.filename || "anexo" });
    if (asDownload) q.set("download", "1");
    return `/api/threads/${encodeURIComponent(tid)}/gmail-attachments/${encodeURIComponent(f.message_id)}/${encodeURIComponent(f.attachment_id)}?${q}`;
  }
  function formatAttSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024) return bytes + "B";
    return (bytes / 1024).toFixed(0) + "KB";
  }
  // Tipo do anexo (pelo mime ou pela extensão) -> ícone colorido do pill, como no Gmail.
  function attKind(f) {
    const mime = (f.mime_type || "").toLowerCase();
    const ext = ((f.filename || "").match(/\.([a-z0-9]+)$/i) || [])[1] || "";
    const e = ext.toLowerCase();
    if (mime === "application/pdf" || e === "pdf") return "pdf";
    if (mime.startsWith("image/") || /^(png|jpe?g|gif|webp|bmp|heic|svg)$/.test(e)) return "img";
    if (/spreadsheet|excel|csv/.test(mime) || /^(xlsx?|csv|ods)$/.test(e)) return "sheet";
    if (/presentation|powerpoint/.test(mime) || /^(pptx?|odp|key)$/.test(e)) return "slides";
    if (/word|opendocument\.text|rtf/.test(mime) || /^(docx?|odt|rtf|txt)$/.test(e)) return "doc";
    if (/zip|compressed|x-rar|x-7z|tar|gzip/.test(mime) || /^(zip|rar|7z|tar|gz)$/.test(e)) return "zip";
    return "file";
  }
  const ATT_ICON = {
    pdf: '<rect width="16" height="16" rx="3" fill="#ea4335"/><text x="8" y="10.6" text-anchor="middle" font-size="5.6" font-weight="700" font-family="Arial,sans-serif" fill="#fff">PDF</text>',
    img: '<rect width="16" height="16" rx="3" fill="#ea4335"/><path d="M3 12l3.2-4 2.3 2.8L10 9l3 3z" fill="#fff"/><circle cx="11" cy="5.2" r="1.3" fill="#fff"/>',
    sheet: '<rect width="16" height="16" rx="3" fill="#188038"/><path d="M4 5h8v6.5H4zM4 8.2h8M8 5v6.5" stroke="#fff" stroke-width="1.1" fill="none"/>',
    slides: '<rect width="16" height="16" rx="3" fill="#f9ab00"/><rect x="4" y="5" width="8" height="6" rx="1" fill="none" stroke="#fff" stroke-width="1.2"/>',
    doc: '<rect width="16" height="16" rx="3" fill="#4285f4"/><path d="M4.5 5.5h7M4.5 8h7M4.5 10.5h4.5" stroke="#fff" stroke-width="1.2"/>',
    zip: '<rect width="16" height="16" rx="3" fill="#5f6368"/><path d="M8 3v2M8 6v2M8 9v1.5" stroke="#fff" stroke-width="1.4"/><rect x="6.6" y="10.5" width="2.8" height="2.6" rx=".6" fill="#fff"/>',
    file: '<rect width="16" height="16" rx="3" fill="#80868b"/><path d="M5 3.8h4l2.2 2.2v6.2H5z" fill="none" stroke="#fff" stroke-width="1.1"/>',
  };
  const ATT_DL = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';
  // Pills compactos (Gmail): ícone do tipo + nome truncado; o pill abre o
  // anexo numa aba e a setinha discreta baixa.
  function inboundAttHTML(tid, files) {
    if (!files || !files.length) return "";
    return `<div class="cp-att-pills">${files.map((f) => {
      const name = f.filename || "anexo";
      const size = formatAttSize(f.size);
      const tip = `${name}${size ? ` (${size})` : ""}`;
      return `<span class="cp-att-pill">
        <a class="cp-att-open" href="${gmailAttUrl(tid, f, false)}" target="_blank" rel="noopener" title="Abrir ${esc(tip)}">
          <svg class="cp-att-ic" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${ATT_ICON[attKind(f)]}</svg>
          <span class="cp-att-name">${esc(name)}</span>
        </a>
        <a class="cp-att-dl" href="${gmailAttUrl(tid, f, true)}" download="${esc(name)}" title="Baixar ${esc(tip)}" aria-label="Baixar ${esc(name)}">${ATT_DL}</a>
      </span>`;
    }).join("")}</div>`;
  }
  async function loadGmailAttachments(tid) {
    if (!tid) return;
    try {
      const r = await api(`/api/threads/${encodeURIComponent(tid)}/gmail-attachments`);
      if (!r.ok) return;
      if (current !== tid && (!shown || shown.thread_id !== tid)) return;
      gmailAtt = { tid, files: r.data.files || [], message_ids: r.data.message_ids || [] };
      // Re-pinta a thread se o detalhe ainda estiver aberto nesta thread.
      if (shown && shown.thread_id === tid) {
        const root = $("cp-thread");
        if (root) {
          const msgs = shown.mensagens || [];
          const ui = threadUI(root);
          root.innerHTML = msgs.map((m, i) => messageHTML(m, i, msgs.length, tid)).join("");
          bindThread(root);
          hydrateAvatars(root);
          annot.reapply(); // o innerHTML apagou as marcas dos trechos citados
          restoreThreadUI(root, ui);
        }
      }
    } catch (_) { /* silencioso */ }
  }
  const avatars = {};
  const layout = () => document.body.dataset.layout;
  // Ícones: módulo compartilhado static/icons.js (o mesmo do /mail, /settings, /board).
  const ic = (name, o) => (window.Icons ? window.Icons.svg(name, Object.assign({ size: 22 }, o || {})) : "");
  const ICO = {
    eye: ic("eye"), bell: ic("bell"), bellOff: ic("bell-off"), share: ic("handoff"),
    // Resolvido: duplo check em círculo, em verde (CSS .ic-check-circle-double)
    done: ic("check-circle-double"), reopen: ic("reopen"), thread: ic("thread"), summary: ic("summary"),
    gmail: ic("gmail"), mail: ic("mail"), reply: ic("reply"), send: ic("send"), spark: ic("sparkles"),
    learn: ic("learn"), chat: ic("chat"), trash: ic("trash"), back: ic("back"), refresh: ic("refresh"),
    search: ic("search"),
  };
  const ROLE_ICON = { so_copia: "role-copia", mencionado_opiniao: "role-opiniao", demanda: "role-demanda", fyi: "role-fyi", pode_ignorar: "role-ignorar" };
  // tip: texto do tooltip (padrão = label); off: desabilitado mas com tooltip
  // (aria-disabled em vez de disabled, senão o navegador não mostra o hover).
  const iconBtn = (act, label, icon, extra = "", tip = "", off = false) =>
    `<button type="button" class="cp-btn cp-icon-act${act === "acompanhar" || act === "assumir" ? " primary" : ""}${off ? " is-off" : ""}" data-act="${act}" title="${esc(tip || label)}" aria-label="${esc(tip || label)}"${off ? ' aria-disabled="true"' : ""} ${extra}>${icon}<span class="cp-icon-tip">${esc(tip || label)}</span></button>`;
  // "Responder com IA": CTA primário (fundo accent, ícone + texto) no card
  // "O que eu faria" e fixo na barra inferior; no celular vira pílula larga.
  const aiReplyBtn = (attrs, icon, primary) =>
    `<button type="button" class="cp-btn cp-icon-act cp-ai-act${primary ? " primary" : ""}" ${attrs} title="Responder com IA (conversar com a IA e escrever o rascunho)" aria-label="Responder com IA">${icon}<span class="cp-ai-t">Responder com IA</span></button>`;

  // Ações rápidas no card compacto (lista/kanban): mesmo resolver (marca lido +
  // tira do quadro) e o mesmo Delegar do detalhe, sem abrir o detalhe antes.
  function cardActsHTML(it) {
    if (it.status === "resolvido") return "";
    return `<div class="cp-card-acts" role="group" aria-label="Ações rápidas">
      <button type="button" class="cp-card-act" data-card-act="resolver" title="Marcar como lido" aria-label="Marcar como lido">${ICO.done}</button>
      <button type="button" class="cp-card-act" data-card-act="delegar" title="Delegar" aria-label="Delegar (passar para outra pessoa)">${ICO.share}</button>
    </div>`;
  }
  function findCardItem(id) {
    return (data.items || []).find((i) => i.thread_id === id)
      || (hist || []).find((i) => i.thread_id === id)
      || (found || []).find((i) => i.thread_id === id)
      || (shown && shown.thread_id === id ? shown : null);
  }
  async function runCardAct(btn) {
    const card = btn.closest("[data-id]");
    if (!card || btn.getAttribute("aria-disabled") === "true") return;
    const id = card.dataset.id;
    const action = btn.dataset.cardAct;
    let it = findCardItem(id);
    if (!it) return;
    if (action === "delegar") {
      // lista/kanban não traz originarios: busca o detalhe só pra rotular o Cc
      if (!Array.isArray(it.originarios)) {
        btn.setAttribute("aria-disabled", "true");
        const r = await api(`/api/copilot/${encodeURIComponent(id)}`);
        btn.removeAttribute("aria-disabled");
        if (!r.ok) { toast(r.data.detail || "Não deu certo."); return; }
        it = r.data;
      }
      openDelegate(it);
      return;
    }
    if (action === "resolver") {
      btn.setAttribute("aria-disabled", "true");
      card.classList.add("pending");
      await act(it, "resolver");
    }
  }
  // Clique/tecla em ação do card: não abre o detalhe.
  function handleCardActEvent(e) {
    const btn = e.target.closest("[data-card-act]");
    if (!btn) return false;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return true;
    runCardAct(btn);
    return true;
  }

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
  const FILA_KEY = "analisando";
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
      ${queueOpen ? `<div class="cp-queue-acts">${resolveAllBtn(FILA_KEY)}</div><ul class="cp-queue-list">${items.map(qcardHTML).join("")}</ul>` : ""}`;
    $("cp-queue-tog").onclick = () => { queueOpen = !queueOpen; sessionStorage.setItem("cp_queue_open", queueOpen ? "1" : "0"); renderQueueList(); };
  }
  function queueStripHTML() {
    const items = queueItems();
    if (!items.length) return "";
    return `<section class="cp-qstrip" aria-label="Analisando">
      <header><h2>${queueHead(items)}</h2>${resolveAllBtn(FILA_KEY)}<p>A IA ainda não leu: cada um entra na coluna certa quando a leitura terminar.</p></header>
      <ul class="cp-qstrip-list">${items.map(qcardHTML).join("")}</ul></section>`;
  }
  function bindQueue(root) {
    root.addEventListener("click", (e) => {
      if (handleResolveAll(e)) return;
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
    if (query) chips.push(`<span class="cp-chip soft">${it.is_unread ? "não lido" : "lido"}</span>`); // busca mistura lidos e não lidos
    const bola = it.bola ? ballAvatarHTML(it) : "";
    return `<li class="cp-item u-${it.urgencia}${current === it.thread_id ? " sel" : ""}" data-id="${esc(it.thread_id)}" tabindex="0">
      <div class="cp-item-main"><h3>${esc(it.subject)}</h3><p>${esc(it.o_que_aconteceu || it.from_name)}</p><div class="cp-meta">${chips.join("")}</div>${cardActsHTML(it)}</div>${bola}</li>`;
  }
  // Abertos no quadro (sem resolvidos, mesmo com "Mostrar todos").
  const openCount = () => data.items.filter((i) => i.tab !== "resolvido" && i.status !== "resolvido").length;
  // Caixa zerada inline (celebrate.js): a praia só aparece com o quadro inteiro
  // vazio (cena grande); coluna/aba vazia com e-mail em outra = texto simples.
  // Anima só na transição >0 → 0 (czFresh, marcado em trackZero) e depois fica
  // parada. Pref desligada = texto simples sempre.
  const czOn = () => prefs.celebrate_zero !== false && !!window.Celebrate;
  let czFresh = false; // o quadro inteiro acabou de zerar nesta carga
  const czScene = () => window.Celebrate.sceneHTML({ key: "all", fresh: czFresh });
  const emptyHTML = (key) => (czOn() && key && !openCount()
    ? `<li class="cp-empty cp-empty-cz">${czScene()}</li>`
    : `<li class="cp-empty">${data.show_all ? "Nada por aqui." : "Nenhum não lido aqui."} 🌿</li>`);
  const czRender = (box, fn) => (window.Celebrate ? window.Celebrate.keep(box, fn) : fn());
  // ── views: Quadro | Resolvidos | Marcados como lido ──
  const histKey = (i) => (i.status === "resolvido" ? "resolvido" : !i.is_unread && i.no_copiloto && !i.pendente ? "lidos" : "");
  // cabeçalho pastel + contador + subtítulo (o mesmo das colunas do quadro)
  const secHead = (title, n, hint, color, tag = "h2", act = "") =>
    `<header class="cp-col-h h-${color}"><div class="cp-col-hrow"><${tag}>${esc(title)}${n == null ? "" : `<b>${n}</b>`}</${tag}>${act}</div>${hint ? `<p>${esc(hint)}</p>` : ""}</header>`;
  // ── "Resolver todos" da coluna: o mesmo Resolvido de cada cartão (resolvido +
  // lido no Gmail), num lote só no servidor. Não envia e-mail. Só no quadro.
  const RESOLVE_ALL_TIP = "Marcar todos desta coluna como resolvidos (lidos no Gmail)";
  const columnIds = (key) => data.items.filter((i) => i.tab === key && i.status !== "resolvido").map((i) => i.thread_id);
  function resolveAllBtn(key) {
    if (query || mode !== "quadro" || !columnIds(key).length) return "";
    return `<button type="button" class="cp-resolve-all" data-resolve-col="${esc(key)}" title="${RESOLVE_ALL_TIP}" aria-label="${RESOLVE_ALL_TIP}">${ICO.done}<span>Resolver todos</span></button>`;
  }
  async function resolveColumn(btn) {
    const key = btn.dataset.resolveCol;
    const ids = columnIds(key);
    if (!ids.length || btn.disabled) return;
    if (!(await window.Dialog.confirm({
      title: `Resolver ${ids.length} e-mail${ids.length === 1 ? "" : "s"}?`,
      body: "Os e-mails desta coluna vão para Resolvidos. Serão marcados como lidos no Gmail; nenhum e-mail é enviado.",
      ok: "Resolver todos", cancel: "Cancelar",
    }))) return;
    btn.disabled = true;
    const r = await api("/api/copilot/resolve-column", "POST", { tab: key, thread_ids: ids });
    if (!r.ok) { btn.disabled = false; toast(r.data.detail || "Não deu certo."); return; }
    const n = r.data.resolvidos || 0;
    toast(`${n} resolvido${n === 1 ? "" : "s"}.${r.data.gmail_ok === false ? " Não consegui marcar como lido no Gmail (reautorize o Gmail)." : ""}`);
    if (current && (r.data.thread_ids || []).includes(current)) closeDetail();
    load();
  }
  function handleResolveAll(e) {
    const btn = e.target.closest("[data-resolve-col]");
    if (!btn) return false;
    e.preventDefault();
    e.stopPropagation();
    resolveColumn(btn);
    return true;
  }
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
  // ── busca: filtro por cima de quadro/histórico, olhando lidos e resolvidos ──
  let query = sessionStorage.getItem("cp_q") || "";
  let found = null; // itens de /api/copilot?all=1&q= (null = ainda buscando)
  let searchSeq = 0;
  let searchTimer = null;
  const FOUND_GROUPS = [
    { key: "precisa_de_voce", title: "Precisa de você", color: "peach" },
    { key: "bola_com_outros", title: "Aguardando outras pessoas", color: "lilac" },
    { key: "so_conhecimento", title: "Só conhecimento", color: "sky" },
    { key: "analisando", title: "Analisando", color: "fog" },
    { key: "resolvido", title: "Resolvidos", color: "mint" },
  ];
  function renderSearch() {
    const box = $("cp-found");
    if (found == null) { box.innerHTML = '<p class="cp-empty">Buscando…</p>'; return; }
    const head = `<p class="cp-found-h">${found.length} resultado${found.length === 1 ? "" : "s"} para “${esc(query)}” · inclui lidos e resolvidos</p>`;
    if (!found.length) { box.innerHTML = `${head}<p class="cp-empty">Nada encontrado. Tente outra palavra do assunto ou o nome de quem mandou.</p>`; return; }
    const secs = FOUND_GROUPS.map((g) => ({ ...g, items: found.filter((i) => i.tab === g.key) })).filter((s) => s.items.length);
    box.innerHTML = head + `<div class="cp-hsecs">${secs
      .map((s) => `<section class="cp-hsec" aria-label="${esc(s.title)}">${secHead(s.title, s.items.length, "", s.color)}
        <ul class="cp-list cp-hlist">${s.items.map(itemHTML).join("")}</ul></section>`)
      .join("")}</div>`;
    hydrateAvatars(box);
  }
  async function runSearch() {
    const q = query;
    const seq = ++searchSeq;
    if (!q) { found = null; return; }
    const r = await api(`/api/copilot?all=1&q=${encodeURIComponent(q)}`);
    if (seq !== searchSeq || q !== query) return; // digitou de novo enquanto buscava
    found = r.ok ? r.data.items || [] : [];
    if (!r.ok) toast(r.data.detail || "Falha na busca.");
    renderList();
  }
  function setQuery(next) {
    next = (next || "").replace(/\s+/g, " ").trim();
    $("cp-q-x").classList.toggle("hidden", !$("cp-q").value);
    if (next === query) return;
    query = next;
    sessionStorage.setItem("cp_q", query);
    document.body.dataset.search = query ? "1" : "";
    found = null;
    clearTimeout(searchTimer);
    renderList();
    if (query) searchTimer = setTimeout(runSearch, 250);
  }
  function renderList() {
    if (query) { renderSearch(); return; }
    if (mode !== "quadro") { renderHistory(); return; }
    if (layout() === "kanban") { renderBoard(); return; }
    if (!data.tabs.some((t) => t.key === tab)) tab = "precisa_de_voce";
    renderTabs();
    renderQueueList();
    const items = data.items.filter((i) => i.tab === tab);
    const all = resolveAllBtn(tab);
    czRender($("cp-list"), () => ($("cp-list").innerHTML = items.length ? (all ? `<li class="cp-list-acts">${all}</li>` : "") + items.map(itemHTML).join("") : emptyHTML(tab)));
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
      ${meta.length ? `<div class="cp-k-meta">${meta.join("")}</div>` : ""}${cardActsHTML(it)}</li>`;
  }
  function renderBoard() {
    const board = $("cp-board");
    const scroll = {};
    board.querySelectorAll(".cp-col").forEach((c) => (scroll[c.dataset.col] = c.querySelector(".cp-col-list").scrollTop));
    const strip = board.querySelector(".cp-qstrip-list");
    const stripScroll = strip ? strip.scrollLeft : 0;
    const queue = queueStripHTML();
    board.classList.toggle("has-queue", !!queue);
    // quadro inteiro zerado: a praia maior ocupa a área das colunas
    const allZero = czOn() && data.tabs.length && !openCount();
    czRender(board, () => (board.innerHTML = queue + (allZero
      ? `<div class="cz-board-zero">${czScene()}</div>`
      : data.tabs
        .map((t) => {
          const items = data.items.filter((i) => i.tab === t.key);
          return `<section class="cp-col t-${t.key}" data-col="${t.key}" aria-label="${esc(t.title)}">
          ${secHead(t.title, items.length, COL_HINT[t.key] || "", COL_COLOR[t.key] || "fog", "h2", resolveAllBtn(t.key))}
          <ul class="cp-col-list">${items.length ? items.map(kcardHTML).join("") : emptyHTML(t.key)}</ul></section>`;
        })
        .join(""))));
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
      if (e.target.closest("[data-card-act],button,a,input")) { e.preventDefault(); return; }
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
    board.addEventListener("click", (e) => {
      if (handleResolveAll(e) || handleCardActEvent(e)) return;
      const c = e.target.closest(".cp-kcard");
      if (c) open(c.dataset.id);
    });
    board.addEventListener("keydown", (e) => {
      if (handleCardActEvent(e)) return;
      const c = e.target.closest(".cp-kcard");
      if (c && e.key === "Enter") open(c.dataset.id);
    });
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
  // Caixa zerada: marca para animar só a transição >0 → 0 do quadro inteiro
  // nesta sessão. Abrir a página já zerada = cena parada. A marca vale só para
  // a renderização desta carga (load limpa depois).
  let lastOpen = null;
  function trackZero() {
    const n = openCount();
    czFresh = lastOpen > 0 && n === 0 && czOn();
    lastOpen = n;
  }
  async function load() {
    const want = mode;
    const [r, h] = await Promise.all([api("/api/copilot"), want === "quadro" ? null : api("/api/copilot?all=1")]);
    if (!r.ok) { toast(r.data.detail || "Falha ao carregar."); return; }
    data = r.data;
    trackZero();
    if (h && want === mode) hist = h.ok ? h.data.items || [] : [];
    renderModes();
    $("cp-hello").textContent = data.saudacao;
    const day = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
    $("cp-date").textContent = countLine(day);
    $("cp-date").title = COUNT_HINT;
    $("cp-n-hoje").textContent = data.cards.hoje;
    $("cp-n-esp").textContent = data.cards.esperando_outros;
    renderList();
    czFresh = false; // animou nesta renderização; as próximas reaproveitam o nó (Celebrate.keep)
    if (query) runSearch(); // ação feita com a busca aberta: resultados refletem o estado novo
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
    return `<div class="cp-resumo-row"><details class="cp-why cp-resumo"><summary>Resumo${n ? ` · ${n} ${n === 1 ? "mensagem" : "mensagens"}` : ""}</summary>
      <dl class="cp-rc">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl></details>
      <button type="button" class="cp-rd-link" data-resumo-det title="Resumo maior e mais detalhado, gerado pela IA">Resumo detalhado</button></div>`;
  }
  // ── resumo detalhado: IA sob demanda; o servidor guarda em cache por thread
  // (reabrir não chama a IA de novo; mensagem nova na thread invalida) ──
  const RD_SECTIONS = [
    ["pontos_principais", "Pontos principais"],
    ["pedidos_ao_leo", "O que pediram a você"],
    ["pedidos_a_outros", "Pedidos a outras pessoas"],
    ["prazos", "Prazos"],
    ["numeros_dados", "Números e dados"],
    ["decisoes_riscos", "Decisões, pendências e riscos"],
    ["anexos_mencionados", "Anexos mencionados"],
    ["proximos_passos", "Próximos passos"],
  ];
  const rdWhen = (iso) => {
    const d = new Date(iso);
    return !iso || isNaN(d) ? "" : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "");
  };
  function rdItem(key, v) {
    if (key === "pedidos_a_outros") return `<li><b>${esc(v.nome || "Alguém")}:</b> ${esc(v.pedido)}</li>`;
    if (key === "prazos") return `<li><b>${esc(v.data || "Sem data")}:</b> ${esc(v.o_que)}</li>`;
    return `<li>${esc(v)}</li>`;
  }
  function resumoDetHTML(r) {
    const res = r.resumo || {};
    const parts = [];
    if (res.contexto) parts.push(`<section><h4>Contexto</h4><p>${esc(res.contexto)}</p></section>`);
    RD_SECTIONS.forEach(([key, title]) => {
      const list = res[key] || [];
      if (list.length) parts.push(`<section><h4>${esc(title)}</h4><ul>${list.map((v) => rdItem(key, v)).join("")}</ul></section>`);
    });
    return parts.join("") || '<p class="cp-from">A IA não encontrou nada além do resumo curto.</p>';
  }
  let rdSeq = 0;
  async function openResumoDet(it, regerar) {
    const seq = ++rdSeq;
    const head = `<h3>Resumo detalhado</h3><p class="cp-from cp-rd-sub">${esc(it.subject || "")}</p>`;
    sheet(`<div class="cp-rd">${head}<p class="cp-from cp-reading">Gerando resumo detalhado…</p></div>`, true);
    const url = `/api/copilot/${encodeURIComponent(it.thread_id)}/resumo-detalhado`;
    const r = await api(url, regerar ? "POST" : "GET", null, 150000);
    if (seq !== rdSeq || $("cp-sheet").classList.contains("hidden")) return; // fechou ou abriu outro
    const when = r.ok ? rdWhen(r.data.gerado_em) : "";
    const meta = r.ok ? `<p class="cp-from cp-rd-meta">${when ? `gerado em ${esc(when)}` : ""}${r.data.cached ? " (do cache)" : ""}${r.data.desatualizado ? " · <b>chegou mensagem nova depois deste resumo</b>" : ""}</p>` : "";
    const aviso = r.ok && r.data.aviso ? `<p class="cp-rd-warn">${esc(r.data.aviso)}</p>` : "";
    const body = r.ok ? resumoDetHTML(r.data) : `<p class="cp-rd-warn">${esc(r.data.detail || "Não deu para gerar o resumo detalhado agora.")}</p>`;
    sheet(`<div class="cp-rd">${head}${meta}${aviso}<div class="cp-rd-body">${body}</div>
      <div class="cp-row cp-rd-foot"><button type="button" class="cp-btn" id="cp-rd-regen">${ICO.refresh}<span>Regerar</span></button>
      <button type="button" class="cp-btn primary" data-close>Fechar</button></div></div>`, true);
    $("cp-rd-regen").onclick = () => openResumoDet(it, true);
  }
  // ── verificador: confere na caixa (só leitura) o que o e-mail afirma ──
  // GET = só o cache; sem cache (ou com mensagem nova depois dele) faz o POST,
  // que lê o e-mail, busca na caixa e avalia. Regerar = POST {regerar:true}.
  const VF_STEPS = ["Lendo o e-mail…", "Procurando na sua caixa…", "Conferindo o que achei…"];
  const VF_STEP_MS = [0, 5000, 14000];
  const VF_SELO = { confirmado: "Confirmado", nao_encontrado: "Não encontrado", inconclusivo: "Inconclusivo" };
  let vfSeq = 0;
  let vfTimers = [];
  const vfHead = (it) => `<h3>🔎 Verificar na caixa</h3><p class="cp-from cp-rd-sub">${esc(it.subject || "")}</p>`;
  function vfStepsHTML(step) {
    return `<ol class="cp-vf-steps" aria-live="polite">${VF_STEPS.map((t, i) =>
      `<li class="${i < step ? "done" : i === step ? "now" : ""}">${i < step ? "✓" : i === step ? '<span class="cp-vf-spin" aria-hidden="true"></span>' : "·"} ${esc(t)}</li>`).join("")}</ol>`;
  }
  function vfEvidenceHTML(ev) {
    const when = rdWhen(ev.data) || ev.data || "";
    const links = [
      ev.gmail_url ? `<a href="${esc(ev.gmail_url)}" target="_blank" rel="noopener">Abrir no Gmail</a>` : "",
      ev.app_url ? `<a href="${esc(ev.app_url)}" data-vf-app>Abrir no app</a>` : "",
    ].filter(Boolean).join(" · ");
    return `<li class="cp-vf-ev"><div class="cp-vf-ev-h"><b>${esc(ev.assunto || "(sem assunto)")}</b>${ev.pasta ? `<span class="cp-vf-pasta">${esc(ev.pasta)}</span>` : ""}</div>
      <p class="cp-from">${esc(ev.de || "")}${when ? ` · ${esc(when)}` : ""}${ev.mesma_thread ? " · nesta conversa" : ""}</p>
      ${ev.snippet ? `<q>${esc(ev.snippet)}</q>` : ""}${links ? `<p class="cp-vf-links">${links}</p>` : ""}</li>`;
  }
  function vfClaimHTML(a) {
    const v = VF_SELO[a.veredito] ? a.veredito : "inconclusivo";
    const evs = a.evidencias || [];
    const qs = a.consultas || [];
    return `<li class="cp-vf-claim v-${v}"><div class="cp-vf-claim-h"><span class="cp-vf-selo s-${v}">${esc(VF_SELO[v])}</span><p class="cp-vf-texto">${esc(a.texto)}</p></div>
      <p class="cp-vf-expl">${esc(a.explicacao || "")}</p>
      ${evs.length ? `<ul class="cp-vf-evs">${evs.map(vfEvidenceHTML).join("")}</ul>` : ""}
      ${qs.length ? `<details class="cp-why cp-vf-qs"><summary>Consultas usadas (${qs.length})</summary><ul>${qs.map((c) =>
        `<li><code>${esc(c.q)}</code> → ${c.erro ? `<span class="cp-rd-warn-i">erro: ${esc(c.erro)}</span>` : `${c.resultados} ${c.resultados === 1 ? "resultado" : "resultados"}`}</li>`).join("")}</ul></details>` : ""}</li>`;
  }
  function vfResultHTML(d) {
    const list = d.afirmacoes || [];
    const count = (k) => list.filter((a) => a.veredito === k).length;
    const tally = list.length ? `<p class="cp-vf-tally">${Object.keys(VF_SELO).filter(count).map((k) => `<span class="cp-vf-selo s-${k}">${count(k)} ${esc(VF_SELO[k].toLowerCase())}</span>`).join(" ")}</p>` : "";
    return `${tally}${list.length ? `<ol class="cp-vf-list">${list.map(vfClaimHTML).join("")}</ol>` : `<p class="cp-from">${esc(d.aviso || "Nada para conferir neste e-mail.")}</p>`}`;
  }
  function vfClearTimers() { vfTimers.forEach(clearTimeout); vfTimers = []; }
  async function openVerify(it, regerar) {
    const seq = ++vfSeq;
    vfClearTimers();
    const tid = encodeURIComponent(it.thread_id);
    const url = `/api/copilot/${tid}/verificar`;
    const alive = () => seq === vfSeq && !$("cp-sheet").classList.contains("hidden");
    const wrap = (inner) => `<div class="cp-rd cp-vf">${vfHead(it)}${inner}</div>`;
    let r = null;
    if (!regerar) {
      sheet(wrap(`<p class="cp-from cp-reading">Abrindo…</p>`), "full");
      const c = await api(url);
      if (seq !== vfSeq) return;
      if (c.ok && Array.isArray(c.data.afirmacoes) && !c.data.desatualizado) r = c;
    }
    if (!r) {
      const show = (i) => { if (alive()) $("cp-sheet-body").querySelector(".cp-vf-wait").innerHTML = vfStepsHTML(i); };
      sheet(wrap(`<div class="cp-vf-wait">${vfStepsHTML(0)}</div><p class="cp-from">Só leitura: nada é enviado, marcado nem movido na sua caixa.</p>`), "full");
      VF_STEP_MS.slice(1).forEach((ms, i) => vfTimers.push(setTimeout(() => show(i + 1), ms)));
      r = await api(url, "POST", { regerar: !!regerar }, 240000);
      if (seq === vfSeq) vfClearTimers();
      if (!alive()) return; // fechou ou abriu outro
    }
    const when = r.ok ? rdWhen(r.data.gerado_em) : "";
    const meta = r.ok ? `<p class="cp-from cp-rd-meta">${when ? `verificado em ${esc(when)}` : ""}${r.data.cached ? " (do cache)" : ""}</p>` : "";
    const body = r.ok ? vfResultHTML(r.data) : `<p class="cp-rd-warn">${esc(r.data.detail || "Não deu para verificar agora.")}</p>`;
    sheet(wrap(`${meta}<div class="cp-rd-body cp-vf-body">${body}</div>
      <div class="cp-row cp-rd-foot"><button type="button" class="cp-btn" id="cp-vf-regen">${ICO.refresh}<span>${r.ok ? "Regerar" : "Tentar de novo"}</span></button>
      <button type="button" class="cp-btn primary" data-close>Fechar</button></div>`), "full");
    $("cp-vf-regen").onclick = () => openVerify(it, r.ok);
    $("cp-sheet-body").querySelectorAll("[data-vf-app]").forEach((a) => (a.onclick = (e) => {
      const id = decodeURIComponent(a.getAttribute("href").split("/").pop());
      if (e.metaKey || e.ctrlKey || e.shiftKey) return; // nova aba: deixa o link seguir
      e.preventDefault();
      closeSheet();
      open(id);
    }));
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
  function messageHTML(m, i, n, tid) {
    const { name, email } = parseFrom(m.de);
    const { main, quoted } = splitQuoted(m.texto || "");
    const last = i === n - 1;
    const threadId = tid || (shown && shown.thread_id) || "";
    let att = "";
    if (gmailAtt.tid === threadId && gmailAtt.message_ids.length) {
      const msgId = gmailAtt.message_ids[i];
      const files = msgId ? gmailAtt.files.filter((f) => f.message_id === msgId) : [];
      att = inboundAttHTML(threadId, files);
    }
    return `<div class="msg-card${last ? " open" : ""}" data-idx="${i}">
      <div class="msg-head" role="button" tabindex="0" aria-expanded="${last}">
        ${avatarHTML(email, name, "sm", false)}
        <span class="msg-from">${esc(name || "—")}${email && email !== name.toLowerCase() ? ` <small>&lt;${esc(email)}&gt;</small>` : ""}</span>
        ${quoted ? `<button type="button" class="msg-quoted-hint" title="Esta mensagem cita um e-mail anterior">${ic("reply", { size: 14 })} e-mail anterior citado</button>` : ""}
        <span class="msg-date">${esc(fmtDate(m.data))}</span>
        ${window.MsgReply ? window.MsgReply.headHTML(i) : ""}
        ${window.MsgSummary ? window.MsgSummary.buttonHTML() : ""}
      </div>
      <div class="msg-text">${linkify(main)}${quoted ? `<div class="quote-toggle-row"><button type="button" class="quote-toggle">Ver texto completo</button></div>
        <div class="msg-quoted hidden">${linkify(quoted)}</div>` : ""}</div>${att}</div>`;
  }
  // Cards abertos / texto citado expandido da conversa completa: o re-render via
  // innerHTML voltaria ao padrão (só a última aberta) e esconderia o trecho que
  // o Leo acabou de citar. Guarda antes, devolve depois.
  function threadUI(root) {
    if (!root) return null;
    const cards = [...root.querySelectorAll(".msg-card")];
    const quoteOpen = (c) => { const q = c.querySelector(".msg-quoted"); return !!q && !q.classList.contains("hidden"); };
    return {
      open: cards.filter((c) => c.classList.contains("open")).map((c) => c.dataset.idx),
      quotes: cards.filter(quoteOpen).map((c) => c.dataset.idx),
    };
  }
  function setCard(card, open, quote) {
    card.classList.toggle("open", open);
    const head = card.querySelector(".msg-head");
    if (head) head.setAttribute("aria-expanded", open);
    const q = card.querySelector(".msg-quoted");
    const b = card.querySelector(".quote-toggle");
    if (q && quote !== undefined) {
      q.classList.toggle("hidden", !quote);
      if (b) b.textContent = quote ? "Ocultar texto citado" : "Ver texto completo";
    }
  }
  function restoreThreadUI(root, ui) {
    if (!root) return;
    if (ui) root.querySelectorAll(".msg-card").forEach((c) => setCard(c, ui.open.includes(c.dataset.idx), ui.quotes.includes(c.dataset.idx)));
    // trecho citado fica sempre à vista (card aberto; texto citado expandido se for lá)
    root.querySelectorAll(".annot-mark").forEach((m) => {
      const c = m.closest(".msg-card");
      if (c) setCard(c, true, m.closest(".msg-quoted") ? true : undefined);
    });
  }
  function bindThread(root) {
    // "Resumir este e-mail" (static/msgsummary.js): liga os botões e repõe as caixas
    if (window.MsgSummary && shown) window.MsgSummary.bind(root, shown.thread_id);
    // Para/Cc por mensagem + "Responder a esta mensagem" / "a todos" (static/msgreply.js)
    if (window.MsgReply && shown) {
      const tid = shown.thread_id;
      window.MsgReply.bind(root, tid, { me, onReply: (idx, all) => replyToMessage(shown, idx, all) });
      // alvo que veio do chat (rascunho salvo): completa id/nome quando os cabeçalhos chegarem
      if (reply && reply.tid === tid && reply.target && !reply.target.id) {
        window.MsgReply.load(tid).then((meta) => {
          const t = reply && reply.tid === tid ? reply.target : null;
          const m = t && meta && meta[t.idx];
          if (!m || !m.id || t.id) return;
          Object.assign(t, { id: m.id, label: window.MsgReply.label(m) });
          if (reply.open && shown && shown.thread_id === tid) renderDetail(shown);
        });
      }
    }
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
    const threadUi = shown && shown.thread_id === it.thread_id ? threadUI($("cp-thread")) : null;
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
            <button type="button" class="cp-btn cp-rd-btn" id="cp-rd-open" title="Resumo maior e mais detalhado, gerado pela IA">${ICO.spark}<span>Resumo detalhado</span></button>
            <button type="button" class="cp-btn cp-rd-btn" id="cp-vf-open" title="Conferir na sua caixa (só leitura) o que este e-mail afirma: se você recebeu, enviou ou respondeu o que ele diz">${ICO.search}<span>Verificar na caixa</span></button>
            <button type="button" class="cp-icon cp-mini" id="cp-summary-tog" title="Mostrar/ocultar resumo curto" aria-label="Mostrar/ocultar resumo curto" aria-expanded="${summaryOpen}">${ICO.summary}</button>
            ${msgs.length ? `<button type="button" class="cp-icon cp-mini" id="cp-thread-go" title="Ir para a conversa completa (${msgs.length})" aria-label="Ir para a conversa completa (${msgs.length})">${ICO.thread}<span class="cp-badge">${msgs.length}</span></button>` : ""}
          </span></div>
        <div id="cp-summary" class="${summaryOpen ? "" : "hidden"}"><p class="cp-big">${esc(it.o_que_aconteceu || "—")}</p>
        ${!it.analisado && !it.lido_por_regra ? `<p class="cp-from">${reading ? "Resumo provisório: a IA está lendo…" : "Resumo provisório, pela regra."}</p>` : ""}</div></div>`;
    const head = headLine(it, ballLabel);
    const cobrarOk = it.bola.com === "outros" || !!(it.delegado && it.delegado.para);
    const rereadTip = reading ? "Lendo…" : it.analisado ? "Ler de novo (reanalisar o e-mail)" : "Pedir leitura da IA (analisar o e-mail)";
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
          ${aiReplyBtn('id="cp-ai-reply"', ICO.spark, true)}
          <button type="button" class="cp-btn cp-icon-act" id="cp-reread" title="${rereadTip}" aria-label="${rereadTip}" ${readingNow.has(it.thread_id) ? "disabled" : ""}>${ICO.refresh}<span class="cp-icon-tip">${rereadTip}</span></button>
          <a class="cp-btn cp-icon-act" href="/mail/${encodeURIComponent(it.thread_id)}" style="text-decoration:none" title="Abrir e-mail" aria-label="Abrir e-mail">${ICO.mail}<span class="cp-icon-tip">Abrir e-mail</span></a>
          <a class="cp-btn cp-icon-act" href="${esc(gmailThreadUrl(it.thread_id))}" target="_blank" rel="noopener" style="text-decoration:none" title="Abrir no Gmail (o próprio Gmail marca como lido ao abrir lá)" aria-label="Abrir no Gmail">${ICO.gmail}<span class="cp-icon-tip">Abrir no Gmail · lá ele marca como lido</span></a>
        </div></div></div>
      ${outboxHTML(it)}
      ${replyHTML(it)}
      ${msgs.length ? `<div class="cp-block cp-block-h" id="cp-thread-block">
        <div class="cp-sec cp-sec-tog" id="cp-thread-tog" role="button" tabindex="0" aria-expanded="${threadOpen}" aria-controls="cp-thread">${secHead("Conversa completa", msgs.length, threadOpen ? "Clique numa mensagem para abrir ou recolher." : "Mostrar a thread inteira", "sky", "h3")}</div>
        <div class="cp-thread${threadOpen ? "" : " hidden"}" id="cp-thread">${msgs.map((m, i) => messageHTML(m, i, msgs.length, it.thread_id)).join("")}</div></div>` : ""}
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
        ${!reply || !reply.open ? ((knownDraftText(it) || (reply && reply.draftLoading)) ? `<span class="cmp-draft-chip${reply && reply.draftLoading && !knownDraftText(it) ? " loading" : ""}" id="cp-draft-chip-bar" role="status">Rascunho salvo</span>` : "") : ""}
        ${iconBtn("acompanhar", "Acompanhar", ICO.eye)}
        ${cobrarOk ? iconBtn("cobrar", "Cobrar", ICO.bell, "", "Cobrar (prepara um rascunho, nada é enviado)") : iconBtn("cobrar", "Cobrar", ICO.bellOff, "", `Cobrar indisponível: ${cobrarOffReason(it)}`, true)}
        ${iconBtn("delegar", "Delegar", ICO.share, "", "Delegar (passar para outra pessoa)")}
        ${iconBtn("aprender", "Aprender", ICO.learn)}
        ${it.status === "resolvido"
          ? iconBtn("reabrir", "Reabrir", ICO.reopen)
          : iconBtn("resolver", "Resolvido", ICO.done, "", "Resolvido (marca como lido no Gmail)")}
        ${aiReplyBtn('data-act="responder"', ICO.spark, true)}
      </div></div>`;
    box.classList.add("open");
    document.body.classList.toggle("cp-page", page);
    $("cp-scrim").classList.remove("open");
    hydrateAvatars(box);
    $("cp-back").onclick = closeDetail;
    $("cp-reread").onclick = () => readNow(it.thread_id, true);
    $("cp-ai-reply").onclick = () => openAiReply(it);
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
    $("cp-rd-open").onclick = () => openResumoDet(it);
    $("cp-vf-open").onclick = () => openVerify(it);
    box.querySelectorAll("[data-resumo-det]").forEach((b) => (b.onclick = () => openResumoDet(it)));
    box.querySelectorAll("[data-apply]").forEach((b) => (b.onclick = () => apply(it, Number(b.dataset.apply))));
    box.querySelectorAll("[data-task]").forEach((c) => (c.onchange = () => act(it, "tarefa", { index: Number(c.dataset.task), feita: c.checked })));
    box.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => (
      b.getAttribute("aria-disabled") === "true" ? toast(b.getAttribute("aria-label"))
      : b.dataset.act === "delegar" ? openDelegate(it)
        : b.dataset.act === "responder" ? openAiReply(it)
          : b.dataset.act === "aprender" ? openLearn(it)
            : act(it, b.dataset.act))));
    bindReply(it);
    if (msgs.length) loadGmailAttachments(it.thread_id);
    box.querySelectorAll("[data-outbox-cancel]").forEach((b) => (b.onclick = async () => {
      if (!(await window.Dialog.confirm({ title: "Cancelar este envio?", body: "A resposta sai da fila e não será enviada.", ok: "Cancelar envio", cancel: "Manter na fila", danger: true }))) return;
      b.disabled = true;
      const r = await api(`/api/outbox/${encodeURIComponent(b.dataset.outboxCancel)}/cancel`, "POST");
      toast(r.ok ? "Envio cancelado." : r.data.detail || "Não deu para cancelar.");
      if (window.NetStatus) window.NetStatus.refresh();
      open(it.thread_id, true);
    }));
    annot.reapply(); // o innerHTML apagou as marcas dos trechos citados
    restoreThreadUI($("cp-thread"), threadUi);
    if (caret && $(caret[0])) {
      const ta = $(caret[0]);
      ta.focus(); ta.setSelectionRange(caret[1], caret[2]); ta.scrollTop = caret[3];
    }
  }

  // ── responder: rascunho da IA (o mesmo do /mail) + envio com confirmação ──
  function syncReply(it) {
    const cached = (window.DraftPersist && window.DraftPersist.cacheGet(it.thread_id)) || "";
    const draft = (it.draft && it.draft.trim()) ? it.draft : (cached || "");
    const waiting = !!(it._draftPending && !draft);
    if (!reply || reply.tid !== it.thread_id) {
      reply = { tid: it.thread_id, open: false, text: draft, aiText: draft, instr: "", extraCc: [], all: true, recipients: null, rc: null, rcInstr: "", rcKeep: "", busy: false, status: "",
        chat: Array.isArray(it.chat) ? it.chat.slice() : [], pending: "", chatOpen: true, draftLoading: waiting, files: [], hint: "", ask: "",
        target: targetFromChat(it.chat) };
      if (draft && window.DraftPersist) window.DraftPersist.remember(it.thread_id, draft);
    } else if (!reply.busy && draft && draft !== reply.aiText && reply.text === reply.aiText) {
      // rascunho novo no servidor (Aplicar, /mail) e o texto não foi editado aqui
      reply.text = draft; reply.aiText = draft; reply.draftLoading = false;
      if (window.DraftPersist) window.DraftPersist.remember(it.thread_id, draft);
    } else if (draft) {
      reply.draftLoading = false;
    }
    // conversa com a IA mais nova no servidor (gerada no /mail, Aplicar…)
    if (!reply.busy && Array.isArray(it.chat) && it.chat.length > reply.chat.length) reply.chat = it.chat.slice();
  }
  const lower = (e) => String(e || "").trim().toLowerCase();
  // ── responder a UMA mensagem da conversa (não só à última) ──
  // reply.target = { idx, all, id (Gmail), label: "Paulo Lemes · 07/10 15:27" } | null
  function targetFromChat(chat) {
    // o último rascunho foi feito para uma mensagem específica: continua nela
    const last = [...(chat || [])].reverse().find((m) => m.role === "ai" && m.kind !== "answer" && !m.placeholder);
    const a = last && last.alvo;
    if (!a || a.idx == null) return null;
    return { idx: Number(a.idx), all: true, id: a.message_id || "", label: window.MsgReply ? window.MsgReply.label({ de: a.de, data: a.data }) : "" };
  }
  function targetMeta(it) {
    const meta = window.MsgReply && reply && reply.target ? window.MsgReply.get(it.thread_id) : null;
    return meta ? meta[reply.target.idx] || null : null;
  }
  // Para/Cc padrão quando há alvo: os da mensagem escolhida (cabeçalhos do Gmail);
  // sem eles ainda, o remetente do card (e o Cc de sempre, se "a todos").
  function targetRc(it) {
    const t = reply.target;
    if (!t) return null;
    const meta = window.MsgReply && window.MsgReply.get(it.thread_id);
    const fromMeta = meta && window.MsgReply.recipientsFor(meta, t.idx, reply.all, me);
    if (fromMeta && fromMeta.to.length) return fromMeta;
    const msg = (it.mensagens || [])[t.idx];
    const from = msg ? parseFrom(msg.de).email : "";
    return from && from !== me ? { to: [from], cc: null } : null;
  }
  async function replyToMessage(it, idx, all) {
    syncReply(it);
    const msg = (it.mensagens || [])[idx] || {};
    reply.target = { idx, all, id: "", label: window.MsgReply.label({ de: msg.de, data: msg.data }) };
    reply.all = all;
    reply.rcKeep = ""; reply.rcInstr = "";
    if (reply.rc) reply.rc.touched = false; // destinatários voltam a sair da mensagem escolhida
    const meta = await window.MsgReply.load(it.thread_id);
    if (!reply || reply.tid !== it.thread_id || !reply.target || reply.target.idx !== idx) return;
    const m = meta && meta[idx];
    if (m) Object.assign(reply.target, { id: m.id || "", label: window.MsgReply.label(m) });
    if (reply.open) {
      renderDetail(shown && shown.thread_id === it.thread_id ? shown : it);
      const box = $("cp-reply");
      if (box) box.scrollIntoView({ behavior: "smooth", block: "start" });
      if ($("cp-reply-instr")) $("cp-reply-instr").focus({ preventScroll: true });
    } else openReply(it, { focusInstr: true, noGenerate: !!reply.text.trim() });
  }
  function clearTarget(it) {
    if (!reply) return;
    reply.target = null;
    if (reply.rc) reply.rc.touched = false;
    reply.status = "Voltou a responder à última mensagem.";
    renderDetail(shown && shown.thread_id === it.thread_id ? shown : it);
  }
  function replyTo(it) {
    if (lower(it.from_email) !== me) return it.from_email || "";
    const other = ((reply.recipients && reply.recipients.to) || []).find((a) => lower(a.email) !== me);
    return (other && other.email) || it.from_email || "";
  }
  // Para/Cc em chips (static/recipients.js). Padrão = o que o envio usaria
  // (reply_to/reply_cc do /recipients, igual ao send_reply); depois que o Leo
  // mexe (touched) fica o que ele escolheu. Vai no POST /send como to/cc.
  function rcDefaults(it) {
    const r = reply.recipients || {};
    const tr = targetRc(it);
    const to = tr ? tr.to : ((r.reply_to && r.reply_to.length) ? r.reply_to : [replyTo(it)]).map(lower).filter(Boolean);
    const seen = new Set([me, ...to]);
    const base = !reply.all ? [] : tr && tr.cc ? tr.cc : (r.reply_cc || [...(r.to || []), ...(r.cc || [])].map((a) => a.email));
    const cc = [];
    [...base, ...reply.extraCc].forEach((e) => { e = lower(e); if (e && !seen.has(e)) { seen.add(e); cc.push(e); } });
    return { to, cc };
  }
  function rcState(it) {
    if (!reply.rc) reply.rc = { to: [], cc: [], participants: [], touched: false };
    const rc = reply.rc;
    if (!rc.touched) Object.assign(rc, rcDefaults(it));
    const r = reply.recipients || {};
    const known = new Map((rc.participants || []).map((p) => [lower(p.email), p]));
    [...(r.to || []), ...(r.cc || []), { email: it.from_email, name: it.from_name || "" }].forEach((p) => {
      const e = lower(p && p.email);
      if (e && e !== me && (!known.has(e) || (p.name && !known.get(e).name))) known.set(e, { email: e, name: p.name || "" });
    });
    // nome completo dos cabeçalhos do Gmail vale mais que o apelido do cartão
    const tm = targetMeta(it);
    (r.participants || []).concat(tm ? [tm.from, ...(tm.to || []), ...(tm.cc || [])] : []).forEach((p) => { const e = lower(p.email); if (e && e !== me && p.name) known.set(e, { email: e, name: p.name }); });
    rc.participants = [...known.values()];
    return rc;
  }
  // saudação (ou o último pedido "responda a X") aponta para outra pessoa?
  function rcSuggestion(it) {
    const rc = rcState(it);
    const sug = (reply.rcInstr && window.Recipients.suggest(reply.text, rc, { instruction: reply.rcInstr, me }))
      || window.Recipients.suggest(reply.text, rc, { me });
    return sug && window.Recipients.sugKey(sug, rc) !== reply.rcKeep ? sug : null;
  }
  function rcHTML(it, prefix) {
    return window.Recipients.editorHTML(rcState(it), prefix) + (reply.recipients ? "" : '<small class="rc-loading">carregando participantes…</small>');
  }
  // Liga chips + aviso de saudação num container (composer "cp" ou confirmação "sd").
  function bindRc(root, it, prefix, sugBox) {
    const paint = () => {
      const box = sugBox();
      if (!box) return;
      const sug = rcSuggestion(it);
      box.innerHTML = window.Recipients.suggestHTML(sug, prefix);
      if (!sug) return;
      box.querySelector(`#${prefix}-rc-swap`).onclick = () => {
        window.Recipients.applySuggestion(rcState(it), sug);
        rerender();
      };
      box.querySelector(`#${prefix}-rc-keep`).onclick = () => { reply.rcKeep = window.Recipients.sugKey(sug, rcState(it)); paint(); };
    };
    const rerender = () => {
      const ed = root.querySelector(`[data-rc-editor="${prefix}"]`);
      if (ed) {
        const tmp = document.createElement("div");
        tmp.innerHTML = window.Recipients.editorHTML(rcState(it), prefix);
        ed.replaceWith(tmp.firstElementChild);
      }
      window.Recipients.bind(root, rcState(it), prefix, paint);
      paint();
    };
    window.Recipients.bind(root, rcState(it), prefix, paint);
    paint();
    return paint;
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
    const sendTip = canSend ? "Enviar (pede confirmação)" : "Reautorize o Gmail (Entrar no Gmail) para poder enviar.";
    const nChat = (reply.chat || []).filter((m) => !m.placeholder && !m.typing).length;
    return `<div class="cp-block cp-block-h cp-reply" id="cp-reply">
      <div class="cp-sec">${secHead("Responder", null, "Rascunho da IA, o mesmo do /mail. Edite à vontade: nada sai sem você confirmar.", "mint", "h3")}</div>
      <div class="cp-sec-body cmp">
        <div class="cp-seg cp-rmode" role="group" aria-label="Destinatários">
          <button type="button" data-rmode="one" class="${reply.all ? "" : "on"}">Responder</button>
          <button type="button" data-rmode="all" class="${reply.all ? "on" : ""}">Responder a todos</button>
        </div>
        ${window.MsgReply ? window.MsgReply.bannerHTML(reply.target, "cp") : ""}
        <div class="cmp-rcpt cp-rcpt" id="cp-rcpt">${rcHTML(it, "cp")}</div>
        <div id="cp-rc-sug"></div>
        <div class="cmp-attach-list attach-list${(reply.files || []).length ? "" : " hidden"}" id="cp-attach-list">${window.Composer ? window.Composer.attachChipsHTML(reply.files || []) : ""}</div>
        <details class="cmp-chat" id="cp-chat-box" ${reply.chatOpen ? "open" : ""}>
          <summary>${ic("chat", { size: 15 })}Conversa com a IA <b>${nChat}</b></summary>
          <div id="cp-chat" class="chat-messages"></div>
        </details>
        <div class="cmp-draft-head">
          <label for="cp-reply-text">Rascunho do e-mail <small>(vai ser enviado)</small></label>
          ${(reply.text.trim() || reply.draftLoading) ? `<span class="cmp-draft-chip${reply.draftLoading && !reply.text.trim() ? " loading" : ""}" id="cp-draft-chip" role="status">Rascunho salvo</span>` : ""}
          <button type="button" class="cmp-fixpt${reply.fixing ? " busy" : ""}" id="cp-fixpt" title="Corrige só ortografia, gramática, pontuação e acentos. Não muda tom, conteúdo nem ordem." ${reply.busy || reply.fixing || !reply.text.trim() ? "disabled" : ""}>${ic("check", { size: 14 })}<span>${reply.fixing ? "Corrigindo…" : "Corrigir português"}</span></button>
        </div>
        <div class="cmp-draft-wrap${reply.draftLoading && !reply.text.trim() ? " loading" : ""}" id="cp-draft-wrap">
          <textarea id="cp-reply-text" class="cmp-draft cp-reply-text" rows="9" placeholder="${reply.busy ? "A IA está escrevendo…" : reply.draftLoading ? "Carregando rascunho salvo…" : "O texto que vai para o destinatário. Para pedir algo à IA, use o campo abaixo."}" ${reply.busy ? "disabled" : ""}>${esc(reply.text)}</textarea>
          <div class="cmp-draft-skel" aria-hidden="true"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>
        </div>
        <div class="cmp-instr-sug${instrSuggest() ? "" : " hidden"}" id="cp-instr-sug" role="status">
          <span>Isso parece uma instrução — usar como pedido à IA?</span>
          <button type="button" class="cmp-sug-yes" id="cp-instr-sug-yes">${ic("sparkles", { size: 14 })}Usar como pedido e gerar</button>
          <button type="button" class="cmp-sug-no" id="cp-instr-sug-no" aria-label="Não, é o texto do e-mail">Não</button>
        </div>
        <p class="cmp-status" id="cp-reply-status" role="status">${esc(reply.busy ? "Gerando rascunho…" : reply.draftLoading && !reply.text.trim() ? "Carregando rascunho salvo…" : reply.status)}</p>
        <div class="cmp-instr">
          <label for="cp-reply-instr">${ic("sparkles", { size: 14 })}Peça à IA <small>(não vai no e-mail)</small></label>
          ${reply.ask ? `<p class="cmp-hint cp-ai-ask">A IA precisa de contexto: <b>${esc(reply.ask)}</b></p>` : ""}
          <div class="cmp-annots" id="cp-annots">${annotsHTML()}</div>
          ${window.Composer.keepChipHTML("cp-keep", reply.keepText, keepAuto())}
          <div class="cmp-instr-row">
            <textarea id="cp-reply-instr" rows="1" placeholder="${esc(reply.hint || (reply.text.trim() ? FOLLOW_UP_HINT : "Peça à IA: ex. diga que posso hoje às 14h…"))}" title="Enter gera · Shift+Enter quebra linha · selecione um trecho do e-mail ou do rascunho para citar" ${reply.busy ? "disabled" : ""}>${esc(reply.instr)}</textarea>
            ${genBtnHTML()}
          </div>
        </div>
        <div class="cmp-tools">
          <button type="button" class="cmp-tool" id="cp-reply-regen" title="Regenerar (sem instrução)" aria-label="Regenerar" ${reply.busy ? "disabled" : ""}>${ic("refresh", { size: 18 })}</button>
          <button type="button" class="cmp-tool" id="cp-reply-learn" title="Aprender" aria-label="Aprender">${ic("learn", { size: 18 })}</button>
          <button type="button" class="cmp-tool" id="cp-chat-reset" title="Limpar a conversa com a IA e o rascunho" aria-label="Limpar conversa" ${reply.busy || (!nChat && !reply.text.trim()) ? "disabled" : ""}>${ic("trash", { size: 18 })}</button>
          <button type="button" class="cmp-tool" id="cp-reply-attach" title="Anexar arquivo (vai no envio e a IA vê o conteúdo quando der)" aria-label="Anexar arquivo" ${reply.busy ? "disabled" : ""}>${ic("attach", { size: 18 })}</button>
          <input type="file" id="cp-reply-file" multiple hidden />
          <a class="cmp-tool" href="/mail/${encodeURIComponent(it.thread_id)}" title="Abrir no /mail (exportar contexto)" aria-label="Abrir no /mail">${ic("mail", { size: 18 })}</a>
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
  async function loadReplyAttachments(tid) {
    if (!reply || reply.tid !== tid) return;
    const r = await api(`/api/threads/${encodeURIComponent(tid)}/attachments`);
    if (!reply || reply.tid !== tid) return;
    reply.files = r.ok ? (r.data.files || []) : [];
    const box = $("cp-attach-list");
    if (!box) return;
    box.classList.toggle("hidden", !reply.files.length);
    box.innerHTML = window.Composer ? window.Composer.attachChipsHTML(reply.files) : "";
    bindAttachChips(tid);
  }
  function bindAttachChips(tid) {
    const box = $("cp-attach-list");
    if (!box) return;
    box.querySelectorAll("[data-attach-rm]").forEach((btn) => {
      btn.onclick = async () => {
        await api(`/api/threads/${encodeURIComponent(tid)}/attachments/${encodeURIComponent(btn.dataset.attachRm)}`, "DELETE");
        loadReplyAttachments(tid);
      };
    });
    box.querySelectorAll("[data-attach-insert]").forEach((btn) => {
      btn.onclick = () => {
        const ta = $("cp-reply-text");
        if (window.Composer && ta) window.Composer.insertAttachRef(ta, btn.dataset.attachInsert);
        if (ta) { reply.text = ta.value; $("cp-reply-send").disabled = !(canSend && reply.text.trim()); }
      };
    });
  }
  async function uploadReplyFiles(tid, fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      try {
        await fetch(`/api/threads/${encodeURIComponent(tid)}/attachments`, { method: "POST", body: form });
      } catch (_) { toast("Falha ao anexar " + (file.name || "arquivo") + "."); }
    }
    await loadReplyAttachments(tid);
  }
  function bindReply(it) {
    if (!reply || !reply.open || !$("cp-reply")) return;
    const ta = $("cp-reply-text");
    const rcPaint = bindRc($("cp-reply"), it, "cp", () => $("cp-rc-sug"));
    ta.oninput = () => {
      reply.text = ta.value; reply.status = ""; reply.draftLoading = false;
      $("cp-reply-send").disabled = !(canSend && reply.text.trim());
      $("cp-reply-status").textContent = "";
      syncGen();
      if (rcPaint) rcPaint(); // saudação mudou -> confere com o Para
      if (window.DraftPersist) window.DraftPersist.schedule(reply.tid, reply.text);
    };
    // "Isso parece uma instrução": o texto vai para o campo da IA, a caixa volta
    // ao último rascunho da IA (ou vazia) e gera. Nada é enviado.
    $("cp-instr-sug-yes").onclick = () => {
      reply.instr = reply.text.trim();
      reply.text = reply.aiText || "";
      if (window.DraftPersist) window.DraftPersist.schedule(reply.tid, reply.text);
      generate(it, true);
    };
    $("cp-instr-sug-no").onclick = () => { reply.sugOff = reply.text; syncGen(); };
    const tgClear = $("cp-target-clear");
    if (tgClear) tgClear.onclick = () => clearTarget(it);
    $("cp-reply").querySelectorAll("[data-rmode]").forEach((b) => (b.onclick = () => {
      reply.all = b.dataset.rmode === "all";
      if (reply.target) reply.target.all = reply.all;
      if (reply.rc) reply.rc.cc = rcDefaults(it).cc; // Responder / a todos: refaz só o Cc
      renderDetail(it);
    }));
    renderChatBox(it);
    $("cp-chat-box").ontoggle = () => { reply.chatOpen = $("cp-chat-box").open; };
    $("cp-chat-reset").onclick = async () => {
      if (!(await window.Dialog.confirm({ title: "Limpar conversa e rascunho?", body: "Apaga a conversa com a IA e o rascunho deste e-mail (aqui e no /mail). Não dá para desfazer.", ok: "Limpar", cancel: "Cancelar", danger: true }))) return;
      const r = await api(`/api/threads/${encodeURIComponent(it.thread_id)}/chat/reset`, "POST");
      if (!r.ok) { toast(r.data.detail || "Não deu para limpar."); return; }
      reply.chat = []; reply.text = ""; reply.aiText = ""; reply.status = "Conversa limpa."; reply.draftLoading = false; shown.draft = ""; shown.chat = [];
      if (window.DraftPersist) window.DraftPersist.cacheClear(it.thread_id);
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
    instr.oninput = () => { reply.instr = instr.value; fit(); syncGen(); };
    // "Usar meu texto (só corrigir)": o campo da IA vira o e-mail, só corrigido
    $("cp-keep").onclick = () => { reply.keepText = !(reply.keepText || keepAuto()); if (!reply.keepText) reply.keepOff = reply.instr; syncGen(); instr.focus({ preventScroll: true }); };
    // "Corrigir português" do rascunho inteiro (nada de reescrever)
    $("cp-fixpt").onclick = () => fixDraft(it);
    instr.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (genReady()) generate(it, true); }
    };
    $("cp-reply-gen").onclick = () => {
      if (genMode() === "instr") generate(it, true);
      else if (genMode() === "improve") generate(it, true, { instruction: reply.text.trim(), currentDraft: reply.aiText });
    };
    // Anexos: mesmos endpoints do /mail (pasta draft-attachments).
    const attachBtn = $("cp-reply-attach");
    const fileInp = $("cp-reply-file");
    if (attachBtn && fileInp) {
      attachBtn.onclick = () => fileInp.click();
      fileInp.onchange = async () => {
        await uploadReplyFiles(it.thread_id, fileInp.files);
        fileInp.value = "";
      };
    }
    bindAttachChips(it.thread_id);
    if (!reply.files || !reply.files.length) loadReplyAttachments(it.thread_id);
    else bindAttachChips(it.thread_id);
    // Colar imagem na instrução → vira anexo (texto puro não embute imagem).
    instr.onpaste = async (e) => {
      const items = [...(e.clipboardData ? e.clipboardData.items : [])];
      const imgs = items.filter((x) => x.type.startsWith("image/"));
      if (!imgs.length) return;
      e.preventDefault();
      const files = imgs.map((x, i) => {
        const blob = x.getAsFile();
        if (!blob) return null;
        const ext = (blob.type || "").split("/")[1] || "png";
        return new File([blob], `colado-${Date.now()}-${i}.${ext}`, { type: blob.type });
      }).filter(Boolean);
      await uploadReplyFiles(it.thread_id, files);
      toast(files.length === 1 ? "Imagem anexada." : files.length + " imagens anexadas.");
    };
  }
  // Chips numerados das citações: trecho curto + comentário; clicar edita, × remove
  // (os cliques são tratados no annotate.js via data-annot-open / data-annot-rm).
  // (mesmo desenho do /mail: Composer.annotChipsHTML em static/composer.js)
  const annotsHTML = () => window.Composer.annotChipsHTML(annot.list());
  function renderAnnots() {
    const box = $("cp-annots");
    if (box) box.innerHTML = annotsHTML();
    syncGen();
  }
  const FOLLOW_UP_HINT = "Quer mudar algo? ex. mais curto, cite o CAF…";
  const genReady = () => !!reply && !reply.busy && !!(reply.instr.trim() || annot.count());
  const draftEdited = () => !!reply && !!reply.text.trim() && reply.text !== reply.aiText;
  // Botão da IA sempre visível: "Gerar"/"Ajustar" com texto no campo da IA;
  // campo vazio mas rascunho editado → "Melhorar com IA" (o rascunho vira o pedido).
  function genMode() {
    if (!reply || reply.busy) return "off";
    if (genReady()) return "instr";
    return draftEdited() ? "improve" : "off";
  }
  // pedido no formato "escreva da mesma forma: …" (e o Leo não desligou o chip)
  const keepAuto = () => !!reply && !reply.keepText && reply.keepOff !== reply.instr && !!window.Composer.keepTextRequest(reply.instr);
  const keepOn = () => !!reply && (reply.keepText || keepAuto());
  function genLabel() {
    if (reply && reply.busy) return [keepOn() ? "Corrigindo…" : reply.text.trim() ? "Ajustando…" : "Gerando…", "A IA está escrevendo o rascunho"];
    const mode = genMode();
    if (mode === "instr" && keepOn()) return ["Usar meu texto", "Seu texto vai para o rascunho; a IA só corrige o português"];
    if (mode === "improve") return ["Melhorar com IA", "Melhorar com IA: usa o texto do rascunho como pedido"];
    return reply.text.trim() ? ["Ajustar", "Ajustar o rascunho com o pedido"] : ["Gerar", "Gerar o rascunho com o pedido"];
  }
  function genBtnHTML() {
    const [label, tip] = genLabel();
    return `<button type="button" class="cmp-gen${genMode() === "improve" ? " improve" : ""}${reply && reply.busy ? " busy" : ""}" id="cp-reply-gen" title="${esc(tip)}" ${genMode() === "off" ? "disabled" : ""}>${ic("sparkles", { size: 16 })}<span>${esc(label)}</span></button>`;
  }
  // Rascunho digitado com cara de pedido à IA (e o campo da IA vazio).
  const instrSuggest = () => !!reply && !reply.busy && !reply.instr.trim() && draftEdited()
    && reply.sugOff !== reply.text && !!(window.Composer && window.Composer.looksLikeInstruction(reply.text));
  // Atualiza botão + chip sem re-renderizar (o foco/cursor continuam onde estão).
  function syncGen() {
    const gen = $("cp-reply-gen");
    if (gen) {
      const [label, tip] = genLabel();
      gen.disabled = genMode() === "off";
      gen.classList.toggle("improve", genMode() === "improve");
      gen.title = tip;
      gen.querySelector("span").textContent = label;
    }
    const sug = $("cp-instr-sug");
    if (sug) sug.classList.toggle("hidden", !instrSuggest());
    const keep = $("cp-keep");
    if (keep) {
      const tmp = document.createElement("div");
      tmp.innerHTML = window.Composer.keepChipHTML("cp-keep", reply.keepText, keepAuto());
      keep.innerHTML = tmp.firstChild.innerHTML;
      keep.setAttribute("aria-pressed", tmp.firstChild.getAttribute("aria-pressed"));
    }
  }
  // "Corrigir português" do rascunho inteiro: só ortografia/gramática/pontuação.
  // As palavras alteradas brilham uns segundos; Desfazer / Ctrl+Z voltam o texto.
  async function fixDraft(it) {
    if (!reply || reply.busy || reply.fixing || !reply.text.trim()) return;
    const tid = it.thread_id;
    const sent = reply.text;
    reply.fixing = true; reply.status = "";
    const btn = $("cp-fixpt");
    if (btn) { btn.disabled = true; btn.classList.add("busy"); btn.querySelector("span").textContent = "Corrigindo…"; }
    $("cp-reply-status").textContent = "Corrigindo o português…";
    let data = null;
    let err = "";
    try { data = await window.Composer.fixPortuguese(tid, { text: sent }); } catch (e) { err = e.message; }
    if (!reply || reply.tid !== tid) return;
    reply.fixing = false;
    const ta = $("cp-reply-text");
    const b = $("cp-fixpt");
    if (b) { b.disabled = !reply.text.trim() || reply.busy; b.classList.remove("busy"); b.querySelector("span").textContent = "Corrigir português"; }
    const say = (t) => { reply.status = t; if ($("cp-reply-status")) $("cp-reply-status").textContent = t; };
    if (err) { say(err); return; }
    if (!ta || ta.value !== sent) { say("O rascunho mudou enquanto a IA corrigia; nada foi trocado."); return; }
    if (!data.changed || data.text === sent) { say("Nada para corrigir: o português já está certo."); return; }
    const n = annot.replaceText(ta, 0, sent.length, data.text);
    say("");
    annot.notice(`Português corrigido (${n === 1 ? "1 mudança" : `${n} mudanças`}). Tom e conteúdo mantidos.`, () => annot.undo());
  }
  async function loadRecipients(it) {
    if (reply.recipients) return;
    const r = await api(`/api/threads/${encodeURIComponent(it.thread_id)}/recipients`);
    if (!reply || reply.tid !== it.thread_id) return;
    reply.recipients = r.ok ? Object.assign({ to: [], cc: [] }, r.data) : { to: [], cc: [] };
    if (shown && shown.thread_id === it.thread_id) renderDetail(shown);
  }
  // opts.text: rascunho que a ação acabou de preparar (Aplicar / Cobrar);
  // sem ele, usa o rascunho salvo e só gera se não houver nenhum.
  function openReply(it, opts) {
    opts = opts || {};
    syncReply(it);
    reply.open = true;
    if (opts.text) { reply.text = opts.text; reply.aiText = opts.text; reply.status = opts.status || ""; reply.draftLoading = false; }
    if (opts.cc) reply.extraCc = opts.cc;
    if (!reply.text.trim() && !opts.text) {
      const known = knownDraftText(it);
      if (known) { reply.text = known; reply.aiText = known; reply.draftLoading = false; }
      else { reply.draftLoading = true; prefetchDraft(it); }
    }
    renderDetail(shown && shown.thread_id === it.thread_id ? shown : it);
    loadRecipients(it);
    const box = $("cp-reply");
    if (box && !opts.noScroll) box.scrollIntoView({ behavior: "smooth", block: "start" });
    if (!reply.text.trim() && !reply.draftLoading && !opts.noGenerate) regenerate(it);
    else if (opts.focusInstr && $("cp-reply-instr")) $("cp-reply-instr").focus({ preventScroll: true });
    else if ($("cp-reply-text")) $("cp-reply-text").focus({ preventScroll: true });
  }
  // "Responder com IA" (card "O que eu faria" e barra inferior): abre o composer
  // com a instrução focada. Se a IA precisa de contexto, não gera rascunho
  // vazio: mostra a pergunta dela como dica e espera a ideia do Leo.
  function openAiReply(it) {
    if (!it.needs_context) { openReply(it, { focusInstr: true }); return; }
    syncReply(it);
    reply.hint = "Dê o contexto ou sua ideia e eu escrevo o rascunho";
    reply.ask = it.pergunta || it.o_que_falta || "";
    openReply(it, { focusInstr: true, noGenerate: true });
  }
  const regenerate = (it) => generate(it, false);
  // withInstruction=false: Regenerar (sem instrução). true: Gerar/Ajustar com a
  // ideia principal + citações numeradas (Annotate.compose, o mesmo texto do /mail).
  // o.instruction: "Melhorar com IA" -- o texto do rascunho vira o pedido e o
  // último rascunho da IA (o.currentDraft) vai como "Rascunho anterior".
  async function generate(it, withInstruction, o) {
    if (reply.busy) return;
    o = o || {};
    const fromDraft = !!o.instruction;
    const instruction = fromDraft ? o.instruction : withInstruction ? window.Annotate.compose(reply.instr, annot.list()) : "";
    if (withInstruction && !instruction) return;
    const edited = reply.text.trim() && reply.text !== reply.aiText;
    const keep = withInstruction && !fromDraft && keepOn();
    if (edited && !fromDraft && !keep) {
      const ok = await window.Dialog.confirm(withInstruction
        ? { title: "Usar seu texto como base?", body: "Você editou o rascunho. A IA vai partir do seu texto e aplicar o pedido. O rascunho atual será substituído (dá pra desfazer).", ok: "Aplicar", cancel: "Cancelar" }
        : { title: "Trocar pelo rascunho novo?", body: "Você editou o rascunho. A IA vai escrever uma versão nova e ela substitui o seu texto (dá pra desfazer).", ok: "Gerar novo", cancel: "Cancelar" });
      if (!ok || !reply || reply.tid !== it.thread_id || reply.busy) return;
    }
    const tid = it.thread_id;
    const before = reply.text; // para o Desfazer, se a IA trocar o texto editado
    reply.busy = true; reply.status = "";
    if (withInstruction) reply.chatOpen = true; // a bolha do pedido + "escrevendo" ficam à vista
    // bolha do pedido = o texto que vai para a IA (citações listadas; ChatUI encurta o trecho)
    reply.pending = withInstruction ? instruction : "";
    renderDetail(shown);
    // mesma geração do /mail (assistant.draft): o rascunho fica salvo na thread.
    // Com instrução, o texto atual da caixa vai como "Rascunho anterior".
    const body = { instruction, comment: "" };
    // respondendo a uma mensagem específica: a IA foca nela (o resto é contexto)
    if (reply.target) {
      body.alvo_idx = reply.target.idx;
      if (reply.target.id) body.reply_to_message_id = reply.target.id;
    }
    const prev = fromDraft ? (o.currentDraft || "") : reply.text;
    if (instruction && prev.trim()) body.current_draft = prev;
    // "Usar meu texto": o pedido inteiro é o e-mail (sem citações), só corrigido
    if (keep && reply.keepText) { body.keep_text = true; body.instruction = reply.instr.trim() || instruction; }
    const r = await api(`/api/threads/${encodeURIComponent(tid)}/draft`, "POST", body);
    if (!reply || reply.tid !== tid) return;
    reply.busy = false; reply.pending = "";
    if (r.ok && Array.isArray(r.data.chat)) { reply.chat = r.data.chat.slice(); shown.chat = reply.chat; }
    const last = r.ok ? (r.data.chat || []).slice(-1)[0] : null;
    if (!r.ok) reply.status = r.data.detail || "Falha no rascunho.";
    // pergunta pra IA (kind=answer): a resposta aparece na conversa, o rascunho fica
    else if (last && last.kind === "answer") { reply.chatOpen = true; reply.status = "A IA respondeu na conversa acima; o rascunho da caixa continua o mesmo."; }
    else if (r.data.draft) {
      reply.text = r.data.draft; reply.aiText = r.data.draft; shown.draft = r.data.draft; reply.draftLoading = false;
      if (window.DraftPersist) window.DraftPersist.remember(tid, r.data.draft);
      // "Responda a Paulo": lembra o pedido para o aviso de destinatário (o
      // servidor também manda a sugestão pronta quando acha a pessoa)
      if (window.Recipients.instructionTarget(instruction).para) reply.rcInstr = instruction;
      const sd = r.data.sugestao_destinatarios;
      if (sd && sd.email && !rcState(it).participants.some((p) => lower(p.email) === sd.email)) reply.rc.participants.push({ email: sd.email, name: sd.nome || "" });
      if (edited && !fromDraft && before !== r.data.draft) {
        annot.notice("Rascunho substituído pela versão da IA.", () => {
          if (!reply || reply.tid !== tid) return;
          reply.text = before; reply.status = "Voltou o seu texto.";
          if (window.DraftPersist) window.DraftPersist.schedule(tid, before);
          if (shown && shown.thread_id === tid) renderDetail(shown);
        });
      }
      if (r.data.unchanged) reply.status = "A IA devolveu o mesmo texto. Tente pedir de outro jeito (ex. \"acrescente no fim: faz sentido?\").";
      if (r.data.keep_text) reply.keepResult = { original: r.data.original || "", draft: r.data.draft, corrigido: !!r.data.corrigido, aviso: r.data.aviso || "" };
    }
    else reply.status = (last && last.text) || "A IA não devolveu rascunho.";
    if (r.ok && withInstruction) { reply.instr = ""; reply.hint = ""; reply.ask = ""; reply.keepText = false; reply.keepOff = ""; annot.clear(); }
    const kr = reply.keepResult;
    reply.keepResult = null;
    if (kr) reply.status = kr.aviso || (kr.corrigido ? "Seu texto foi para o rascunho, só com o português corrigido." : "Seu texto foi para o rascunho como está (nada a corrigir).");
    if (!shown || shown.thread_id !== tid) return;
    renderDetail(shown);
    // "Usar meu texto": destaca o que a correção mudou; Desfazer volta o texto sem correção
    const kta = $("cp-reply-text");
    if (kr && kta && kr.corrigido && kr.original && kta.value === kr.draft) {
      const n = annot.flashChanges(kta, kr.original, kr.draft, 0);
      annot.setUndo(kta, kr.original);
      annot.notice(`Usei seu texto, só com o português corrigido (${n === 1 ? "1 mudança" : `${n} mudanças`}).`, () => annot.undo());
    }
    // pronto para o próximo pedido: campo da IA focado e a conversa no fim
    const instr = $("cp-reply-instr");
    if (r.ok && instr) {
      instr.focus({ preventScroll: true });
      if (instr.scrollIntoView) instr.scrollIntoView({ block: "nearest" });
    }
    const chat = $("cp-chat");
    if (chat) chat.scrollTop = chat.scrollHeight;
  }
  // Confirmação de envio (Dialog): Para/Cc em chips (os mesmos do composer),
  // aviso se a saudação não bate com o Para, assunto, anexos, prévia e
  // "ação definitiva". Só envia no "Enviar agora"; erro mantém o diálogo aberto.
  async function confirmSend(it) {
    const text = reply.text.trim();
    if (!text) return;
    if (!canSend) { toast("Reautorize o Gmail (Entrar no Gmail) para poder enviar."); return; }
    annot.dismissNotice(); // "Trecho reescrito · Desfazer" não fica por cima da confirmação
    if (window.DraftPersist) await window.DraftPersist.flush(it.thread_id, text);
    const tid = it.thread_id;
    const att = await api(`/api/threads/${encodeURIComponent(tid)}/attachments`);
    const files = att.ok ? (att.data.files || []) : [];
    const mentions = /anex/i.test(text) && !files.length;
    const subject = it.subject || "(sem assunto)";
    const offline = !!(window.NetStatus && window.NetStatus.isOffline());
    const rc = rcState(it);
    let result = null;
    const target = reply.target;
    const html = `
      ${rcHTML(it, "sd")}
      <div id="sd-rc-sug"></div>
      <div class="dlg-rows">${target ? `<b>Respondendo a</b><span>${esc(target.label || "mensagem escolhida")}</span>` : ""}<b>Assunto</b><span>${esc(/^re:/i.test(subject) ? subject : `Re: ${subject}`)}</span>
        <b>Anexos</b><span>${files.length ? files.map((f) => esc(f.name)).join(", ") : "nenhum"}</span></div>
      <div class="dlg-pre">${esc(text)}</div>
      ${mentions ? '<p class="dlg-warn">⚠️ O texto fala em anexo, mas nenhum arquivo foi anexado a esta resposta.</p>' : ""}
      ${offline ? `<p class="dlg-warn">${esc(window.NetStatus.message(window.NetStatus.state.status === "auth_error" ? "auth_error" : "offline"))}</p>` : ""}
      <p class="dlg-note">${offline ? "Ao confirmar, a resposta vai para a fila de envio e sai sozinha quando a conexão voltar (dá para cancelar até lá)." : "O e-mail sai na hora e não dá para desfazer."}</p>`;
    const res = await window.Dialog.open({
      title: "Enviar e-mail?", html, wide: true, cancel: "Voltar e editar", ok: offline ? "Pôr na fila de envio" : "Enviar agora",
      onOpen: (box) => bindRc(box, it, "sd", () => box.querySelector("#sd-rc-sug")),
      beforeOk: async (box) => {
        const bad = window.Recipients.commitInputs(box, rc);
        if (bad) return bad;
        if (!rc.to.length) return "Coloque pelo menos uma pessoa no Para.";
        if (mentions && !(await window.Dialog.confirm({ title: "Enviar sem anexo?", body: "O texto fala em anexo, mas nenhum arquivo foi anexado a esta resposta.", ok: "Enviar sem anexo", cancel: "Voltar" }))) return false;
        const payload = { text, to: rc.to.slice(), cc: rc.cc.join(", "), source: "copilot" };
        if (target) {
          // id do Gmail da mensagem escolhida (In-Reply-To/References dela)
          if (!target.id) {
            const meta = await window.MsgReply.load(tid, true);
            const m = meta && meta[target.idx];
            if (m) target.id = m.id || "";
          }
          if (!target.id) return "Não deu para identificar no Gmail a mensagem que você escolheu. Tente de novo ou clique em \"voltar para a última\".";
          payload.reply_to_message_id = target.id;
        }
        const go = box.querySelector(".dlg-ok");
        go.textContent = "Enviando…";
        const r = await api(`/api/threads/${encodeURIComponent(tid)}/send`, "POST", payload);
        go.textContent = offline ? "Pôr na fila de envio" : "Enviar agora";
        if (!r.ok) return r.data.detail || "Falha ao enviar.";
        result = r.data;
        return null;
      },
    });
    if (!res.ok || !result) return;
    afterSend(tid, result, rc);
  }
  // Depois do envio: com "Ao enviar, marcar como resolvido e voltar ao quadro"
  // (padrão), fecha o detalhe e volta ao quadro; senão fica na thread.
  function afterSend(tid, data, rc) {
    annot.dismissNotice();
    const to = data.to || rc.to.join(", ");
    const cc = data.queued ? rc.cc.join(", ") : data.cc;
    const who = `${to}${cc ? ` (Cc: ${cc})` : ""}`;
    const back = prefs.send_resolve_back !== false;
    if (window.NetStatus) window.NetStatus.refresh();
    if (!data.queued && window.DraftPersist) window.DraftPersist.cacheClear(tid);
    if (reply && reply.tid === tid) { annot.clear(); reply = null; }
    if (window.MsgReply) window.MsgReply.invalidate(tid); // a resposta é mensagem nova na thread
    if (data.queued) toast(`Na fila de envio para ${who}. ${data.message || "Sai quando a conexão voltar."}${back ? " · Resolve quando sair" : ""}`);
    else toast(back ? `Enviado para ${who} · Resolvido` : `Enviado para ${who}.`);
    if (back) { if (current === tid) closeDetail(); }
    else if (current === tid) open(tid, true);
    load();
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
    // Prefetch do rascunho já ao abrir o detalhe (não espera Responder).
    const listHit = findCardItem(id);
    const cached = window.DraftPersist ? window.DraftPersist.cacheGet(id) : null;
    if (listHit || cached) {
      const seed = Object.assign({}, listHit || { thread_id: id, subject: "…" }, {
        draft: cached || (listHit && listHit.draft) || "",
        _draftPending: !(cached || (listHit && listHit.draft)),
        chat: (listHit && listHit.chat) || [],
      });
      if (!shown || shown.thread_id !== id) renderDetail(seed);
      else { shown.draft = seed.draft; syncReply(shown); }
    }
    const draftP = window.DraftPersist ? window.DraftPersist.prefetch(id) : Promise.resolve(null);
    const r = await api(`/api/copilot/${encodeURIComponent(id)}`);
    if (!r.ok) { toast(r.data.detail || "Falha ao abrir."); return; }
    if (current !== id) return; // outro cartão foi aberto enquanto carregava
    const pre = await draftP;
    if (pre != null && !(r.data.draft || "").trim() && pre.trim()) r.data.draft = pre;
    if ((r.data.draft || "").trim() && window.DraftPersist) window.DraftPersist.remember(id, r.data.draft);
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
    flushReplyDraft();
    $("cp-detail").classList.remove("open");
    $("cp-scrim").classList.remove("open");
    document.body.classList.remove("cp-page");
    if (layout() === "kanban" || mode !== "quadro") { current = null; renderList(); }
  }
  function closeDetail() {
    flushReplyDraft();
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
      <label class="cp-radio"><input type="checkbox" id="pf-sendback" ${p.send_resolve_back !== false ? "checked" : ""}><span>Ao enviar, marcar como resolvido e voltar ao quadro<small>Desligado: depois de enviar você continua na conversa.</small></span></label>
      <label class="cp-radio"><input type="checkbox" id="pf-celebrate" ${p.celebrate_zero !== false ? "checked" : ""}><span>Comemorar quando zerar a caixa<small>Uma praia quando a caixa inteira zerar (todas as colunas). Desligado: só o texto de vazio.</small></span></label>
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
      const s = await api("/api/copilot/settings", "POST", { skin, digest_daily: $("pf-daily").value, digest_weekly_day: Number($("pf-wday").value), digest_weekly_time: $("pf-wtime").value, digest_enabled: $("pf-on").checked, show_all: $("pf-all").checked, show_tasks_card: $("pf-tasks").checked, show_facts_card: $("pf-facts").checked, send_resolve_back: $("pf-sendback").checked, celebrate_zero: $("pf-celebrate").checked });
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
  // wide: modal largo de leitura no desktop / tela cheia no celular (resumo detalhado)
  // wide === "full": tela cheia também no desktop (verificador)
  function sheet(html, wide) {
    $("cp-sheet-body").innerHTML = html;
    $("cp-sheet").classList.toggle("cp-sheet-wide", !!wide);
    $("cp-sheet").classList.toggle("cp-sheet-full", wide === "full");
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
    if (query) { $("cp-q").value = ""; setQuery(""); }
    if (mode !== "quadro") { setMode("quadro"); }
    if (layout() === "kanban") {
      const col = $("cp-board").querySelector(`[data-col="${c.dataset.tab}"]`);
      if (col) { col.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" }); col.classList.remove("flash"); void col.offsetWidth; col.classList.add("flash"); }
      return;
    }
    tab = c.dataset.tab; sessionStorage.setItem("cp_tab", tab); renderList();
  }));
  $("cp-views").onclick = (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b) return;
    if (query) { $("cp-q").value = ""; setQuery(""); } // escolher uma view sai da busca
    setMode(b.dataset.mode);
  };
  $("cp-hist").onclick = (e) => { if (handleCardActEvent(e)) return; const li = e.target.closest("[data-id]"); if (li) open(li.dataset.id); };
  $("cp-hist").onkeydown = (e) => { if (handleCardActEvent(e)) return; const li = e.target.closest("[data-id]"); if (li && e.key === "Enter") open(li.dataset.id); };
  $("cp-found").onclick = $("cp-hist").onclick;
  $("cp-found").onkeydown = $("cp-hist").onkeydown;
  $("cp-q").value = query;
  document.body.dataset.search = query ? "1" : "";
  $("cp-q-x").classList.toggle("hidden", !query);
  if (query) runSearch();
  $("cp-q").addEventListener("input", (e) => setQuery(e.target.value));
  $("cp-q").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.target.value = ""; setQuery(""); }
    else if (e.key === "Enter") { e.preventDefault(); clearTimeout(searchTimer); runSearch(); }
  });
  $("cp-q-x").onclick = () => { $("cp-q").value = ""; setQuery(""); $("cp-q").focus(); };
  $("cp-list").onclick = (e) => { if (handleResolveAll(e) || handleCardActEvent(e)) return; const li = e.target.closest("[data-id]"); if (li) open(li.dataset.id); };
  $("cp-list").onkeydown = (e) => { if (handleCardActEvent(e)) return; const li = e.target.closest("[data-id]"); if (li && e.key === "Enter") open(li.dataset.id); };
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
    if (data.tabs.length && prefs.celebrate_zero === false) renderList(); // praia → texto simples
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
  window.addEventListener("pagehide", flushReplyDraft);
  window.addEventListener("beforeunload", flushReplyDraft);
  load();
  // deep link /copilot/{id}: abre o detalhe direto (página inteira no desktop)
  if (pathId()) open(pathId(), true);
})();
