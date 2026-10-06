// Selecionar trecho -> anotação ancorada (igual ao Codex), compartilhado entre
// o /mail (app.js) e o /copilot (copilot.js). Seleciona um pedaço do texto,
// aparece a barrinha "Adicionar", o trecho ganha um número (badge azul) e abre
// uma caixinha para comentar. As anotações viram contexto direcionado no
// próximo rascunho, pelo MESMO /api/threads/{id}/draft (campo instruction).
//
// Duas origens de trecho:
//  - "mail": texto do e-mail/resumo (áreas DOM): o trecho é marcado no próprio
//    texto (span.annot-mark + sup.annot-badge);
//  - "draft": seleção DENTRO de um textarea (o rascunho): textarea não aceita
//    span, então só guarda o trecho (selectionStart/End) -- quem usa mostra a
//    lista (chips) com [data-annot-open] / [data-annot-rm].
//
// Markup esperado na página (mesmos ids do /mail): #select-toolbar com
// #select-add-chat e #annot-popup com #annot-popup-textarea, #annot-save,
// #annot-cancel e #annot-delete.
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

  // Acha o trecho num único nó de texto (re-render via innerHTML apaga as marcas).
  function findRange(root, text) {
    if (!root || !text) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const i = node.nodeValue.indexOf(text);
      if (i >= 0) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + text.length);
        return range;
      }
    }
    return null;
  }

  // opts.areas(): elementos onde a seleção vira marca no texto;
  // opts.textareas(): textareas onde a seleção vira trecho "draft";
  // opts.enabled(): se dá pra anotar agora; opts.onChange(list); opts.onAdd(annot).
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
    let list = [];
    let seq = 0;
    let pending = null; // { range } (área DOM) ou { ta, quote } (textarea)

    const changed = () => onChange(list.slice());

    function renumber() {
      list.forEach((a, i) => {
        if (a.badge) a.badge.textContent = String(i + 1);
      });
    }

    function hideToolbar() {
      toolbar.classList.add("hidden");
      pending = null;
    }

    function showToolbarAt(x, y) {
      const left = Math.min(Math.max(8, x - 90), window.innerWidth - 220);
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
      popup.classList.add("hidden");
      popup.dataset.annotId = "";
    }

    function openPopup(annot, place) {
      popup.dataset.annotId = String(annot.id);
      textarea.value = annot.comment;
      place();
      popup.classList.remove("hidden");
      textarea.focus();
    }

    function openExisting(id, anchorEl) {
      const annot = list.find((a) => a.id === id);
      if (!annot) return;
      openPopup(annot, () => positionPopupNear(anchorEl || annot.badge || toolbar));
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

    function textareaSelection(ta) {
      if (!ta || ta.selectionStart == null || ta.selectionStart === ta.selectionEnd) return "";
      return ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
    }

    function checkSelection(e) {
      setTimeout(() => {
        if (!enabled()) {
          hideToolbar();
          return;
        }
        // 1) seleção dentro do textarea do rascunho (sem marca no DOM)
        const ta = textareas().find((t) => t && (t === e.target || t === document.activeElement));
        const taQuote = textareaSelection(ta);
        if (taQuote) {
          pending = { ta, quote: taQuote };
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
        const inArea = areas().some((el) => el && sel.anchorNode && el.contains(sel.anchorNode));
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
        annot = { id, source: "draft", quote: clip(pending.quote), text: pending.quote, comment: "", mark: null, badge: null };
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

    document.addEventListener("click", (e) => {
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
    };
  }

  window.Annotate = { create, compose };
})();
