// Estado da conexão com o Gmail + fila de envio, compartilhado por /copilot e
// /mail. Mostra um aviso no topo quando o servidor não consegue ler o Gmail
// (sem rede ou acesso expirado) e o chip "Na fila de envio" com a lista do
// que o Leo já confirmou e ainda não saiu (cancelar / tentar agora).
// Uso: NetStatus.init({ chipHost?: Element, onChange?: (st) => void }).
(function () {
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MSG = {
    offline: "Sem conexão — não estou conseguindo ler/baixar e-mails novos. Você pode responder os que já estão aqui; envio fica na fila e sai quando a conexão voltar.",
    auth_error: "O acesso ao Gmail expirou — preciso que você entre no Gmail de novo para ler e enviar. O que você já confirmou fica na fila e sai depois que entrar.",
  };
  const CSS = `
  .ns-banner{position:sticky;top:0;z-index:60;display:flex;gap:10px;align-items:flex-start;padding:10px 14px;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;border-bottom:1px solid rgba(0,0,0,.08)}
  .ns-banner.hidden,.ns-chip.hidden,.ns-pop.hidden{display:none}
  .ns-banner.offline{background:#fff4d6;color:#5c4400}
  .ns-banner.auth_error{background:#fde3e3;color:#6d1a1a}
  .ns-banner .ns-txt{flex:1;min-width:0}
  .ns-banner small{display:block;opacity:.75;margin-top:2px}
  .ns-banner button,.ns-pop button{font:inherit;font-size:13px;border:1px solid currentColor;background:transparent;color:inherit;border-radius:8px;padding:4px 10px;cursor:pointer;white-space:nowrap}
  .ns-chip{display:inline-flex;align-items:center;gap:6px;font:600 12px/1 system-ui,-apple-system,sans-serif;background:#efe9ff;color:#3d2f7a;border:1px solid #d8ceff;border-radius:999px;padding:6px 10px;cursor:pointer}
  .ns-chip.fail{background:#fde3e3;color:#6d1a1a;border-color:#f4c2c2}
  .ns-chip.floating{position:fixed;right:14px;bottom:14px;z-index:61;box-shadow:0 4px 14px rgba(0,0,0,.12)}
  .ns-pop{position:fixed;right:14px;bottom:56px;z-index:62;width:min(380px,calc(100vw - 28px));max-height:60vh;overflow:auto;background:#fff;color:#222;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:12px;font:14px/1.4 system-ui,-apple-system,sans-serif}
  .ns-pop h4{margin:0 0 8px;font-size:14px}
  .ns-item{border-top:1px solid #eee;padding:8px 0;display:grid;gap:4px}
  .ns-item b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ns-item small{color:#666}
  .ns-item .ns-err{color:#9b1c1c}
  .ns-item .ns-acts{display:flex;gap:6px;justify-content:flex-end}
  @media (prefers-color-scheme: dark){.ns-pop{background:#1f1f24;color:#eee}.ns-item{border-color:#333}.ns-item small{color:#aaa}}
  `;
  let st = null;
  let timer = null;
  let opts = {};
  let els = null;
  const STATUS_LABEL = { queued: "na fila", sending: "enviando…", failed: "não saiu" };

  async function api(url, method = "GET") {
    try {
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" } });
      let data = {};
      try { data = await r.json(); } catch { /* vazio */ }
      return { ok: r.ok, data };
    } catch (e) {
      return { ok: false, data: { detail: "O app (servidor local) não respondeu." }, down: true };
    }
  }

  function build() {
    if (els) return els;
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    const banner = document.createElement("div");
    banner.className = "ns-banner hidden";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");
    document.body.insertBefore(banner, document.body.firstChild);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "ns-chip hidden";
    if (opts.chipHost) opts.chipHost.appendChild(chip);
    else { chip.classList.add("floating"); document.body.appendChild(chip); }
    const pop = document.createElement("div");
    pop.className = "ns-pop hidden";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Fila de envio");
    document.body.appendChild(pop);
    chip.onclick = () => { pop.classList.toggle("hidden"); if (!pop.classList.contains("hidden")) renderQueue(); };
    document.addEventListener("click", (e) => {
      if (!pop.classList.contains("hidden") && !pop.contains(e.target) && e.target !== chip && !chip.contains(e.target)) pop.classList.add("hidden");
    });
    els = { banner, chip, pop };
    return els;
  }

  function when(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function render() {
    const { banner, chip } = build();
    const s = st || {};
    const bad = s.status === "offline" || s.status === "auth_error" || s.server_down;
    banner.classList.toggle("hidden", !bad);
    banner.classList.remove("offline", "auth_error");
    if (bad) {
      const kind = s.status === "auth_error" ? "auth_error" : "offline";
      banner.classList.add(kind);
      const msg = s.server_down ? "O app (servidor local) não está respondendo. Verifique se o container está rodando." : MSG[kind];
      const last = s.last_sync_label ? `Último e-mail baixado em ${esc(s.last_sync_label)}.` : "";
      banner.innerHTML = `<div class="ns-txt">${esc(msg)}<small>${last}${s.last_error && !s.server_down ? ` Detalhe: ${esc(s.last_error).slice(0, 140)}` : ""}</small></div>
        ${kind === "auth_error" && !s.server_down ? '<button type="button" data-ns="login">Entrar no Gmail</button>' : ""}
        ${s.server_down ? "" : '<button type="button" data-ns="retry">Tentar agora</button>'}`;
      const retry = banner.querySelector('[data-ns="retry"]');
      if (retry) retry.onclick = syncNow;
      const login = banner.querySelector('[data-ns="login"]');
      if (login) login.onclick = async () => {
        const r = await api("/api/auth/login");
        if (r.ok && r.data.url) window.open(r.data.url, "_blank", "noopener");
      };
    }
    const ob = s.outbox || {};
    const pending = (ob.queued || 0) + (ob.sending || 0);
    const failed = ob.failed || 0;
    chip.classList.toggle("hidden", !(pending || failed));
    chip.classList.toggle("fail", !!failed && !pending);
    chip.textContent = pending ? `Na fila de envio · ${pending}${failed ? ` (+${failed} não saiu)` : ""}` : `${failed} envio${failed === 1 ? "" : "s"} não saiu`;
    chip.title = "Respostas que você confirmou e ainda não saíram. Clique para ver, cancelar ou tentar agora.";
    if (typeof opts.onChange === "function") opts.onChange(s);
  }

  async function renderQueue() {
    const { pop } = build();
    pop.innerHTML = "<h4>Fila de envio</h4><small>Carregando…</small>";
    const r = await api("/api/outbox");
    const items = (r.ok && r.data.items) || [];
    if (!items.length) { pop.innerHTML = "<h4>Fila de envio</h4><small>Nada esperando para sair.</small>"; return; }
    pop.innerHTML = `<h4>Fila de envio</h4><small>Sai sozinho quando a conexão voltar. Só o que você já confirmou.</small>` +
      items.map((it) => `<div class="ns-item" data-id="${esc(it.id)}">
        <b title="${esc(it.subject)}">${esc(it.subject || "(sem assunto)")}</b>
        <small>${it.kind === "reply" ? "Resposta" : "Novo e-mail"}${it.to_addr ? ` para ${esc(it.to_addr)}` : ""} · ${esc(STATUS_LABEL[it.status] || it.status)} · ${esc(when(it.created_at))}${it.attempts ? ` · ${it.attempts} tentativa${it.attempts === 1 ? "" : "s"}` : ""}</small>
        ${it.last_error ? `<small class="ns-err">${esc(it.last_error).slice(0, 200)}</small>` : ""}
        <div class="ns-acts">${it.status !== "sending" ? '<button type="button" data-act="cancel">Cancelar envio</button><button type="button" data-act="retry">Tentar agora</button>' : ""}</div>
      </div>`).join("");
    pop.querySelectorAll(".ns-item [data-act]").forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const id = b.closest(".ns-item").dataset.id;
        const act = b.dataset.act;
        if (act === "cancel" && !(await window.Dialog.confirm({ title: "Cancelar este envio?", body: "A resposta sai da fila e não será enviada.", ok: "Cancelar envio", cancel: "Manter na fila", danger: true }))) return;
        b.disabled = true;
        const res = await api(`/api/outbox/${encodeURIComponent(id)}/${act}`, "POST");
        if (!res.ok) await window.Dialog.alert({ title: act === "cancel" ? "Não deu para cancelar" : "Não deu para enviar agora", body: res.data.detail || "Tente de novo em instantes." });
        await refresh();
        renderQueue();
      };
    });
  }

  async function syncNow() {
    if (els) els.banner.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    await api("/api/sync/now", "POST");
    await refresh();
  }

  async function refresh() {
    const r = await api("/api/sync/status");
    if (r.ok) st = r.data;
    else if (r.down) st = { ...(st || {}), server_down: true };
    render();
    clearTimeout(timer);
    const bad = st && (st.status !== "online" || st.server_down || (st.outbox && (st.outbox.queued || st.outbox.sending)));
    timer = setTimeout(refresh, bad ? 15000 : 45000);
    return st;
  }

  window.NetStatus = {
    init(o) {
      opts = o || {};
      build();
      window.addEventListener("online", () => setTimeout(syncNow, 1500));
      window.addEventListener("offline", () => { st = { ...(st || {}), status: "offline" }; render(); });
      return refresh();
    },
    refresh,
    get state() { return st; },
    isOffline() { return !!st && (st.status === "offline" || st.status === "auth_error"); },
    message(kind) { return MSG[kind] || ""; },
  };
})();
