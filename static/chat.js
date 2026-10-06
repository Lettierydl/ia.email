// Chat com a IA para gerar/refinar a resposta -- o mesmo no /mail, no
// /compose e no /copilot. O histórico vem do servidor (/api/threads/{id}/draft
// devolve `chat`): instruções do usuário + respostas da IA, cada uma com
// kind="answer" (resposta em texto a uma pergunta) ou kind="draft" (rascunho,
// que vai para a caixa de texto do composer). kind ausente = rascunho antigo.
(function () {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ico = (name, size) => (window.Icons ? window.Icons.svg(name, { size: size || 14 }) : "");
  const isDraft = (m) => m && m.role === "ai" && !m.placeholder && !m.typing && m.kind !== "answer";

  function lastDraft(history) {
    for (let i = (history || []).length - 1; i >= 0; i--) if (isDraft(history[i])) return history[i].text || "";
    return "";
  }

  // "adicione fulano": resolvido (✓), não achado (aviso) ou ambíguo (botões para escolher)
  function ccResolutionHTML(msg, msgIdx) {
    if (!Array.isArray(msg.cc_resolution) || !msg.cc_resolution.length) return "";
    const rows = msg.cc_resolution.map((entry, ccIdx) => {
      if (entry.chosen) return `<div class="cc-resolution-row done">✓ Copiar: ${esc(entry.chosen)}</div>`;
      if (entry.status === "not_found") return `<div class="cc-resolution-row muted">Não achei e-mail pra "${esc(entry.query)}" — adicione manualmente no Cc ao enviar.</div>`;
      const opts = (entry.candidates || [])
        .map((c) => `<button type="button" data-cc-pick="${msgIdx}:${ccIdx}" data-cc-email="${esc(c.email)}">${esc(c.name || c.email)} &lt;${esc(c.email)}&gt;</button>`)
        .join("");
      return `<div class="cc-resolution-row"><span class="cc-resolution-q">Quem é "${esc(entry.query)}"?</span>
        <div class="cc-resolution-opts">${opts}<button type="button" data-cc-pick="${msgIdx}:${ccIdx}" data-cc-email="">nenhum desses</button></div></div>`;
    }).join("");
    return `<div class="cc-resolution">${rows}</div>`;
  }

  const typingHTML = () => '<div class="chat-msg ai typing" aria-label="A IA está escrevendo" role="status"><span class="bar"></span><span class="bar"></span><span class="bar"></span></div>';

  // opts.compactDrafts: o rascunho aparece resumido (o texto inteiro está na
  // caixa do composer); versões anteriores ganham "Usar esta versão".
  function bubbleHTML(msg, idx, history, opts) {
    if (msg.role === "user") return `<div class="chat-msg user">${esc(msg.text)}</div>`;
    if (msg.typing) return typingHTML();
    if (msg.placeholder) return `<div class="chat-msg ai muted-msg">${esc(msg.text)}</div>`;
    const cc = ccResolutionHTML(msg, idx);
    if (msg.kind === "answer") return `<div class="chat-msg ai answer"><div class="draft-label">${ico("chat")} Resposta</div>${esc(msg.text)}${cc}</div>`;
    if (!opts.compactDrafts) return `<div class="chat-msg ai"><div class="draft-label">${ico("pencil")} Rascunho</div>${esc(msg.text)}${cc}</div>`;
    const n = history.slice(0, idx + 1).filter(isDraft).length;
    const latest = !history.slice(idx + 1).some(isDraft);
    return `<div class="chat-msg ai draft compact${latest ? " latest" : ""}">
      <div class="draft-label">${ico("pencil")} Rascunho ${n}${latest ? " <small>· está na caixa de texto</small>" : ""}</div>
      <div class="chat-draft-preview">${esc(msg.text)}</div>
      ${latest ? "" : `<button type="button" class="chat-use" data-chat-use="${idx}">Usar esta versão</button>`}${cc}</div>`;
  }

  // Desenha o histórico em `el`. opts: compactDrafts, empty (texto sem
  // conversa), onCcPick(msgIdx, ccIdx, email), onUseDraft(text).
  function render(el, history, opts) {
    if (!el) return;
    opts = opts || {};
    history = history || [];
    el.innerHTML = history.length
      ? history.map((m, i) => bubbleHTML(m, i, history, opts)).join("")
      : opts.empty ? `<div class="chat-msg ai muted-msg">${esc(opts.empty)}</div>` : "";
    el.querySelectorAll("[data-cc-pick]").forEach((btn) => (btn.onclick = () => {
      const [msgIdx, ccIdx] = btn.dataset.ccPick.split(":").map(Number);
      const entry = history[msgIdx] && history[msgIdx].cc_resolution && history[msgIdx].cc_resolution[ccIdx];
      if (!entry) return;
      entry.chosen = btn.dataset.ccEmail || "(nenhum)";
      if (opts.onCcPick) opts.onCcPick(msgIdx, ccIdx, btn.dataset.ccEmail || "");
      render(el, history, opts);
    }));
    el.querySelectorAll("[data-chat-use]").forEach((btn) => (btn.onclick = () => {
      const m = history[Number(btn.dataset.chatUse)];
      if (m && opts.onUseDraft) opts.onUseDraft(m.text || "");
    }));
    el.scrollTop = el.scrollHeight;
  }

  window.ChatUI = { render, lastDraft, isDraft, ccResolutionHTML, typingHTML };
})();
