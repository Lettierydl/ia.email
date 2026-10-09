// Selecionar trecho -> anotação ancorada (igual ao Codex), compartilhado entre
// o /mail (app.js) e o /copilot (copilot.js). Seleciona um pedaço do texto,
// aparece a barrinha "Adicionar", o trecho ganha um número (badge azul) e abre
// uma caixinha para comentar. As anotações viram contexto direcionado no
// próximo rascunho, pelo MESMO /api/threads/{id}/draft (campo instruction).
//
// Duas origens de trecho:
//  - "mail": texto do e-mail/resumo (áreas DOM): o trecho é marcado no próprio
//    texto (span.annot-mark + sup.annot-badge);
//  - "draft": seleção DENTRO de um textarea (o rascunho): guarda {start,end}
//    e pinta o trecho numa camada espelho (static/draftmarks.js) com o mesmo
//    número dos chips ([data-annot-open] / [data-annot-rm]). Editar o texto
//    desloca o range; editar DENTRO do trecho tira a marca (nunca marca errado).
//
// No rascunho a barrinha tem também "Reescrever" (opts.rewrite): a IA reescreve
// só o trecho e ele é trocado na hora no textarea (com Desfazer / Ctrl+Z); na
// thread (e-mail recebido) só existe "Comentar para a IA".
//
// Markup esperado na página (mesmos ids do /mail): #select-toolbar com
// #select-add-chat (+ #select-rewrite, opcional) e #annot-popup com
// #annot-popup-textarea, #annot-save, #annot-cancel e #annot-delete.
(function () {
  const byId = (id) => document.getElementById(id);
  const MAX_QUOTE = 600;

  function clip(text) {
    return text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text;
  }

  // Texto que vai para a IA: `[n] Sobre "trecho": comentário` (e-mail recebido,
  // formato de sempre do /mail) ou `[n] Sobre o trecho do rascunho "…": …`.
  function compose(free, list) {
    free = (free || "").trim();
    if (!list || !list.length) return free;
    const notes = list
      .map((a, i) => {
        const where = a.source === "draft" ? "Sobre o trecho do rascunho" : "Sobre";
        return `[${i + 1}] ${where} "${a.quote}": ${a.comment || "(sem comentário)"}`;
      })
      .join("\n");
    return free ? `${notes}\n\n${free}` : notes;
  }

  function wrapRange(range) {
    const mark = document.createElement("span");
    mark.className = "annot-mark";
    try {
      range.surroundContents(mark);
    } catch {
      const frag = range.extractContents();
      mark.appendChild(frag);
      range.insertNode(mark);
    }
    const badge = document.createElement("sup");
    badge.className = "annot-badge";
    mark.insertAdjacentElement("afterend", badge);
    return { mark, badge };
  }

  function unwrap(annot) {
    if (annot.mark && annot.mark.parentNode) {
      const parent = annot.mark.parentNode;
      while (annot.mark.firstChild) parent.insertBefore(annot.mark.firstChild, annot.mark);
      parent.removeChild(annot.mark);
      parent.normalize();
    }
    if (annot.badge && annot.badge.parentNode) annot.badge.remove();
    annot.mark = null;
    annot.badge = null;
  }

  // Acha o trecho de novo (re-render via innerHTML apaga as marcas). O trecho
  // pode cruzar nós de texto (ex.: frase com um link no meio): procura no
  // texto concatenado da área e converte o índice de volta para nó/offset.
  function findRange(root, text) {
    if (!root || !text) return null;
    // [data-annot-skip]: caixa gerada pela IA (ex.: resumo da mensagem) não é o e-mail
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest("[data-annot-skip]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    let all = "";
    let node;
    while ((node = walker.nextNode())) {
      nodes.push({ node, start: all.length });
      all += node.nodeValue;
    }
    const i = all.indexOf(text);
    if (i < 0) return null;
    const at = (pos, isEnd) => {
      for (const n of nodes) {
        const len = n.node.nodeValue.length;
        if (isEnd ? pos <= n.start + len : pos < n.start + len) return [n.node, pos - n.start];
      }
      return null;
    };
    const start = at(i, false);
    const end = at(i + text.length, true);
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start[0], start[1]);
    range.setEnd(end[0], end[1]);
    return range;
  }

  // opts.areas(): elementos onde a seleção vira marca no texto;
  // opts.textareas(): textareas onde a seleção vira trecho "draft";
  // opts.enabled(): se dá pra anotar agora; opts.onChange(list); opts.onAdd(annot);
  // opts.rewrite({draft, start, end, passage, instruction}) -> Promise<replacement>
  // (sem ele, não aparece "Reescrever").
  // opts.fixPortuguese({draft, start, end, passage}) -> Promise<replacement>
  // (sem ele, não aparece "Corrigir português"): só ortografia/pontuação; as
  // palavras alteradas brilham alguns segundos e dá para Desfazer / Ctrl+Z.
  function create(opts) {
    opts = opts || {};
    const areas = opts.areas || (() => []);
    const textareas = opts.textareas || (() => []);
    const enabled = opts.enabled || (() => true);
    const onChange = opts.onChange || (() => {});
    const onAdd = opts.onAdd || (() => {});
    const toolbar = byId("select-toolbar");
    const btn = byId("select-add-chat");
    const popup = byId("annot-popup");
    const textarea = byId("annot-popup-textarea");
    const rwBtn = byId("select-rewrite");
    const fixBtn = byId("select-fixpt");
    let list = [];
    let seq = 0;
    let pending = null; // { range } (área DOM) ou { ta, quote, start, end } (textarea)

    const changed = () => {
      drawDraft();
      onChange(list.slice());
    };

    function renumber() {
      list.forEach((a, i) => {
        if (a.badge) a.badge.textContent = String(i + 1);
      });
      drawDraft();
    }

    // ── trechos do rascunho: ranges que andam com a edição + camada de destaque ──
    const prevVal = Object.create(null); // último valor visto de cada textarea (por id)
    let rwAsk = null; // trecho com o campo "Reescrever" aberto {taId, start, end, text}
    let rw = null; // trecho sendo reescrito pela IA (pulsando)
    let rwDone = null; // trecho recém-trocado (brilha um instante)
    let undo = null; // {taId, before, after, start, replacement, passage, ranges}
    let fixed = []; // palavras trocadas pelo "Corrigir português" (brilham uns segundos)
    let fixedTimer = null;
    const findTa = (id) => textareas().find((t) => t && t.id === id) || null;
    const ranges = () => list.filter((a) => a.source === "draft").concat([rwAsk, rw, rwDone].filter(Boolean), fixed);

    // O valor do textarea mudou desde a última olhada: desloca (ou anula) os ranges.
    function track(ta, caret) {
      const id = ta.id;
      const prev = prevVal[id];
      const next = ta.value;
      if (prev != null && prev !== next && window.DraftMarks) {
        ranges().forEach((r) => {
          if (r.taId !== id || r.start == null) return;
          const s = window.DraftMarks.shift(prev, next, r, caret);
          r.start = s ? s.start : null;
          r.end = s ? s.end : null;
        });
      }
      prevVal[id] = next;
    }

    function drawDraft(caretTa) {
      if (!window.DraftMarks) return;
      const openId = popup.classList.contains("hidden") ? null : Number(popup.dataset.annotId);
      textareas().filter(Boolean).forEach((ta) => {
        track(ta, ta === caretTa ? ta.selectionEnd : null);
        const marks = [];
        list.forEach((a, i) => {
          if (a.source === "draft" && a.taId === ta.id) marks.push({ id: a.id, start: a.start, end: a.end, text: a.text, n: i + 1, cls: openId === a.id ? "dm-active" : "" });
        });
        if (rwAsk && rwAsk.taId === ta.id) marks.push(Object.assign({}, rwAsk, { id: "rw", cls: "dm-active dm-rw" }));
        if (rw && rw.taId === ta.id) marks.push(Object.assign({}, rw, { id: "rw", cls: "dm-busy", busy: true }));
        if (rwDone && rwDone.taId === ta.id) marks.push(Object.assign({}, rwDone, { id: "rw", cls: "dm-done" }));
        fixed.forEach((f, k) => { if (f.taId === ta.id) marks.push(Object.assign({}, f, { id: `fx${k}`, cls: "dm-fix" })); });
        if (!marks.length && !ta._dm) return; // nada a pintar: não mexe no textarea
        window.DraftMarks.render(ta, marks);
      });
    }

    function hideToolbar() {
      toolbar.classList.add("hidden");
      pending = null;
    }

    function showToolbarAt(x, y) {
      if (rwBtn) rwBtn.style.display = pending && pending.ta && opts.rewrite ? "" : "none";
      if (fixBtn) fixBtn.style.display = pending && pending.ta && opts.fixPortuguese ? "" : "none";
      const extra = [rwBtn, fixBtn].filter((b) => b && b.style.display !== "none").length;
      const left = Math.min(Math.max(8, x - 90), window.innerWidth - (220 + extra * 150));
      toolbar.style.left = `${left}px`;
      toolbar.style.top = `${Math.max(8, y - 42)}px`;
      toolbar.classList.remove("hidden");
    }

    function positionPopupNear(el) {
      const rect = el.getBoundingClientRect();
      positionPopupAt(rect.left - 20, rect.bottom + 8);
    }

    function positionPopupAt(x, y) {
      const left = Math.min(Math.max(8, x), window.innerWidth - 300);
      const top = Math.min(y, window.innerHeight - 140);
      popup.style.left = `${left}px`;
      popup.style.top = `${Math.max(8, top)}px`;
    }

    function closePopup() {
      const was = !popup.classList.contains("hidden");
      popup.classList.add("hidden");
      popup.dataset.annotId = "";
      if (was) drawDraft();
    }

    function openPopup(annot, place) {
      popup.dataset.annotId = String(annot.id);
      textarea.value = annot.comment;
      place();
      popup.classList.remove("hidden");
      drawDraft(); // trecho do rascunho fica destacado enquanto comenta
      textarea.focus();
    }

    function draftNum(annot) {
      const ta = annot.source === "draft" && findTa(annot.taId);
      return ta && ta._dm ? ta._dm.front.querySelector(`.dm-num[data-annot-id="${annot.id}"]`) : null;
    }

    function openExisting(id, anchorEl) {
      const annot = list.find((a) => a.id === id);
      if (!annot) return;
      openPopup(annot, () => positionPopupNear(anchorEl || annot.badge || draftNum(annot) || toolbar));
    }

    function remove(id) {
      const idx = list.findIndex((a) => a.id === id);
      if (idx === -1) return;
      const [annot] = list.splice(idx, 1);
      unwrap(annot);
      renumber();
      changed();
    }

    function clear() {
      list.forEach(unwrap);
      list = [];
      closePopup();
      changed();
    }

    // Conteúdo já foi trocado (outro e-mail aberto): só esquece o estado.
    function reset() {
      list = [];
      closePopup();
      hideToolbar();
      changed();
    }

    // Depois de um re-render via innerHTML: recoloca as marcas que sumiram,
    // procurando o trecho de novo (só acha trecho dentro de um nó de texto;
    // se não achar, a anotação continua valendo, só sem a marca).
    function reapply() {
      const roots = areas().filter(Boolean);
      list.forEach((a) => {
        if (a.source !== "mail" || (a.mark && a.mark.isConnected)) return;
        a.mark = null;
        a.badge = null;
        for (const root of roots) {
          const range = findRange(root, a.text);
          if (!range) continue;
          const { mark, badge } = wrapRange(range);
          mark.dataset.annotId = String(a.id);
          badge.dataset.annotId = String(a.id);
          a.mark = mark;
          a.badge = badge;
          break;
        }
      });
      renumber();
    }

    // Seleção no textarea, sem os espaços/quebras das pontas: {quote, start, end}.
    function textareaSelection(ta) {
      if (!ta || ta.selectionStart == null || ta.selectionStart === ta.selectionEnd) return null;
      let start = ta.selectionStart;
      let end = ta.selectionEnd;
      while (start < end && /\s/.test(ta.value[start])) start++;
      while (end > start && /\s/.test(ta.value[end - 1])) end--;
      if (start === end) return null;
      return { quote: ta.value.slice(start, end), start, end };
    }

    function checkSelection(e) {
      if (e.target && e.target.closest && e.target.closest(".dm-num, #rewrite-popup")) return;
      setTimeout(() => {
        if (!enabled()) {
          hideToolbar();
          return;
        }
        // 1) seleção dentro do textarea do rascunho (marca na camada espelho)
        const ta = textareas().find((t) => t && (t === e.target || t === document.activeElement));
        const taSel = textareaSelection(ta);
        if (taSel) {
          drawDraft(); // garante prevVal/ranges em dia antes de guardar o range
          pending = { ta, quote: taSel.quote, start: taSel.start, end: taSel.end };
          if (e.type === "mouseup") showToolbarAt(e.clientX, e.clientY);
          else {
            const rect = ta.getBoundingClientRect();
            showToolbarAt(rect.left + rect.width / 2, rect.top);
          }
          return;
        }
        if (ta && e.target === ta) {
          hideToolbar();
          return;
        }
        // 2) seleção no texto do e-mail / resumo
        const sel = window.getSelection();
        const text = sel ? sel.toString().trim() : "";
        if (!text || !sel.rangeCount) {
          if (e.type === "mouseup") hideToolbar();
          return;
        }
        const anchorEl = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
        const inArea = areas().some((el) => el && sel.anchorNode && el.contains(sel.anchorNode))
          && !(anchorEl && anchorEl.closest("[data-annot-skip]"));
        if (!inArea) {
          hideToolbar();
          return;
        }
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (!rect.width && !rect.height) {
          hideToolbar();
          return;
        }
        pending = { range: sel.getRangeAt(0).cloneRange() };
        showToolbarAt(rect.left + rect.width / 2, rect.top);
      }, 0);
    }

    document.addEventListener("mouseup", checkSelection);
    // Shift+setas no textarea também seleciona
    document.addEventListener("keyup", (e) => {
      if (e.shiftKey || e.key === "Shift") checkSelection(e);
    });
    document.addEventListener("mousedown", (e) => {
      if (!toolbar.contains(e.target)) hideToolbar();
    });
    // Toque (navegador do celular): não há mouseup -- a seleção com o dedo
    // termina pelas alças nativas, então escuta selectionchange (debounce).
    if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) {
      let selTimer = null;
      document.addEventListener("selectionchange", () => {
        clearTimeout(selTimer);
        selTimer = setTimeout(() => checkSelection({ type: "selectionchange", target: document.activeElement }), 350);
      });
    }
    window.addEventListener("scroll", hideToolbar, true);
    window.addEventListener("resize", hideToolbar);

    btn.onclick = (e) => {
      // sem isso, o mesmo clique borbulha até o document e o listener de
      // "clicou fora" logo abaixo fecha o popup que acabou de abrir
      e.stopPropagation();
      if (!pending) return;
      const toolbarRect = toolbar.getBoundingClientRect();
      const id = ++seq;
      let annot;
      if (pending.ta) {
        annot = { id, source: "draft", quote: clip(pending.quote), text: pending.quote, comment: "", mark: null, badge: null,
          taId: pending.ta.id, start: pending.start, end: pending.end };
      } else {
        const text = pending.range.toString().trim();
        window.getSelection().removeAllRanges();
        const { mark, badge } = wrapRange(pending.range);
        mark.dataset.annotId = String(id);
        badge.dataset.annotId = String(id);
        annot = { id, source: "mail", quote: clip(text), text, comment: "", mark, badge };
      }
      hideToolbar();
      list.push(annot);
      renumber();
      changed();
      onAdd(annot);
      openPopup(annot, () =>
        annot.badge && annot.badge.isConnected
          ? positionPopupNear(annot.badge)
          : positionPopupAt(toolbarRect.left, toolbarRect.bottom + 8)
      );
    };

    // ── Reescrever (só no rascunho): campo pequeno -> IA -> troca inline ──
    let rwPop = null;
    function rewritePopup() {
      if (rwPop && rwPop.isConnected) return rwPop;
      rwPop = document.createElement("div");
      rwPop.id = "rewrite-popup";
      rwPop.className = "annot-popup rewrite-popup hidden";
      const cancelCls = byId("annot-cancel").className;
      const saveCls = byId("annot-save").className;
      rwPop.innerHTML = `<textarea id="rewrite-input" rows="1" placeholder="Como reescrever? Ex.: mais curto, mais formal (vazio = melhore este trecho)"></textarea>
        <div class="annot-popup-actions"><button type="button" id="rewrite-cancel" class="${cancelCls}">Cancelar</button>
        <button type="button" id="rewrite-go" class="${saveCls}">Reescrever</button></div>`;
      document.body.appendChild(rwPop);
      const inp = rwPop.querySelector("#rewrite-input");
      rwPop.querySelector("#rewrite-cancel").onclick = () => closeRewrite();
      rwPop.querySelector("#rewrite-go").onclick = () => runRewrite(inp.value);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          runRewrite(inp.value);
        } else if (e.key === "Escape") {
          e.stopPropagation();
          closeRewrite();
        }
      });
      return rwPop;
    }

    function closeRewrite() {
      if (rwPop) rwPop.classList.add("hidden");
      if (rwAsk) {
        rwAsk = null;
        drawDraft();
      }
    }

    if (rwBtn) {
      rwBtn.onclick = (e) => {
        e.stopPropagation();
        if (!pending || !pending.ta || !opts.rewrite) return;
        const rect = toolbar.getBoundingClientRect();
        rwAsk = { taId: pending.ta.id, start: pending.start, end: pending.end, text: pending.quote };
        hideToolbar();
        closePopup();
        const pop = rewritePopup();
        pop.querySelector("#rewrite-input").value = "";
        positionAt(pop, rect.left, rect.bottom + 8);
        pop.classList.remove("hidden");
        drawDraft(); // trecho destacado enquanto digita a instrução
        pop.querySelector("#rewrite-input").focus();
      };
    }

    function positionAt(el, x, y) {
      el.style.left = `${Math.min(Math.max(8, x), window.innerWidth - 300)}px`;
      el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 140))}px`;
    }

    // Aviso pequeno com ação (Desfazer) perto do rodapé; some sozinho.
    let toastEl = null;
    let toastTimer = null;
    function notify(text, action) {
      if (!toastEl || !toastEl.isConnected) {
        toastEl = document.createElement("div");
        toastEl.id = "dm-toast";
        toastEl.className = "dm-toast hidden";
        toastEl.setAttribute("role", "status");
        document.body.appendChild(toastEl);
      }
      toastEl.innerHTML = `<span></span>${action ? '<button type="button" id="dm-undo">Desfazer</button>' : ""}`;
      toastEl.firstChild.textContent = text;
      if (action) toastEl.querySelector("#dm-undo").onclick = () => { hideNotify(); action(); };
      toastEl.classList.remove("hidden");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(hideNotify, action ? 12000 : 5000);
    }
    function hideNotify() {
      if (toastEl) toastEl.classList.add("hidden");
    }

    // Troca o texto do textarea e avisa a página (input -> autosave, botões).
    function setValue(ta, value, caret) {
      ta.value = value;
      ta.setSelectionRange(caret, caret);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      drawDraft();
    }

    async function runRewrite(instruction) {
      const ask = rwAsk;
      if (rwPop) rwPop.classList.add("hidden");
      rwAsk = null;
      drawDraft();
      await runPassage(ask, (req) => opts.rewrite(Object.assign(req, { instruction: (instruction || "").trim() })), "reescrevendo…", "Não deu para reescrever o trecho.");
    }

    // ask {taId, start, end, text} -> job(req) devolve o trecho novo -> troca inline.
    // fix=true ("Corrigir português"): pinta só as palavras alteradas.
    async function runPassage(ask, job, busyLabel, failMsg, fix) {
      const ta = ask && findTa(ask.taId);
      if (!ta || ask.start == null || ta.value.slice(ask.start, ask.end) !== ask.text) {
        notify("O trecho mudou; selecione de novo.");
        return;
      }
      rw = Object.assign({}, ask, { busy: busyLabel });
      drawDraft();
      let replacement;
      try {
        replacement = await job({ draft: ta.value, start: ask.start, end: ask.end, passage: ask.text });
      } catch (err) {
        rw = null;
        drawDraft();
        notify((err && err.message) || failMsg);
        return;
      }
      const cur = rw;
      rw = null;
      const box = findTa(cur.taId) || ta; // o /copilot pode ter re-renderizado o textarea
      drawDraft();
      if (typeof replacement !== "string" || cur.start == null || box.value.slice(cur.start, cur.end) !== cur.text) {
        notify(typeof replacement !== "string" ? "A IA não devolveu o trecho." : "O trecho mudou enquanto a IA escrevia; nada foi trocado.");
        return;
      }
      if (fix) {
        const n = replaceText(box, cur.start, cur.end, replacement);
        notify(n ? `Português corrigido no trecho (${n === 1 ? "1 mudança" : `${n} mudanças`}).` : "Nada para corrigir neste trecho.", n ? doUndo : null);
        return;
      }
      const before = box.value;
      const after = before.slice(0, cur.start) + replacement + before.slice(cur.end);
      const snap = list.filter((a) => a.source === "draft").map((a) => [a, a.start, a.end]);
      rwDone = { taId: cur.taId, start: cur.start, end: cur.start + replacement.length, text: replacement };
      box.focus({ preventScroll: true }); // Ctrl/Cmd+Z já funciona sem clicar na caixa
      setValue(box, after, cur.start + replacement.length);
      undo = { taId: cur.taId, before, after, start: cur.start, replacement, passage: cur.text, ranges: snap };
      setTimeout(() => { rwDone = null; drawDraft(); }, 1600);
      notify("Trecho reescrito.", doUndo);
    }

    // Palavras de `after` que mudaram em relação a `before` brilham (dm-fix)
    // por uns segundos; offset = onde `after` começa no textarea. Devolve quantas.
    function flashChanges(ta, before, after, offset) {
      if (!ta || !window.DraftMarks || !window.DraftMarks.wordDiff) return 0;
      drawDraft(); // prevVal em dia antes de criar ranges sobre o texto novo
      const base = offset || 0;
      const marks = window.DraftMarks.wordDiff(before, after).map((r) => ({ taId: ta.id, start: base + r.start, end: base + r.end, text: r.text }));
      fixed = fixed.filter((f) => f.taId !== ta.id).concat(marks);
      drawDraft();
      clearTimeout(fixedTimer);
      fixedTimer = setTimeout(() => { fixed = []; drawDraft(); }, 4500);
      return marks.length;
    }

    // Troca ta.value[start:end] por `replacement` (Desfazer / Ctrl+Z voltam o
    // texto anterior) e pinta as palavras alteradas. Devolve quantas mudaram.
    function replaceText(ta, start, end, replacement) {
      const before = ta.value;
      const passage = before.slice(start, end);
      if (passage === replacement) return 0;
      const after = before.slice(0, start) + replacement + before.slice(end);
      const snap = list.filter((a) => a.source === "draft").map((a) => [a, a.start, a.end]);
      ta.focus({ preventScroll: true });
      setValue(ta, after, start + replacement.length);
      undo = { taId: ta.id, before, after, start, replacement, passage, ranges: snap };
      return flashChanges(ta, passage, replacement, start) || 1;
    }

    if (fixBtn) {
      fixBtn.onclick = (e) => {
        e.stopPropagation();
        if (!pending || !pending.ta || !opts.fixPortuguese) return;
        const ask = { taId: pending.ta.id, start: pending.start, end: pending.end, text: pending.quote };
        hideToolbar();
        closePopup();
        runPassage(ask, (req) => opts.fixPortuguese(req), "corrigindo…", "Não deu para corrigir o português.", true);
      };
    }

    function doUndo() {
      const u = undo;
      undo = null;
      const ta = u && findTa(u.taId);
      if (!ta) return;
      hideNotify();
      rwDone = null;
      fixed = [];
      if (ta.value === u.after) {
        // nada mexido depois: volta o texto e as marcas como estavam
        prevVal[ta.id] = u.before;
        ta.value = u.before;
        u.ranges.forEach(([a, s, e]) => { a.start = s; a.end = e; });
        ta.setSelectionRange(u.start + u.passage.length, u.start + u.passage.length);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        drawDraft();
      } else if (ta.value.slice(u.start, u.start + u.replacement.length) === u.replacement) {
        setValue(ta, ta.value.slice(0, u.start) + u.passage + ta.value.slice(u.start + u.replacement.length), u.start + u.passage.length);
      } else {
        notify("O texto mudou depois da reescrita; não deu para desfazer.");
      }
    }

    // digitação no rascunho: ranges andam junto (o cursor desempata a edição)
    document.addEventListener("input", (e) => {
      if (e.target && textareas().includes(e.target)) drawDraft(e.target);
    });
    // Ctrl/Cmd+Z logo depois de "Reescrever": volta o trecho original
    document.addEventListener("keydown", (e) => {
      if (!undo || !(e.ctrlKey || e.metaKey) || e.shiftKey || String(e.key).toLowerCase() !== "z") return;
      const ta = findTa(undo.taId);
      if (!ta || e.target !== ta || ta.value !== undo.after) return;
      e.preventDefault();
      doUndo();
    });
    // texto trocado por código (rascunho novo da IA, re-render): confere de tempos em tempos
    setInterval(() => {
      if (textareas().some((t) => t && t.id in prevVal && prevVal[t.id] !== t.value)) drawDraft();
    }, 400);

    document.addEventListener("click", (e) => {
      if (rwPop && !rwPop.classList.contains("hidden") && !rwPop.contains(e.target) && !toolbar.contains(e.target)) closeRewrite();
      const rm = e.target.closest("[data-annot-rm]");
      if (rm) {
        remove(Number(rm.dataset.annotRm));
        closePopup();
        return;
      }
      const anchorEl = e.target.closest(".annot-badge, .annot-mark, [data-annot-open]");
      if (anchorEl) {
        openExisting(Number(anchorEl.dataset.annotId), anchorEl);
        return;
      }
      if (!popup.contains(e.target)) closePopup();
    });

    byId("annot-cancel").onclick = () => {
      remove(Number(popup.dataset.annotId));
      closePopup();
    };
    byId("annot-delete").onclick = () => {
      remove(Number(popup.dataset.annotId));
      closePopup();
    };
    byId("annot-save").onclick = () => {
      const annot = list.find((a) => a.id === Number(popup.dataset.annotId));
      if (annot) annot.comment = textarea.value.trim();
      closePopup();
      changed();
    };
    // Esc salva e fecha só o popup (não deixa o Esc fechar a tela por trás)
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        byId("annot-save").click();
      }
    });

    return {
      list: () => list.slice(),
      count: () => list.length,
      remove,
      clear,
      reset,
      reapply,
      openExisting,
      closePopup,
      redraw: () => drawDraft(),
      undoRewrite: () => doUndo(),
      // mesmo aviso "… · Desfazer" do Reescrever, para outras trocas do rascunho
      notice: (text, action) => notify(text, action),
      // fecha o aviso (ex. ao abrir a confirmação de envio e depois de enviar)
      dismissNotice: () => { undo = null; hideNotify(); },
      // "Corrigir português" do rascunho inteiro: troca com destaque + Desfazer
      replaceText: (ta, start, end, replacement) => replaceText(ta, start, end, replacement),
      // texto que já entrou por outro caminho ("Usar meu texto"): só destaca
      flashChanges: (ta, before, after, offset) => flashChanges(ta, before, after, offset),
      // Desfazer genérico: o texto `before` volta se a caixa ainda está em `after`
      setUndo: (ta, before) => { undo = { taId: ta.id, before, after: ta.value, start: 0, replacement: ta.value, passage: before, ranges: [] }; },
      undo: () => doUndo(),
    };
  }

  window.Annotate = { create, compose };
})();
