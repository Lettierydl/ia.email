// Imagens inline no corpo do e-mail (como no Gmail), compartilhado entre o
// /mail (app.js) e o /copilot (copilot.js).
//
// O texto da thread vem em texto puro, onde o Gmail troca cada imagem colada
// por "[image: image.png]". O backend (/gmail-attachments, campo `inline`)
// já casa cada placeholder de cada mensagem com o anexo certo (cid do HTML ->
// nome -> ordem). Aqui só trocamos o texto pela miniatura:
//   InlineImg.apply(textEl, {tid, messageId, files, placeholders})
//     -> Set de attachment_id mostrados no corpo (o chamador marca as pills).
//   InlineImg.markPills(cardEl, shownIds): pill do anexo ganha "no corpo".
// Miniatura clicável -> lightbox próprio (Esc/clique fora fecha, setas se
// houver várias, Abrir/Baixar). Imagem que falhar vira pill no lugar e a pill
// lá embaixo perde a marca. Placeholder sem par fica como texto discreto.
// URLs: só as da própria API, montadas aqui com ids codificados.
(function () {
  const PH_RE = /\[(?:image|imagem|img)\s*:\s*([^\]\n]{0,200}?)\s*\]|\[cid:([^\]\s]{1,200})\]/gi;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

  function base(tid, mid) {
    return `/api/threads/${encodeURIComponent(tid)}/gmail-attachments/${encodeURIComponent(mid)}`;
  }
  function imageUrl(tid, mid, attId) {
    return `${base(tid, mid)}/image?${new URLSearchParams({ attachment_id: attId })}`;
  }
  function fileUrl(tid, mid, f, download) {
    const q = new URLSearchParams({ attachment_id: f.attachment_id, filename: f.filename || "imagem" });
    if (download) q.set("download", "1");
    return `${base(tid, mid)}/file?${q}`;
  }
  // Só caminho relativo da nossa API (nada de http:, data:, javascript:...).
  function safe(url) {
    return /^\/api\/threads\/[^/?#]+\/gmail-attachments\//.test(url) ? url : "";
  }

  function textNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest("[data-annot-skip], .ii-wrap, .ii-missing") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function figure(tid, mid, f) {
    const wrap = document.createElement("span");
    wrap.className = "ii-wrap";
    wrap.setAttribute("data-annot-skip", "");
    wrap.setAttribute("contenteditable", "false");
    const a = document.createElement("a");
    a.className = "ii-link";
    a.href = safe(fileUrl(tid, mid, f, false));
    a.target = "_blank";
    a.rel = "noopener";
    a.title = `${f.filename || "imagem"} — clique para ampliar`;
    const img = document.createElement("img");
    img.className = "ii-img";
    img.setAttribute("loading", "lazy"); // antes do src
    img.setAttribute("decoding", "async");
    img.alt = f.filename || "imagem";
    img.dataset.att = f.attachment_id;
    img.dataset.name = f.filename || "imagem";
    img.dataset.open = a.href ? a.getAttribute("href") : "";
    img.dataset.dl = safe(fileUrl(tid, mid, f, true));
    img.src = safe(imageUrl(tid, mid, f.attachment_id));
    img.onerror = () => fail(wrap, img);
    a.appendChild(img);
    a.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // nova aba
      e.preventDefault();
      e.stopPropagation(); // não abre/fecha o card
      open(img);
    });
    wrap.appendChild(a);
    return wrap;
  }

  // Imagem quebrou: no lugar dela, a pill (abre/baixa) e a pill de baixo volta ao normal.
  function fail(wrap, img) {
    if (!wrap.isConnected && !wrap.parentNode) return;
    const pill = document.createElement("a");
    pill.className = "ii-pill";
    pill.href = img.dataset.open || "#";
    pill.target = "_blank";
    pill.rel = "noopener";
    pill.title = `Abrir ${img.dataset.name}`;
    pill.innerHTML = `<span aria-hidden="true">🖼</span> ${esc(img.dataset.name)}`;
    pill.setAttribute("data-annot-skip", "");
    if (wrap.parentNode) wrap.parentNode.replaceChild(pill, wrap);
    const card = pill.closest(".msg-card") || document;
    card.querySelectorAll(`[data-att-id="${cssEsc(img.dataset.att)}"]`).forEach(unmark);
  }
  function cssEsc(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&");
  }

  function missing(token) {
    const s = document.createElement("span");
    s.className = "ii-missing";
    s.title = "Imagem do e-mail original (não veio como anexo)";
    s.textContent = token;
    return s;
  }

  function apply(root, opts) {
    const shown = new Set();
    if (!root || !opts || !opts.tid || !opts.messageId) return shown;
    const list = opts.placeholders || [];
    const byId = {};
    (opts.files || []).forEach((f) => { byId[f.attachment_id] = f; });
    let cursor = 0;
    // casa a ocorrência do DOM com a do backend: mesmo token, a partir do cursor
    const take = (token) => {
      const t = norm(token);
      for (let k = cursor; k < list.length; k++) {
        if (norm(list[k].token) === t) { cursor = k + 1; return list[k]; }
      }
      return null;
    };
    textNodes(root).forEach((node) => {
      const text = node.nodeValue;
      PH_RE.lastIndex = 0;
      if (!PH_RE.test(text)) return;
      PH_RE.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      while ((m = PH_RE.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const hit = take(m[0]);
        const f = hit && hit.attachment_id ? byId[hit.attachment_id] : null;
        if (f && safe(imageUrl(opts.tid, opts.messageId, f.attachment_id))) {
          frag.appendChild(figure(opts.tid, opts.messageId, f));
          shown.add(f.attachment_id);
        } else {
          frag.appendChild(missing(m[0]));
        }
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
    return shown;
  }

  // Pills: a imagem continua listada (para baixar), marcada "no corpo".
  function mark(pill) {
    if (pill.classList.contains("ii-in-body")) return;
    pill.classList.add("ii-in-body");
    const tag = document.createElement("small");
    tag.className = "ii-tag";
    tag.textContent = "no corpo";
    pill.appendChild(tag);
    pill.title = "Esta imagem aparece no corpo do e-mail";
  }
  function unmark(pill) {
    pill.classList.remove("ii-in-body");
    pill.querySelectorAll(".ii-tag").forEach((t) => t.remove());
    pill.removeAttribute("title");
  }
  function markPills(scope, shownIds) {
    if (!scope || !shownIds) return;
    scope.querySelectorAll("[data-att-id]").forEach((p) => {
      if (shownIds.has(p.getAttribute("data-att-id"))) mark(p);
    });
  }

  // ── lightbox ──
  let box = null;
  let gallery = [];
  let at = 0;
  let lastFocus = null;
  function build() {
    box = document.createElement("div");
    box.id = "ii-lightbox";
    box.className = "ii-lb hidden";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Imagem do e-mail");
    box.innerHTML = `<div class="ii-lb-bar">
        <span class="ii-lb-name"></span><span class="ii-lb-count"></span>
        <a class="ii-lb-btn ii-lb-open" target="_blank" rel="noopener">Abrir</a>
        <a class="ii-lb-btn ii-lb-dl">Baixar</a>
        <button type="button" class="ii-lb-btn ii-lb-close" aria-label="Fechar">✕</button>
      </div>
      <button type="button" class="ii-lb-nav ii-lb-prev" aria-label="Imagem anterior">‹</button>
      <img class="ii-lb-img" alt="" />
      <button type="button" class="ii-lb-nav ii-lb-next" aria-label="Próxima imagem">›</button>`;
    document.body.appendChild(box);
    box.addEventListener("click", (e) => {
      if (e.target === box) close(); // clique fora (no fundo) fecha
    });
    box.querySelector(".ii-lb-close").onclick = close;
    box.querySelector(".ii-lb-prev").onclick = (e) => { e.stopPropagation(); go(-1); };
    box.querySelector(".ii-lb-next").onclick = (e) => { e.stopPropagation(); go(1); };
    document.addEventListener("keydown", onKey, true);
  }
  function onKey(e) {
    if (!isOpen()) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); go(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); go(1); }
  }
  function show() {
    const img = gallery[at];
    if (!img) return;
    const view = box.querySelector(".ii-lb-img");
    view.src = img.getAttribute("src");
    view.alt = img.dataset.name || "imagem";
    box.querySelector(".ii-lb-name").textContent = img.dataset.name || "imagem";
    box.querySelector(".ii-lb-count").textContent = gallery.length > 1 ? `${at + 1} de ${gallery.length}` : "";
    const o = box.querySelector(".ii-lb-open");
    const d = box.querySelector(".ii-lb-dl");
    o.href = img.dataset.open || img.getAttribute("src");
    d.href = img.dataset.dl || img.getAttribute("src");
    d.setAttribute("download", img.dataset.name || "imagem");
    box.querySelectorAll(".ii-lb-nav").forEach((b) => b.classList.toggle("hidden", gallery.length < 2));
  }
  function go(step) {
    if (gallery.length < 2) return;
    at = (at + step + gallery.length) % gallery.length;
    show();
  }
  function open(img) {
    if (!box) build();
    const scope = (img.closest(".msg-card") && img.closest(".msg-card").parentElement) || document;
    gallery = [...scope.querySelectorAll("img.ii-img")].filter((i) => i.isConnected);
    at = Math.max(0, gallery.indexOf(img));
    lastFocus = document.activeElement;
    show();
    box.classList.remove("hidden");
    box.querySelector(".ii-lb-close").focus();
  }
  function close() {
    if (!isOpen()) return;
    box.classList.add("hidden");
    box.querySelector(".ii-lb-img").removeAttribute("src");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function isOpen() {
    return !!box && !box.classList.contains("hidden");
  }

  window.InlineImg = { apply, markPills, open, close, isOpen, PH_RE };
})();
