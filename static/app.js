const $ = (id) => document.getElementById(id);

let restoreHidden = false;
let chatHistory = [];
let currentTo = "";
let canSend = false;

function tags(item) {
  const out = [];
  if (item.is_unread) out.push(["NÃO LIDO", "unread"]);
  if (item.awaiting_reply) out.push(["SEM RESPOSTA", ""]);
  if (item.conferido) out.push(["CONFERIDO", "ok"]);
  else out.push(["A CONFIRMAR", ""]);
  if (item.needs_action_hint) out.push(["AÇÃO SUA", "action"]);
  if (item.has_summary) out.push(["RESUMO", "ready"]);
  if (item.has_draft) out.push(["RASCUNHO", "ready"]);
  return out
    .map(([label, cls]) => `<span class="tag ${cls}">${label}</span>`)
    .join("");
}

function card(item) {
  const href = `/mail/${encodeURIComponent(item.id)}`;
  return `<a class="card" href="${href}" data-id="${item.id}">
    <header>
      <span class="from">${item.from_email || item.from_name}</span>
      <span class="time">${item.time}</span>
    </header>
    <div class="subject">${item.subject}</div>
    <div class="snippet">${item.snippet || ""}</div>
    <div class="tags">${tags(item)}</div>
  </a>`;
}

function renderList(id, items) {
  $(id).innerHTML = items.map(card).join("");
}

function qs() {
  const params = new URLSearchParams();
  if ($("q").value.trim()) params.set("q", $("q").value.trim());
  if ($("acao").checked) params.set("acao_sua", "true");
  if ($("mkt").checked) params.set("marketing", "true");
  if (restoreHidden) params.set("restore_hidden", "true");
  const s = params.toString();
  return s ? `?${s}` : "";
}

let lastAutoIds = [];

async function loadRadar(opts) {
  const options = opts || {};
  try {
    const res = await fetch(`/api/radar${qs()}`);
    if (!res.ok) throw new Error("radar");
    const data = await res.json();
    $("account").textContent = data.account;
    $("n-unanswered").textContent = data.unanswered;
    $("n-action").textContent = data.needs_action;
    $("c-unread").textContent = data.unread.length;
    $("c-waiting").textContent = data.waiting.length;
    $("c-auto").textContent = data.automatic.length;
    $("btn-hidden").textContent = `Restaurar ocultos (${data.hidden})`;
    if (data.last_refresh) {
      $("updated").textContent = data.last_refresh;
    }
    renderList("unread", data.unread);
    renderList("waiting", data.waiting);
    renderList("automatic", data.automatic);

    lastAutoIds = data.automatic.map((item) => item.id);
    const autoSection = $("btn-auto-read").closest("article");
    if (data.automatic.length === 0 && autoSection) {
      autoSection.style.display = "none";
    } else if (autoSection) {
      autoSection.style.display = "";
    }

    if (options.preload !== false && !document.hidden) {
      preloadEnds(data.unread);
    }
    return data;
  } catch (err) {
    showBanner("Painel offline ou ocupado.", true);
    return null;
  }
}

function showBanner(text, show) {
  $("banner").textContent = text;
  $("banner").classList.toggle("hidden", !show);
}

async function loadStatus() {
  const data = await (await fetch("/api/status")).json();
  $("account").textContent = data.account;
  if (data.last_refresh) {
    $("updated").textContent = data.last_refresh;
  }
  $("btn-auth").classList.toggle("hidden", data.authenticated);
  $("btn-refresh").disabled = !data.authenticated;
  canSend = !!data.can_send;
  if (data.llm_provider) {
    const tokens = data.llm_tokens_today || 0;
    const label = tokens
      ? `${data.llm_provider} · ${tokens.toLocaleString("pt-BR")} tokens hoje`
      : data.llm_provider;
    $("llm-badge").textContent = label;
    $("llm-badge").dataset.tooltip =
      "Consumo somado neste app desde meia-noite UTC. A API não informa a cota restante da sua conta, só o que foi gasto aqui.";
    $("llm-badge").classList.remove("hidden");
  } else {
    $("llm-badge").classList.add("hidden");
  }
  if (!data.has_client) {
    $("setup").classList.remove("hidden");
    showBanner("Falta OAuth. Cole Client ID e Secret abaixo.", true);
  } else if (!data.authenticated) {
    $("setup").classList.add("hidden");
    showBanner("Gmail não autenticado. Clique em Entrar no Gmail.", true);
  } else if (!canSend) {
    $("setup").classList.add("hidden");
    $("btn-auth").textContent = "Autorizar envio";
    $("btn-auth").classList.remove("hidden");
    showBanner(
      'Envio de e-mail ainda não autorizado. Clique em "Autorizar envio" para poder mandar respostas.',
      true
    );
  } else {
    $("setup").classList.add("hidden");
    $("btn-auth").textContent = "Entrar no Gmail";
    showBanner("", false);
  }
  return data;
}

