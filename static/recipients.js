// Para/Cc editáveis do composer (/copilot e /mail) + aviso "a saudação é para
// outra pessoa". Mesma detecção de app/recipients.py (o /draft usa aquela para
// devolver sugestao_destinatarios; aqui reage na hora, enquanto o Leo edita).
//
// state = { to: [e-mails], cc: [e-mails], participants: [{email, name}], touched }
// Recipients.editorHTML(state, prefix) -> HTML dos chips (Para e Cc)
// Recipients.bind(root, state, prefix, onChange) -> remover / mover / adicionar
// Recipients.suggest(text, state, {instruction, me}) -> {nome, email, para, cc, mensagem} | null
// Recipients.suggestHTML(sug, prefix) / Recipients.applySuggestion(state, sug)
(function () {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lower = (e) => String(e || "").trim().toLowerCase();
  const EMAIL_RE = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/;
  const fold = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

  // "Nome <a@x>, b@y" -> ["a@x", "b@y"] (só os válidos) + inválidos à parte
  function parse(text) {
    const ok = [];
    const bad = [];
    String(text || "").split(/[,;\n]+/).forEach((part) => {
      const p = part.trim();
      if (!p) return;
      const m = p.match(/<([^>]+)>/);
      const email = lower(m ? m[1] : p);
      if (EMAIL_RE.test(email)) { if (!ok.includes(email)) ok.push(email); }
      else bad.push(p);
    });
    return { ok, bad };
  }

  function person(state, email) {
    return (state.participants || []).find((p) => lower(p.email) === lower(email)) || { email, name: "" };
  }
  function label(state, email) {
    const p = person(state, email);
    return p.name ? p.name.replace(/^"|"$/g, "") : email;
  }

  function chips(state, field, prefix) {
    return (state[field] || []).map((email) => `<span class="rc-chip" data-rc-chip="${field}" data-email="${esc(email)}" title="${esc(email)}">
      <span class="rc-name">${esc(label(state, email))}</span>${label(state, email) !== email ? `<small>${esc(email)}</small>` : ""}
      <button type="button" class="rc-move" data-rc-move="${field}" data-email="${esc(email)}" title="${field === "to" ? "Mover para Cc" : "Mover para Para"}" aria-label="${esc(`${field === "to" ? "Mover para Cc" : "Mover para Para"}: ${email}`)}">${field === "to" ? "↓Cc" : "↑Para"}</button>
      <button type="button" class="rc-x" data-rc-rm="${field}" data-email="${esc(email)}" aria-label="${esc(`Remover ${email}`)}" title="Remover">×</button></span>`).join("");
  }

  function editorHTML(state, prefix) {
    const used = new Set([...(state.to || []), ...(state.cc || [])].map(lower));
    const opts = (state.participants || []).filter((p) => !used.has(lower(p.email)))
      .map((p) => `<option value="${esc(p.email)}">${esc(p.name || p.email)}</option>`).join("");
    const row = (field, title, ph) => `<div class="rc-row" data-rc-row="${field}">
      <span class="rc-label" id="${prefix}-rc-${field}-l">${title}</span>
      <div class="rc-chips" role="group" aria-labelledby="${prefix}-rc-${field}-l">${chips(state, field, prefix)}
        <input class="rc-input" id="${prefix}-rc-${field}" data-rc-add="${field}" list="${prefix}-rc-opts" type="text" inputmode="email"
          placeholder="${ph}" aria-label="Adicionar em ${title}" autocomplete="off" data-dlg-noenter></div></div>`;
    return `<div class="rc-editor" data-rc-editor="${prefix}">
      ${row("to", "Para", (state.to || []).length ? "+ adicionar" : "quem recebe (obrigatório)")}
      ${row("cc", "Cc", "+ cópia (opcional)")}
      <datalist id="${prefix}-rc-opts">${opts}</datalist>
      <p class="rc-err" id="${prefix}-rc-err" role="alert" hidden></p></div>`;
  }

  function add(state, field, emails) {
    const other = field === "to" ? "cc" : "to";
    emails.forEach((e) => {
      state[other] = (state[other] || []).filter((x) => lower(x) !== e);
      if (!(state[field] || []).map(lower).includes(e)) state[field] = [...(state[field] || []), e];
    });
  }

  // Lê o que ficou digitado nos campos (sem Enter) — usado antes de enviar.
  // Devolve texto de erro se algo não for e-mail.
  function commitInputs(root, state) {
    let err = "";
    root.querySelectorAll("[data-rc-add]").forEach((inp) => {
      if (!inp.value.trim()) return;
      const { ok, bad } = parse(inp.value);
      add(state, inp.dataset.rcAdd, ok);
      if (ok.length) state.touched = true;
      if (bad.length) err = `E-mail inválido: ${bad.join(", ")}`;
      inp.value = bad.join(", ");
    });
    return err;
  }

  function bind(root, state, prefix, onChange) {
    const ed = root.querySelector(`[data-rc-editor="${prefix}"]`);
    if (!ed) return;
    const err = ed.querySelector(".rc-err");
    const redraw = (focusField) => {
      const tmp = document.createElement("div");
      tmp.innerHTML = editorHTML(state, prefix);
      ed.replaceWith(tmp.firstElementChild);
      bind(root, state, prefix, onChange);
      if (focusField) { const i = root.querySelector(`#${prefix}-rc-${focusField}`); if (i) i.focus(); }
      if (onChange) onChange(state);
    };
    ed.querySelectorAll("[data-rc-rm]").forEach((b) => (b.onclick = (e) => {
      e.preventDefault();
      const f = b.dataset.rcRm;
      state[f] = state[f].filter((x) => lower(x) !== lower(b.dataset.email));
      state.touched = true;
      redraw(f);
    }));
    ed.querySelectorAll("[data-rc-move]").forEach((b) => (b.onclick = (e) => {
      e.preventDefault();
      const from = b.dataset.rcMove;
      add(state, from === "to" ? "cc" : "to", [lower(b.dataset.email)]);
      state.touched = true;
      redraw();
    }));
    ed.querySelectorAll("[data-rc-add]").forEach((inp) => {
      const field = inp.dataset.rcAdd;
      const commit = (keepFocus) => {
        if (!inp.value.trim()) return false;
        const { ok, bad } = parse(inp.value);
        if (bad.length) {
          err.textContent = `Isso não parece um e-mail: ${bad.join(", ")}`; err.hidden = false;
          inp.setAttribute("aria-invalid", "true");
          if (ok.length) { add(state, field, ok); state.touched = true; inp.value = bad.join(", "); }
          return false;
        }
        add(state, field, ok);
        state.touched = true;
        inp.value = "";
        redraw(keepFocus ? field : null);
        return true;
      };
      inp.onkeydown = (e) => {
        if ((e.key === "Enter" || e.key === "," || e.key === ";" || e.key === "Tab") && inp.value.trim()) {
          if (e.key !== "Tab") e.preventDefault();
          commit(e.key !== "Tab");
        } else if (e.key === "Backspace" && !inp.value && (state[field] || []).length) {
          state[field] = state[field].slice(0, -1); state.touched = true; redraw(field);
        }
      };
      // escolheu da lista de participantes (datalist) -> vira chip na hora
      inp.oninput = () => {
        inp.removeAttribute("aria-invalid"); err.hidden = true;
        const v = lower(inp.value);
        if ((state.participants || []).some((p) => lower(p.email) === v)) commit(true);
      };
      inp.onblur = () => { if (inp.value.trim()) commit(false); };
    });
  }

  // ── saudação ≠ Para (mesma regra de app/recipients.py) ──
  const PREFIX = /^(?:ol[aá]|oi|ei|prezad[oa]s?|car[oa]s?|bom dia|boa tarde|boa noite)[\s,!.]+/i;
  const NAME = "([A-ZÀ-Ý][\\wÀ-ÿ'-]+)";
  const GENERIC = ["pessoal", "todos", "time", "equipe", "senhores", "senhoras", "prezados", "obrigado", "obrigada"];
  function greetingName(text) {
    const first = (String(text || "").split("\n").find((l) => l.trim()) || "").trim();
    if (!first) return "";
    const rest = first.replace(PREFIX, "").trim();
    const m = rest.match(new RegExp(`^${NAME}\\s*[,!.:]?\\s*$`, "u")) || rest.match(new RegExp(`^${NAME}\\s*[,!:]`, "u"));
    if (!m || GENERIC.includes(fold(m[1]))) return "";
    return m[1];
  }
  const VERB = "(?:respond[ae]r?|mand[ae]r?|envi[ae]r?|escrev[ae]r?)";
  const TO = "(?:a|ao|à|para|pro|pra)\\s+(?:o\\s+|a\\s+)?";
  function instructionTarget(instr) {
    const text = String(instr || "");
    const nao = text.match(new RegExp(`n[aã]o\\s+(?:respond[ae]r?|mand[ae]r?|envi[ae]r?)\\s+${TO}${NAME}`, "iu"));
    const blocked = nao ? [nao.index, nao.index + nao[0].length] : null;
    const re = new RegExp(`${VERB}\\s+(?:s[oó]\\s+)?${TO}${NAME}`, "giu");
    let para = "";
    let m;
    while ((m = re.exec(text))) {
      if (blocked && m.index >= blocked[0] && m.index < blocked[1]) continue;
      para = m[1]; break;
    }
    const out = {};
    if (para) out.para = para;
    if (nao) out.nao = nao[1];
    return out;
  }
  function personMatches(name, p) {
    const n = fold(name);
    if (!n) return false;
    const words = [...fold(p.name || "").split(/[\s.,_-]+/), ...fold(String(p.email || "").split("@")[0]).split(/[._-]+/)];
    return words.filter(Boolean).includes(n);
  }
  function suggest(text, state, o) {
    o = o || {};
    const me = lower(o.me);
    const target = o.instruction ? instructionTarget(o.instruction).para : "";
    const name = target || greetingName(text);
    if (!name) return null;
    const people = (state.participants || []).filter((p) => lower(p.email) !== me);
    const to = (state.to || []).map(lower);
    if (to.some((e) => personMatches(name, person(state, e)))) return null;
    const hits = people.filter((p) => personMatches(name, p));
    if (hits.length !== 1) return null;
    const email = lower(hits[0].email);
    const cc = (state.cc || []).filter((e) => lower(e) !== email);
    to.forEach((e) => { if (!cc.map(lower).includes(e)) cc.push(e); });
    const atual = to.map((e) => label(state, e)).join(", ") || "ninguém";
    return {
      nome: name, email, para: [email], cc, origem: target ? "pedido" : "saudacao",
      mensagem: `${target ? "O pedido é" : "A saudação é"} para ${name}, mas o Para é ${atual}.`,
      acao: `Trocar Para para ${name}${to.length ? ` (${to.map((e) => label(state, e)).join(", ")} vai para Cc)` : ""}?`,
    };
  }
  function suggestHTML(sug, prefix) {
    if (!sug) return "";
    return `<div class="rc-sug" role="status" data-rc-sug="${prefix}">
      <span>⚠️ ${esc(sug.mensagem)} <b>${esc(sug.acao)}</b></span>
      <button type="button" class="rc-sug-yes" id="${prefix}-rc-swap">Trocar</button>
      <button type="button" class="rc-sug-no" id="${prefix}-rc-keep">Manter</button></div>`;
  }
  function applySuggestion(state, sug) {
    state.to = sug.para.slice();
    state.cc = sug.cc.filter((e) => !sug.para.includes(lower(e)));
    if (!(state.participants || []).some((p) => lower(p.email) === sug.email)) (state.participants = state.participants || []).push({ email: sug.email, name: sug.nome });
    state.touched = true;
  }
  // chave para lembrar "Manter" (não insistir no mesmo aviso)
  const sugKey = (sug, state) => sug ? `${sug.email}|${(state.to || []).join(",")}` : "";

  window.Recipients = { parse, editorHTML, bind, commitInputs, greetingName, instructionTarget, personMatches, suggest, suggestHTML, applySuggestion, sugKey, label };
})();
