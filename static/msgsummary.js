// "Resumir este e-mail": botão no cabeçalho de cada mensagem da conversa,
// compartilhado entre o /copilot (copilot.js, messageHTML) e o /mail (app.js,
// renderBody). Clique -> menu Direto / Abrangente -> POST
// /api/copilot/{thread}/mensagens/{idx}/resumo (só o texto daquela mensagem,
// sem o histórico citado; cache no servidor por texto + modo) -> caixa
// recolhível no topo do corpo daquela mensagem.
//
// Uso na página:
//   head: `${MsgSummary.buttonHTML()}` dentro do .msg-head de cada .msg-card[data-idx]
//   depois de cada innerHTML da conversa: MsgSummary.bind(root, threadId)
// O estado (carregando / resultado / recolhido) vive aqui, por thread + índice,
// e bind() repõe as caixas depois de qualquer re-render. A caixa leva
// data-annot-skip: as anotações (annotate.js) não marcam texto dentro dela.
(function () {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ic = (name, size) => (window.Icons ? window.Icons.svg(name, { size: size || 15 }) : "");
  const MODOS = {
    direto: { label: "Direto", desc: "3–5 tópicos: o pedido ou a decisão principal" },
    abrangente: { label: "Abrangente", desc: "Contexto, pontos, números, pedidos por pessoa, prazos e riscos" },
  };
  const SECOES = [
    ["pontos_principais", "Pontos principais"],
    ["numeros_dados", "Números e dados"],
    ["pedidos_por_pessoa", "Pedidos por pessoa"],
    ["prazos", "Prazos"],
    ["riscos", "Riscos e pendências"],
  ];
  const state = {}; // `${tid}:${idx}` -> {modo, status: "loading"|"ok"|"erro", data, erro, collapsed, seq}
  let live = { root: null, tid: "" };
  let menu = null;
  let seq = 0;

  const key = (tid, idx) => `${tid}:${idx}`;
  const when = (iso) => {
    const d = new Date(iso);
    return !iso || isNaN(d) ? "" : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", "");
  };

  function buttonHTML() {
    return `<button type="button" class="msg-sum-btn" data-msg-sum title="Resumir este e-mail" aria-label="Resumir este e-mail" aria-haspopup="menu">${ic("summary", 15)}</button>`;
  }

  function item(k, v) {
    if (k === "pedidos_por_pessoa") return `<li><b>${esc(v.nome || "Alguém")}:</b> ${esc(v.pedido)}</li>`;
    if (k === "prazos") return `<li><b>${esc(v.data || "Sem data")}:</b> ${esc(v.o_que)}</li>`;
    return `<li>${esc(v)}</li>`;
  }

  function resultHTML(modo, r) {
    r = r || {};
    const parts = [];
    if (modo === "direto") {
      if (r.principal) parts.push(`<p class="msg-sum-main"><b>Principal:</b> ${esc(r.principal)}</p>`);
      if ((r.bullets || []).length) parts.push(`<ul>${r.bullets.map((v) => item("", v)).join("")}</ul>`);
    } else {
      if (r.contexto) parts.push(`<section><h5>Contexto</h5><p>${esc(r.contexto)}</p></section>`);
      SECOES.forEach(([k, title]) => {
        const list = r[k] || [];
        if (list.length) parts.push(`<section><h5>${esc(title)}</h5><ul>${list.map((v) => item(k, v)).join("")}</ul></section>`);
      });
    }
    return parts.join("") || '<p class="msg-sum-muted">A IA não encontrou nada para destacar nesta mensagem.</p>';
  }

  function boxHTML(st) {
    const modo = MODOS[st.modo] ? st.modo : "direto";
    let body;
    let meta = "";
    if (st.status === "loading") body = '<p class="msg-sum-muted msg-sum-loading">Resumindo…</p>';
    else if (st.status === "erro") body = `<p class="msg-sum-warn">${esc(st.erro || "Não deu para resumir agora.")}</p>`;
    else {
      const w = when(st.data.gerado_em);
      meta = `${w ? `gerado em ${esc(w)}` : ""}${st.data.cached ? `${w ? " · " : ""}do cache` : ""}`;
      body = `${st.aviso ? `<p class="msg-sum-warn">${esc(st.aviso)}</p>` : ""}${resultHTML(modo, st.data.resumo)}`;
    }
    return `<div class="msg-sum-h">
        <button type="button" class="msg-sum-tog" data-msg-sum-tog aria-expanded="${!st.collapsed}" title="${st.collapsed ? "Mostrar" : "Recolher"} resumo">
          <span class="msg-sum-caret" aria-hidden="true">${st.collapsed ? "▸" : "▾"}</span>${ic("summary", 14)}
          <span>Resumo · <b>${MODOS[modo].label}</b></span>
        </button>
        ${meta ? `<span class="msg-sum-meta">${meta}</span>` : ""}
        <button type="button" class="msg-sum-act" data-msg-sum-regen ${st.status === "loading" ? "disabled" : ""} title="Regerar (pede à IA de novo)">${ic("refresh", 13)}<span>Regerar</span></button>
        <button type="button" class="msg-sum-x" data-msg-sum-close title="Fechar resumo" aria-label="Fechar resumo">×</button>
      </div>
      <div class="msg-sum-body${st.collapsed ? " hidden" : ""}">${body}</div>`;
  }

  function cardOf(root, idx) {
    return root ? root.querySelector(`.msg-card[data-idx="${idx}"]`) : null;
  }

  function openCard(card) {
    card.classList.add("open");
    const head = card.querySelector(".msg-head");
    if (head) head.setAttribute("aria-expanded", "true");
  }

  // Desenha (ou tira) a caixa de um card conforme o estado.
  function paint(card, tid) {
    const idx = card.dataset.idx;
    const st = state[key(tid, idx)];
    let box = card.querySelector(":scope > .msg-sum");
    if (!st) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = document.createElement("div");
      box.className = "msg-sum";
      box.setAttribute("data-annot-skip", "");
      const text = card.querySelector(":scope > .msg-text");
      card.insertBefore(box, text || null);
    }
    box.innerHTML = boxHTML(st);
    box.querySelector("[data-msg-sum-tog]").onclick = () => {
      st.collapsed = !st.collapsed;
      paint(card, tid);
    };
    box.querySelector("[data-msg-sum-regen]").onclick = () => run(tid, idx, st.modo, true);
    box.querySelector("[data-msg-sum-close]").onclick = () => {
      delete state[key(tid, idx)];
      paint(card, tid);
    };
  }

  function repaint(tid, idx) {
    if (live.tid !== tid || !live.root || !live.root.isConnected) return;
    const card = cardOf(live.root, idx);
    if (card) paint(card, tid);
  }

  async function run(tid, idx, modo, regerar) {
    const k = key(tid, idx);
    const prev = state[k];
    const st = { modo, status: "loading", data: null, erro: "", collapsed: false, seq: ++seq };
    state[k] = st;
    const card = live.tid === tid ? cardOf(live.root, idx) : null;
    if (card) openCard(card);
    repaint(tid, idx);
    let ok = false;
    let data = {};
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 120000) : null;
    try {
      const res = await fetch(`/api/copilot/${encodeURIComponent(tid)}/mensagens/${encodeURIComponent(idx)}/resumo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modo, regerar: !!regerar }),
        signal: ctrl ? ctrl.signal : undefined,
      });
      data = await res.json().catch(() => ({}));
      ok = res.ok;
    } catch (e) {
      data = { detail: e && e.name === "AbortError" ? "A IA demorou demais. Tente de novo." : "Sem conexão com o app agora." };
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (state[k] !== st) return; // fechou ou pediu outro enquanto carregava
    if (ok) Object.assign(st, { status: "ok", data });
    else if (regerar && prev && prev.status === "ok" && prev.modo === modo) {
      // Regerar falhou: mantém o resumo anterior, com o aviso
      Object.assign(st, { status: "ok", data: prev.data, aviso: data.detail || "Não deu para regerar agora." });
    } else Object.assign(st, { status: "erro", erro: data.detail || "Não deu para resumir agora." });
    repaint(tid, idx);
  }

  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function outside(e) {
    if (menu && !menu.contains(e.target) && !(e.target.closest && e.target.closest("[data-msg-sum]"))) closeMenu();
  }
  function onKey(e) {
    if (e.key === "Escape") closeMenu();
  }

  function openMenu(btn, tid, idx) {
    const same = menu && menu.dataset.for === key(tid, idx);
    closeMenu();
    if (same) return; // segundo clique no mesmo botão fecha
    menu = document.createElement("div");
    menu.className = "msg-sum-menu";
    menu.setAttribute("role", "menu");
    menu.dataset.for = key(tid, idx);
    menu.innerHTML = `<div class="msg-sum-menu-h">Resumir este e-mail</div>${Object.entries(MODOS)
      .map(([m, o]) => `<button type="button" role="menuitem" data-modo="${m}"><b>${o.label}</b><small>${esc(o.desc)}</small></button>`)
      .join("")}`;
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    const width = menu.offsetWidth || 260;
    menu.style.top = `${Math.round(r.bottom + 4)}px`;
    menu.style.left = `${Math.max(8, Math.min(Math.round(r.right - width), (window.innerWidth || 1024) - width - 8))}px`;
    menu.querySelectorAll("[data-modo]").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        closeMenu();
        run(tid, idx, b.dataset.modo, false);
      };
    });
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", onKey, true);
    const first = menu.querySelector("[data-modo]");
    if (first && first.focus) first.focus();
  }

  // Liga os botões e repõe as caixas (depois de cada innerHTML da conversa).
  function bind(root, tid) {
    if (!root || !tid) return;
    if (live.root !== root || live.tid !== tid) closeMenu();
    live = { root, tid };
    root.querySelectorAll(".msg-card").forEach((card) => {
      const btn = card.querySelector(".msg-head [data-msg-sum]");
      if (btn) {
        btn.onclick = (e) => {
          e.stopPropagation(); // não abre/recolhe o card
          openMenu(btn, tid, card.dataset.idx);
        };
        btn.onkeydown = (e) => e.stopPropagation(); // Enter/Espaço no botão não viram "flip" do card
      }
      if (state[key(tid, card.dataset.idx)]) {
        paint(card, tid);
        openCard(card);
      }
    });
  }

  window.MsgSummary = { buttonHTML, bind, _state: state };
})();