function bannerDetail(err) {
  const d = err && err.detail;
  if (!d) return err && err.message ? err.message : "Falha ao atualizar";
  if (typeof d === "string") return d;
  if (d.message) return d.message;
  return JSON.stringify(d);
}

async function refresh(silent) {
  if (document.hidden || refresh.inFlight) return;
  refresh.inFlight = true;
  if (!silent) $("btn-refresh").disabled = true;
  try {
    const res = await fetch("/api/refresh", { method: "POST" });
    const err = await res.json().catch(() => ({}));
    if (!res.ok) {
      showBanner(bannerDetail(err), true);
      await loadRadar({ preload: false });
      return;
    }
    showBanner("", false);
    await loadRadar({ preload: false });
  } finally {
    refresh.inFlight = false;
    $("btn-refresh").disabled = false;
  }
}

$("btn-auth").onclick = async () => {
  const res = await fetch("/api/auth/login");
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) {
    const detail = data.detail || "Não foi possível iniciar o login.";
    showBanner(typeof detail === "string" ? detail : JSON.stringify(detail), true);
    $("setup").classList.remove("hidden");
    return;
  }
  window.location.href = data.url;
};

$("setup").onsubmit = async (event) => {
  event.preventDefault();
  const res = await fetch("/api/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: $("cid").value,
      client_secret: $("csecret").value,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showBanner(data.detail || "Não salvou as credenciais.", true);
    return;
  }
  await loadStatus();
  $("btn-auth").click();
};

$("btn-refresh").onclick = () => refresh(false);
$("q").addEventListener("input", () => loadRadar());
$("acao").onchange = () => loadRadar();
$("mkt").onchange = () => loadRadar();
$("m-unanswered").onclick = () => {
  $("waiting-menu").open = !$("waiting-menu").open;
};
$("m-action").onclick = () => {
  $("acao").checked = !$("acao").checked;
  loadRadar();
};
$("btn-hidden").onclick = () => {
  restoreHidden = !restoreHidden;
  $("btn-hidden").classList.toggle("active", restoreHidden);
  loadRadar();
};

// ── Mark all automatics as read ──
$("btn-auto-read").onclick = async () => {
  if (!lastAutoIds.length) return;
  $("btn-auto-read").disabled = true;
  $("btn-auto-read").textContent = "Marcando…";
  try {
    const res = await fetch("/api/mark-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: lastAutoIds }),
    });
    if (res.ok) {
      await loadRadar({ preload: false });
    }
  } finally {
    $("btn-auto-read").disabled = false;
    $("btn-auto-read").innerHTML =
      '<svg style="width:16px;height:16px;vertical-align:middle;margin-right:2px" viewBox="0 0 24 24" fill="currentColor"><path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z"/></svg> Marcar lidos';
  }
};

// ── Pane ──
let paneId = null;
let preloadBusy = false;

function pickPreload(ids) {
  if (ids.length <= 4) return ids;
  const picked = [...ids.slice(0, 2), ...ids.slice(-2)];
  return [...new Set(picked)];
}

async function preloadEnds(unread) {
  if (document.hidden || preloadBusy) return;
  const missing = unread.filter((item) => !item.has_summary).map((item) => item.id);
  const ids = pickPreload(missing.length ? missing : unread.map((item) => item.id));
  const pending = ids.filter((id) => {
    const row = unread.find((item) => item.id === id);
    return row && !row.has_summary;
  });
  if (!pending.length) return;
  preloadBusy = true;
  try {
    await fetch("/api/preload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: pending }),
    });
    if (!document.hidden) await loadRadar({ preload: false });
  } finally {
    preloadBusy = false;
  }
}

