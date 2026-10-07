// Peças do composer compartilhado (/mail, /compose, /copilot); o visual está
// em static/composer.css e o chat em static/chat.js.
(function () {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

  // Chips numerados das citações (Annotate): trecho curto + comentário;
  // clicar edita, × remove (cliques tratados no annotate.js).
  function annotChipsHTML(list) {
    return (list || []).map((a, i) => `<span class="cmp-annot${a.source === "draft" ? " draft" : ""}" data-annot-open data-annot-id="${a.id}" role="button" tabindex="0"
        title="${esc(`${a.source === "draft" ? "Trecho do rascunho" : "Trecho do e-mail"}: “${a.quote}”${a.comment ? ` — ${a.comment}` : ""} (clique para editar)`)}">
        <b>${i + 1}</b><span class="cmp-annot-q">${a.source === "draft" ? "rascunho: " : ""}“${esc(short(a.quote, 48))}”</span>${a.comment ? `<span class="cmp-annot-c">${esc(short(a.comment, 48))}</span>` : ""}
        <button type="button" class="cmp-annot-x" data-annot-rm="${a.id}" aria-label="Remover citação ${i + 1}">×</button></span>`).join("");
  }

  // textarea da instrução cresce com o texto (até max px)
  function fit(ta, max) {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, max || 200)}px`;
  }

  // Enter gera, Shift+Enter quebra linha (igual em todas as páginas)
  function onEnter(ta, fn) {
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); fn(); }
    });
  }

  // Autosave do rascunho no sqlite (debounced) + cache local. Usado por /mail
  // e /copilot para o texto NÃO viver só na memória/DOM — sobrevive a
  // refresh/restart e pinta na hora ao reabrir (prefetch).
  const DraftPersist = (() => {
    const timers = Object.create(null);
    const lastSent = Object.create(null);
    const inflight = Object.create(null);
    const LS = "ia_email_draft:";
    const url = (tid) => `/api/threads/${encodeURIComponent(tid)}/save-draft`;
    const getUrl = (tid) => `/api/threads/${encodeURIComponent(tid)}/draft`;

    function cacheGet(tid) {
      if (!tid) return null;
      try {
        const v = localStorage.getItem(LS + tid);
        return v == null ? null : v;
      } catch (_) {
        return null;
      }
    }

    function cacheSet(tid, text) {
      if (!tid) return;
      try {
        const body = String(text == null ? "" : text);
        if (body) localStorage.setItem(LS + tid, body);
        else localStorage.removeItem(LS + tid);
      } catch (_) { /* quota / private mode */ }
    }

    function cacheClear(tid) {
      if (!tid) return;
      try { localStorage.removeItem(LS + tid); } catch (_) { /* */ }
      delete lastSent[tid];
    }

    function schedule(tid, text, ms) {
      if (!tid) return;
      cacheSet(tid, text);
      clearTimeout(timers[tid]);
      timers[tid] = setTimeout(() => { flush(tid, text); }, ms == null ? 800 : ms);
    }

    function flush(tid, text) {
      if (!tid) return Promise.resolve(false);
      clearTimeout(timers[tid]);
      delete timers[tid];
      const body = String(text == null ? "" : text);
      cacheSet(tid, body);
      if (lastSent[tid] === body) return Promise.resolve(true);
      lastSent[tid] = body;
      return fetch(url(tid), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body }),
        keepalive: true,
      }).then((r) => r.ok).catch(() => {
        // falhou: libera pra tentar de novo no próximo edit/flush
        if (lastSent[tid] === body) delete lastSent[tid];
        return false;
      });
    }

    function flushBeacon(tid, text) {
      if (!tid) return;
      clearTimeout(timers[tid]);
      delete timers[tid];
      const body = String(text == null ? "" : text);
      cacheSet(tid, body);
      if (lastSent[tid] === body) return;
      lastSent[tid] = body;
      const payload = JSON.stringify({ text: body });
      try {
        if (navigator.sendBeacon) {
          const blob = new Blob([payload], { type: "application/json" });
          if (navigator.sendBeacon(url(tid), blob)) return;
        }
      } catch (_) { /* fallback abaixo */ }
      try {
        fetch(url(tid), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        });
      } catch (_) { /* unload: melhor esforço */ }
    }

    function remember(tid, text) {
      if (!tid) return;
      lastSent[tid] = String(text == null ? "" : text);
      cacheSet(tid, lastSent[tid]);
    }

    // GET rápido (sqlite) quando o endpoint existir; senão cache local.
    // Deduplica chamadas paralelas do mesmo tid (abrir detalhe + Responder).
    function prefetch(tid) {
      if (!tid) return Promise.resolve(null);
      if (inflight[tid]) return inflight[tid];
      const local = cacheGet(tid);
      inflight[tid] = fetch(getUrl(tid), { headers: { Accept: "application/json" } })
        .then(async (r) => {
          if (!r.ok) return local;
          const d = await r.json().catch(() => ({}));
          const text = d.draft == null ? "" : String(d.draft);
          remember(tid, text);
          return text;
        })
        .catch(() => local)
        .finally(() => { delete inflight[tid]; });
      return inflight[tid];
    }

    return { schedule, flush, flushBeacon, remember, cacheGet, cacheClear, prefetch };
  })();

  // Chip "Rascunho salvo" + skeleton na caixa até o texto pintar.
  function draftChipHTML(loading) {
    return `<span class="cmp-draft-chip${loading ? " loading" : ""}" role="status">Rascunho salvo</span>`;
  }

  function draftSkelHTML() {
    return `<div class="cmp-draft-skel" aria-hidden="true"><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>`;
  }

  function setDraftLoading(wrap, on) {
    if (!wrap) return;
    wrap.classList.toggle("loading", !!on);
  }


  // Chips de anexo (lista + remover + inserir referência no textarea).
  function formatSize(bytes) {
    if (!bytes) return "";
    if (bytes < 1024) return bytes + "B";
    return (bytes / 1024).toFixed(0) + "KB";
  }

  function attachChipsHTML(files, opts) {
    opts = opts || {};
    const canInsert = opts.insert !== false;
    return (files || []).map((f) => {
      const name = f.name || "";
      return `<span class="attach-chip cmp-attach-chip" data-name="${esc(name)}">
        📎 ${esc(name)} <span class="size">${esc(formatSize(f.size))}</span>
        ${canInsert ? `<button type="button" class="cmp-attach-ins" data-attach-insert="${esc(name)}" title="Inserir referência no rascunho" aria-label="Inserir ${esc(name)}">↳</button>` : ""}
        <button type="button" data-attach-rm="${esc(name)}" title="Remover anexo" aria-label="Remover ${esc(name)}">×</button>
      </span>`;
    }).join("");
  }

  // Insere "📎 nome" na posição do cursor do textarea (ou no fim).
  function insertAttachRef(ta, filename) {
    if (!ta || !filename) return;
    const ref = "📎 " + filename;
    const start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    const end = ta.selectionEnd == null ? start : ta.selectionEnd;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const padL = before && !/\s$/.test(before) ? " " : "";
    const padR = after && !/^\s/.test(after) ? " " : "";
    ta.value = before + padL + ref + padR + after;
    const pos = (before + padL + ref + padR).length;
    ta.focus();
    try { ta.setSelectionRange(pos, pos); } catch (_) { /* */ }
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Texto do rascunho com cara de pedido à IA ("instrua…", "diga que…",
  // "manda um convite…") em vez de e-mail pronto. Só sugere: e-mail que abre
  // com saudação (Oi/Olá/Bom dia…) não conta, e texto longo também não.
  const INSTR_RE = /\b(instrua|instruir|diga\s+(que|a|pra|para)|diz\s+que|pe[cç]a\s+(que|a|pra|para)|pede\s+pra|responda\s+(que|a|dizendo)|responde\s+que|fale\s+(que|pra|para)|fala\s+que|avise\s+(que|a|pra|para)|avisa\s+que|escreva|convide|convidar|informe\s+que|agrade[cç]a|recuse|confirme\s+que)\b/i;
  // "mande/manda" só no começo ("Manda um convite…"): no meio é e-mail comum ("pode mandar…")
  const INSTR_START_RE = /^\s*(mande|manda|envie|envia)\b/i;
  const GREETING_RE = /^\s*(oi|ol[aá]|bom\s+dia|boa\s+tarde|boa\s+noite|prezad[oa]s?|car[oa]s?|hello|hi|dear)\b/i;
  function looksLikeInstruction(text) {
    const s = String(text || "").trim();
    if (!s || s.length > 600 || GREETING_RE.test(s)) return false;
    return INSTR_RE.test(s) || INSTR_START_RE.test(s);
  }

  window.Composer = { annotChipsHTML, fit, onEnter, short, draftChipHTML, draftSkelHTML, setDraftLoading, attachChipsHTML, insertAttachRef, formatSize, looksLikeInstruction };
  window.DraftPersist = DraftPersist;
})();
