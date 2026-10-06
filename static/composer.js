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

  window.Composer = { annotChipsHTML, fit, onEnter, short };
})();