function splitMessages(body) {
  return (body || "")
    .split(/\n\n----\n\n/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function parseMessage(block) {
  const m = block.match(/^De:\s*(.*)\nData:\s*(.*)\n\n([\s\S]*)$/);
  if (!m) return { from: "", date: "", text: block };
  return { from: m[1].trim(), date: m[2].trim(), text: m[3].trim() };
}

function renderBody(body) {
  const blocks = splitMessages(body);
  const el = $("pane-body");
  if (!blocks.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = blocks
    .map((block, i) => {
      const { from, date, text } = parseMessage(block);
      const last = i === blocks.length - 1;
      return `<div class="msg-card ${last ? "open" : ""}">
        <div class="msg-head">
          <span class="msg-from">${escHtml(from)}</span>
          <span class="msg-date">${escHtml(date)}</span>
        </div>
        <div class="msg-text">${escHtml(text)}</div>
      </div>`;
    })
    .join("");
  el.querySelectorAll(".msg-head").forEach((head) => {
    head.onclick = () => head.closest(".msg-card").classList.toggle("open");
  });
}

function setTab(name) {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.tab === name);
  });
  $("tab-resumo").classList.toggle("hidden", name !== "resumo");
  $("tab-texto").classList.toggle("hidden", name !== "texto");
}

function mailPathId() {
  const match = location.pathname.match(/^\/mail\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function renderChat() {
  const el = $("chat-messages");
  el.innerHTML = chatHistory
    .map((msg) => {
      if (msg.role === "user") {
        return `<div class="chat-msg user">${escHtml(msg.text)}</div>`;
      }
      if (msg.placeholder) {
        return `<div class="chat-msg ai muted-msg">${escHtml(msg.text)}</div>`;
      }
      return `<div class="chat-msg ai"><div class="draft-label">Rascunho</div>${escHtml(msg.text)}</div>`;
    })
    .join("");
  el.scrollTop = el.scrollHeight;
  updateSendBar();
}

function lastDraft() {
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    if (chatHistory[i].role === "ai" && !chatHistory[i].placeholder) {
      return chatHistory[i].text;
    }
  }
  return "";
}

function updateSendBar() {
  const draft = lastDraft();
  const bar = $("send-bar");
  if (!draft) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  $("send-target").textContent = `Para: ${currentTo || "?"}`;
  $("pane-send").disabled = !canSend;
  $("pane-send").title = canSend ? "" : "Reautorize o Gmail (Entrar no Gmail) para poder enviar.";
}

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SUMMARY_HEADERS = ["Pedido:", "Fatos:", "Decisão/ação de Leo:", "Ruído:"];

function formatSummary(text) {
  return escHtml(text || "")
    .split("\n")
    .map((line) => {
      const header = SUMMARY_HEADERS.find((h) => line.trim().startsWith(h));
      if (!header) return line;
      const rest = line.trim().slice(header.length);
      return `<strong>${header}</strong>${rest}`;
    })
    .join("\n");
}

async function openPane(id, force) {
  paneId = id;
  chatHistory = [];
  $("pane").classList.remove("hidden");
  $("pane-status").textContent = "Carregando…";
  $("pane-summary").textContent = "";
  $("pane-body").textContent = "";
  renderAttachments([]);
  renderChat();
  loadAttachments();
  const q = force ? "?force=true" : "";
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}${q}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    $("pane-status").textContent = data.detail || "Não abriu o e-mail.";
    return;
  }
  $("pane-subject").textContent = data.subject || "";
  $("pane-from").textContent = data.from_email || "";
  currentTo = data.from_email || "";
  $("pane-status").textContent = data.warning || (data.cached ? "Do cache" : "Gerado agora");
  $("pane-summary").innerHTML = formatSummary(data.summary);
  renderBody(data.body || "");
  chatHistory = Array.isArray(data.chat) ? data.chat.slice() : [];
  if (!chatHistory.length && !data.warning) {
    chatHistory.push({
      role: "ai",
      text: "Sem sugestão automática pra este e-mail. Fale aqui embaixo para eu gerar a resposta.",
      placeholder: true,
    });
  }
  renderChat();
  if (data.subject) document.title = data.subject + " · IA.Email";
  setTab("resumo");
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.onclick = () => setTab(btn.dataset.tab);
});

$("pane-close").onclick = () => {
  if (mailPathId()) {
    window.location.href = "/";
    return;
  }
  $("pane").classList.add("hidden");
};

// Mark single thread as read
$("pane-mark-read").onclick = async () => {
  if (!paneId) return;
  $("pane-mark-read").disabled = true;
  try {
    await fetch(`/api/threads/${paneId}/mark-read`, { method: "POST" });
    if (mailPathId()) {
      window.location.href = "/";
    } else {
      $("pane").classList.add("hidden");
      await loadRadar({ preload: false });
    }
  } finally {
    $("pane-mark-read").disabled = false;
  }
};

