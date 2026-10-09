// Diálogos do app (no lugar de alert/confirm/prompt do navegador).
// Dialog.confirm({title, body, ok, cancel, danger}) -> Promise<boolean>
// Dialog.alert({title, body, ok})                   -> Promise<void>
// Dialog.prompt({title, body, value, placeholder})  -> Promise<string|null>
// Dialog.open({..., html, onOpen(root), beforeOk(root)}) -> Promise<{ok, value}>
//   html: conteúdo extra (ex. confirmação de envio); beforeOk devolve texto de
//   erro para manter o diálogo aberto (validação) ou nada para seguir.
// Esc = cancelar, Enter = confirmar (fora de textarea/botão/[data-dlg-noenter]),
// Tab preso no diálogo, foco volta para onde estava. Celular: bottom-sheet.
// Também aceita string: Dialog.confirm("Apagar?") / Dialog.alert("Pronto.").
(function () {
  const stack = [];
  let seq = 0;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const paras = (text) => String(text || "").split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusables(box) {
    return [...box.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest(".hidden") && !el.hidden);
  }

  function onKey(e) {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      top.finish(false);
      return;
    }
    if (e.key === "Tab") {
      const els = focusables(top.box);
      if (!els.length) { e.preventDefault(); return; }
      const first = els[0];
      const last = els[els.length - 1];
      const inside = top.box.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      const t = e.target;
      // Enter num botão = clicar nele (Cancelar cancela); no OK confirma direto
      const onOk = t && t.classList && t.classList.contains("dlg-ok");
      if (!onOk && t && t.closest && (t.closest("textarea, button, a, [data-dlg-noenter]") || !top.box.contains(t))) return;
      e.preventDefault(); e.stopPropagation();
      top.confirm();
    }
  }

  function open(opts) {
    if (typeof opts === "string") opts = { body: opts };
    opts = Object.assign({ title: "", body: "", ok: "OK", cancel: "Cancelar", kind: "confirm" }, opts || {});
    const id = `dlg-${++seq}`;
    const prevFocus = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "dlg-overlay";
    overlay.style.zIndex = String(1000 + stack.length * 2);
    const hasInput = opts.kind === "prompt";
    overlay.innerHTML = `<div class="dlg-box${opts.wide ? " dlg-wide" : ""}${opts.danger ? " dlg-danger" : ""}" role="${opts.kind === "alert" ? "alertdialog" : "dialog"}" aria-modal="true" ${opts.title ? `aria-labelledby="${id}-t"` : ""} aria-describedby="${id}-b">
      ${opts.title ? `<h2 class="dlg-title" id="${id}-t">${esc(opts.title)}</h2>` : ""}
      <div class="dlg-body" id="${id}-b">${opts.body ? paras(opts.body) : ""}${opts.html || ""}
        ${hasInput ? `<label class="dlg-field">${opts.label ? `<span>${esc(opts.label)}</span>` : ""}${opts.multiline
          ? `<textarea class="dlg-input" rows="3" placeholder="${esc(opts.placeholder || "")}">${esc(opts.value || "")}</textarea>`
          : `<input class="dlg-input" type="text" value="${esc(opts.value || "")}" placeholder="${esc(opts.placeholder || "")}" autocomplete="off">`}</label>` : ""}
        <p class="dlg-error" role="alert" hidden></p>
      </div>
      <div class="dlg-actions">
        ${opts.kind === "alert" ? "" : `<button type="button" class="dlg-btn dlg-cancel">${esc(opts.cancel)}</button>`}
        <button type="button" class="dlg-btn dlg-ok${opts.danger ? " danger" : " primary"}">${esc(opts.ok)}</button>
      </div></div>`;
    document.body.appendChild(overlay);
    const box = overlay.firstElementChild;
    const input = box.querySelector(".dlg-input");
    const errEl = box.querySelector(".dlg-error");
    return new Promise((resolve) => {
      let done = false;
      const entry = { opts, box, overlay };
      entry.finish = (ok) => {
        if (done) return;
        done = true;
        const value = ok ? (input ? input.value : true) : null;
        const i = stack.indexOf(entry);
        if (i >= 0) stack.splice(i, 1);
        if (!stack.length) document.removeEventListener("keydown", onKey, true);
        overlay.remove();
        if (prevFocus && prevFocus.isConnected && prevFocus.focus) { try { prevFocus.focus({ preventScroll: true }); } catch { /* ok */ } }
        resolve({ ok: !!ok, value });
      };
      entry.confirm = async () => {
        if (opts.beforeOk) {
          const okBtn = box.querySelector(".dlg-ok");
          okBtn.disabled = true;
          let msg;
          try { msg = await opts.beforeOk(box, input ? input.value : undefined); } finally { okBtn.disabled = false; }
          if (msg === false) return;
          if (msg) { errEl.textContent = msg; errEl.hidden = false; return; }
        }
        entry.finish(true);
      };
      stack.push(entry);
      if (stack.length === 1) document.addEventListener("keydown", onKey, true);
      box.querySelector(".dlg-ok").onclick = () => entry.confirm();
      const cancel = box.querySelector(".dlg-cancel");
      if (cancel) cancel.onclick = () => entry.finish(false);
      overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) entry.finish(false); });
      if (opts.onOpen) opts.onOpen(box, entry);
      const first = input || box.querySelector("[data-dlg-focus]") || box.querySelector(".dlg-ok");
      if (first) { first.focus({ preventScroll: true }); if (input && input.select) input.select(); }
    });
  }

  window.Dialog = {
    open,
    confirm: (o) => open(Object.assign({ ok: "Confirmar" }, typeof o === "string" ? { body: o } : o, { kind: "confirm" })).then((r) => r.ok),
    alert: (o) => open(Object.assign({ ok: "Entendi" }, typeof o === "string" ? { body: o } : o, { kind: "alert" })).then(() => undefined),
    prompt: (o) => open(Object.assign({ ok: "Salvar" }, typeof o === "string" ? { body: o } : o, { kind: "prompt" })).then((r) => (r.ok ? r.value : null)),
    isOpen: () => stack.length > 0,
    closeAll: () => stack.slice().reverse().forEach((e) => e.finish(false)),
  };
})();
