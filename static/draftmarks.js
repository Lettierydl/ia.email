// Destaque de trechos DENTRO do textarea do rascunho (/copilot e /mail).
// Textarea não aceita <span>, então desenhamos uma camada espelho: duas divs
// com a mesma fonte/padding/largura/quebra do textarea (white-space:pre-wrap),
// uma ATRÁS (o <mark> colorido; o textarea fica com fundo transparente) e uma
// NA FRENTE (só o marcador numerado clicável; o resto transparente e sem
// cliques). O texto continua vindo do textarea.value -- a camada só pinta.
//
// Quem usa (static/annotate.js) guarda {start, end, text} de cada trecho e,
// quando o texto muda, chama shift(prev, next, range): o range anda junto se a
// edição foi antes dele, fica onde está se foi depois, e some (null) se a
// edição tocou no trecho. render() ainda confere value.slice(start,end)===text
// antes de pintar: nunca marca texto errado.
(function () {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // Diff mínimo (prefixo e sufixo comuns). caret = posição do cursor depois da
  // edição (desempata texto repetido: "aa" -> "aaa" foi digitado no cursor).
  function diff(prev, next, caret) {
    const delta = next.length - prev.length;
    if (caret != null && caret >= 0 && caret <= next.length) {
      // digitou/colou: o texto novo termina no cursor
      if (delta > 0 && caret >= delta && next.slice(0, caret - delta) === prev.slice(0, caret - delta) && next.slice(caret) === prev.slice(caret - delta)) {
        return { at: caret - delta, oldEnd: caret - delta, newEnd: caret };
      }
      // apagou (Backspace/Delete/recortar): o buraco começa no cursor
      if (delta < 0 && prev.slice(0, caret) === next.slice(0, caret) && prev.slice(caret - delta) === next.slice(caret)) {
        return { at: caret, oldEnd: caret - delta, newEnd: caret };
      }
    }
    const max = Math.min(prev.length, next.length);
    let p = 0;
    while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
    let s = 0;
    while (s < max - p && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
    return { at: p, oldEnd: prev.length - s, newEnd: next.length - s };
  }

  // Range {start,end} depois da troca prev -> next; null se a edição tocou nele.
  function shift(prev, next, range, caret) {
    if (!range || range.start == null) return null;
    if (prev === next) return { start: range.start, end: range.end };
    const d = diff(prev, next, caret);
    if (range.end <= d.at) return { start: range.start, end: range.end };
    if (range.start >= d.oldEnd) {
      const delta = d.newEnd - d.oldEnd;
      return { start: range.start + delta, end: range.end + delta };
    }
    return null;
  }

  const COPY = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "lineHeight", "letterSpacing", "wordSpacing",
    "textTransform", "textIndent", "textAlign", "tabSize", "direction", "boxSizing",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"];

  // Cria (uma vez por textarea) as duas camadas e mantém tamanho/rolagem iguais.
  function attach(ta) {
    if (ta._dm && ta._dm.back.isConnected && ta._dm.front.isConnected) return ta._dm;
    const parent = ta.parentNode;
    if (!parent) return null;
    const mk = (cls) => {
      const el = document.createElement("div");
      el.className = `dm-layer ${cls}`;
      el.setAttribute("aria-hidden", "true");
      el.innerHTML = '<div class="dm-text"></div>';
      return el;
    };
    const back = mk("dm-back");
    const front = mk("dm-front");
    parent.insertBefore(back, ta);
    parent.insertBefore(front, ta.nextSibling);
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    // o fundo do textarea passa para a camada de trás (ele fica transparente)
    const bg = getComputedStyle(ta).backgroundColor;
    ta.classList.add("dm-on");

    function layout() {
      if (!ta.isConnected) return;
      const cs = getComputedStyle(ta);
      for (const el of [back, front]) {
        for (const k of COPY) el.style[k] = cs[k];
        el.style.borderStyle = "solid";
        el.style.borderColor = "transparent";
        el.style.top = `${ta.offsetTop}px`;
        el.style.left = `${ta.offsetLeft}px`;
        el.style.width = `${ta.offsetWidth}px`;
        el.style.height = `${ta.offsetHeight}px`;
        // barra de rolagem do textarea come largura do texto: compensa no padding
        const bar = ta.offsetWidth - ta.clientWidth - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0);
        if (bar > 0) el.style.paddingRight = `${(parseFloat(cs.paddingRight) || 0) + bar}px`;
      }
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") back.style.backgroundColor = bg;
      scroll();
    }
    function scroll() {
      back.scrollTop = ta.scrollTop;
      front.scrollTop = ta.scrollTop;
      back.scrollLeft = ta.scrollLeft;
      front.scrollLeft = ta.scrollLeft;
    }
    ta.addEventListener("scroll", scroll);
    let ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(layout);
      ro.observe(ta);
    }
    window.addEventListener("resize", layout);
    const api = { back, front, layout, scroll, ro, sig: "" };
    ta._dm = api;
    layout();
    return api;
  }

  // marks: [{id, start, end, text, n, cls}] -- só pinta os que conferem com o texto.
  function render(ta, marks) {
    const dm = attach(ta);
    if (!dm) return [];
    const value = ta.value;
    const ok = (marks || [])
      .filter((m) => m.start != null && m.end > m.start && m.end <= value.length && value.slice(m.start, m.end) === m.text)
      .sort((a, b) => a.start - b.start);
    const shown = [];
    let pos = 0;
    let back = "";
    let front = "";
    for (const m of ok) {
      if (m.start < pos) continue; // sobreposto a um anterior: não pinta
      const before = esc(value.slice(pos, m.start));
      const seg = esc(value.slice(m.start, m.end));
      const cls = `dm-mark${m.cls ? ` ${m.cls}` : ""}`;
      const tag = m.busy ? `<span class="dm-busy-tag">${esc(typeof m.busy === "string" ? m.busy : "reescrevendo…")}</span>` : "";
      const num = m.n ? `<span class="dm-num" data-annot-open data-annot-id="${esc(m.id)}" role="button" title="Citação ${m.n} (clique para ver/editar)">${m.n}</span>` : "";
      back += `${before}<mark class="${cls}" data-dm-id="${esc(m.id)}">${seg}</mark>`;
      front += `${before}<mark class="${cls}" data-dm-id="${esc(m.id)}">${seg}${num}${tag}</mark>`;
      shown.push(m);
      pos = m.end;
    }
    // "\n" no fim: o textarea mostra uma linha vazia a mais; o div precisa de algo nela
    const tail = esc(value.slice(pos)) + (value.endsWith("\n") ? "​" : "");
    back += tail;
    front += tail;
    const sig = `${back}\u0000${front}`;
    if (dm.sig !== sig) {
      dm.back.firstChild.innerHTML = back;
      dm.front.firstChild.innerHTML = front;
      dm.sig = sig;
    }
    ta.classList.toggle("dm-has", shown.length > 0);
    dm.layout();
    return shown;
  }

  // Diff por palavras ("Corrigir português"): ranges em `after` das palavras
  // novas/alteradas em relação a `before` (LCS por palavra; vizinhas viram um
  // range só). Palavra só apagada não tem onde pintar: fica de fora.
  function wordDiff(before, after) {
    const toks = (s) => { const out = []; const re = /\S+/g; let m; while ((m = re.exec(s))) out.push({ w: m[0], start: m.index, end: m.index + m[0].length }); return out; };
    const a = toks(before || "");
    const b = toks(after || "");
    if (a.length * b.length > 4e6) return b.length ? [{ start: b[0].start, end: b[b.length - 1].end, text: after.slice(b[0].start, b[b.length - 1].end) }] : [];
    const n = a.length;
    const m = b.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i].w === b[j].w ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const changed = new Array(m).fill(false);
    let i = 0;
    let j = 0;
    while (j < m) {
      if (i < n && a[i].w === b[j].w) { i++; j++; } else if (i < n && L[i + 1][j] >= L[i][j + 1]) i++; else { changed[j] = true; j++; }
    }
    const out = [];
    for (let k = 0; k < m; k++) {
      if (!changed[k]) continue;
      const last = out[out.length - 1];
      if (last && last.k === k - 1) { last.end = b[k].end; last.k = k; } else out.push({ start: b[k].start, end: b[k].end, k });
    }
    return out.map((r) => ({ start: r.start, end: r.end, text: after.slice(r.start, r.end) }));
  }

  window.DraftMarks = { diff, shift, attach, render, wordDiff };
})();