$("pane-resumir").onclick = () => paneId && openPane(paneId, true);

// ── Anexos ──
function renderAttachments(files) {
  const el = $("attach-list");
  if (!files.length) {
    el.innerHTML = "";
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = files
    .map(
      (f) => `<span class="attach-chip" data-name="${escHtml(f.name)}">
        📎 ${escHtml(f.name)} <span class="size">${(f.size / 1024).toFixed(0)}KB</span>
        <button type="button" data-remove="${escHtml(f.name)}">×</button>
      </span>`
    )
    .join("");
  el.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.onclick = async () => {
      await fetch(`/api/threads/${paneId}/attachments/${encodeURIComponent(btn.dataset.remove)}`, {
        method: "DELETE",
      });
      loadAttachments();
    };
  });
}

async function loadAttachments() {
  if (!paneId) return;
  const res = await fetch(`/api/threads/${paneId}/attachments`);
  const data = await res.json().catch(() => ({ files: [] }));
  renderAttachments(data.files || []);
}

$("pane-attach").onclick = () => $("pane-file").click();

$("pane-file").onchange = async () => {
  if (!paneId || !$("pane-file").files.length) return;
  for (const file of $("pane-file").files) {
    const form = new FormData();
    form.append("file", file);
    await fetch(`/api/threads/${paneId}/attachments`, { method: "POST", body: form });
  }
  $("pane-file").value = "";
  await loadAttachments();
};

$("pane-send").onclick = async () => {
  if (!paneId) return;
  const text = lastDraft();
  if (!text) return;
  const subject = $("pane-subject").textContent || "(sem assunto)";
  const preview = text.length > 160 ? text.slice(0, 160).trim() + "…" : text;
  const ok = confirm(
    `Enviar para ${currentTo}\n` +
      `Assunto: Re: ${subject}\n\n` +
      `"${preview}"\n\n` +
      `Esta ação é definitiva — o e-mail sai imediatamente e não pode ser desfeito.`
  );
  if (!ok) return;
  $("pane-send").disabled = true;
  $("pane-send").textContent = "Enviando…";
  try {
    const res = await fetch(`/api/threads/${paneId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $("pane-status").textContent = data.detail || "Falha ao enviar.";
      return;
    }
    $("pane-status").textContent = `Enviado para ${data.to}.`;
    $("send-bar").classList.add("hidden");
    renderAttachments([]);
    if (mailPathId()) {
      setTimeout(() => (window.location.href = "/"), 900);
    } else {
      setTimeout(() => {
        $("pane").classList.add("hidden");
        loadRadar({ preload: false });
      }, 900);
    }
  } finally {
    $("pane-send").disabled = false;
    $("pane-send").innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px;vertical-align:middle;margin-right:4px"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>Enviar e-mail';
  }
};

// Auto-resize textarea
$("pane-instr").addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 280) + "px";
});

// Send with Enter (Shift+Enter for newline)
$("pane-instr").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("pane-gen").click();
  }
});

$("pane-gen").onclick = async () => {
  if (!paneId) return;
  const instruction = $("pane-instr").value.trim();
  if (!instruction) return;

  chatHistory = chatHistory.filter((m) => !m.placeholder);
  chatHistory.push({ role: "user", text: instruction });
  renderChat();
  $("pane-instr").value = "";
  $("pane-instr").style.height = "auto";

  $("pane-status").textContent = "Gerando rascunho…";
  $("pane-gen").disabled = true;

  try {
    const res = await fetch(`/api/threads/${paneId}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: instruction,
        comment: "",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $("pane-status").textContent = data.detail || "Falha no rascunho.";
      return;
    }
    if (Array.isArray(data.chat) && data.chat.length) {
      chatHistory = data.chat.slice();
      renderChat();
    } else if (data.draft) {
      chatHistory.push({ role: "ai", text: data.draft });
      renderChat();
    }
    $("pane-status").textContent = "Rascunho gerado. Nada foi enviado.";
  } finally {
    $("pane-gen").disabled = false;
  }
};

(async () => {
  const mailId = mailPathId();
  const status = await loadStatus();
  if (mailId) {
    document.body.classList.add("conversation");
    $("back-inbox").classList.remove("hidden");
    $("btn-refresh").classList.add("hidden");
    await openPane(mailId);
    return;
  }
  await loadRadar();
  if (status.authenticated && !status.last_refresh && !status.cached) {
    refresh(false);
  }
})();
