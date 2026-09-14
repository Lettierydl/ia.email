const $ = (id) => document.getElementById(id);

// Navegação aqui é troca de página de verdade (/ e /mail/<id>), não SPA --
// o navegador tenta restaurar o scroll sozinho, mas a lista é montada via
// fetch depois do load, então a restauração automática roda cedo demais e
// perde a posição. Guardamos e reaplicamos na mão.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
const LIST_SCROLL_KEY = "ia_email_list_scroll";
window.addEventListener("pagehide", () => {
  if (!mailPathId()) sessionStorage.setItem(LIST_SCROLL_KEY, String(window.scrollY));
});

let restoreHidden = false;
let chatHistory = [];
let currentTo = "";
let canSend = false;
let ACCOUNT_EMAIL = "";
let PRELOAD_ENABLED = true;
let PRELOAD_COUNT = 2;
let pendingCc = []; // e-mails confirmados pra copiar, vindos do "adicione fulano" no chat
let lastRecipients = { to: [], cc: [] };

function tags(item) {
  const out = [];
  if (item.fyi_only) out.push(["SÓ CÓPIA · SEM AÇÃO", "fyi"]);
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
  const quickRead = item.fyi_only
    ? `<button type="button" class="quick-read" data-id="${item.id}" data-tooltip="Marcar como lido (só cópia, sem ação)">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z"/></svg>
      </button>`
    : "";
  const notInterested = item.is_marketing
    ? `<button type="button" class="quick-not-interested" data-id="${item.id}" data-tooltip="Não tenho interesse (remetente vai pra Promoções sempre)">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8 0-1.85.63-3.55 1.69-4.9L16.9 18.31C15.55 19.37 13.85 20 12 20zm6.31-3.1L7.1 5.69C8.45 4.63 10.15 4 12 4c4.41 0 8 3.59 8 8 0 1.85-.63 3.55-1.69 4.9z"/></svg>
      </button>`
    : "";
  return `<a class="card${item.fyi_only ? " fyi" : ""}" href="${href}" data-id="${item.id}">
    <header>
      <span class="from">${item.from_email || item.from_name}</span>
      <span class="time">${item.time}</span>
      ${quickRead}
      ${notInterested}
    </header>
    <div class="subject">${item.subject}</div>
    <div class="snippet">${item.snippet || ""}</div>
    <div class="tags">${tags(item)}</div>
  </a>`;
}

document.addEventListener("click", (e) => {
  const readBtn = e.target.closest(".quick-read");
  if (readBtn) {
    e.preventDefault();
    e.stopPropagation();
    const id = readBtn.dataset.id;
    readBtn.disabled = true;
    fetch(`/api/threads/${id}/mark-read`, { method: "POST" })
      .then(() => {
        kickPreload();
        loadRadar({ preload: false });
      })
      .catch(() => {
        readBtn.disabled = false;
      });
    return;
  }
  const niBtn = e.target.closest(".quick-not-interested");
  if (niBtn) {
    e.preventDefault();
    e.stopPropagation();
    const id = niBtn.dataset.id;
    niBtn.disabled = true;
    fetch(`/api/threads/${id}/not-interested`, { method: "POST" })
      .then(() => loadRadar({ preload: false }))
      .catch(() => {
        niBtn.disabled = false;
      });
    return;
  }
  const emptyBtn = e.target.closest(".empty-refresh");
  if (emptyBtn) {
    emptyBtn.disabled = true;
    emptyBtn.textContent = "Buscando…";
    refresh().finally(() => {
      emptyBtn.disabled = false;
      emptyBtn.textContent = "Buscar mais e-mails";
    });
  }
});

function renderList(id, items) {
  const el = $(id);
  if (!items.length) {
    el.innerHTML = `<div class="empty-list">
      <p>Nada aqui.</p>
      <button type="button" class="ghost empty-refresh">Buscar mais e-mails</button>
    </div>`;
    return;
  }
  el.innerHTML = items.map(card).join("");
}

function qs() {
  const params = new URLSearchParams();
  if ($("q").value.trim()) params.set("q", $("q").value.trim());
  if ($("acao").checked) params.set("acao_sua", "true");
  if (restoreHidden) params.set("restore_hidden", "true");
  const s = params.toString();
  return s ? `?${s}` : "";
}

let lastAutoIds = [];
let lastUnreadAllIds = [];

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
    $("c-promotions").textContent = (data.promotions || []).length;
    $("btn-hidden").textContent = `Restaurar ocultos (${data.hidden})`;
    if (data.last_refresh) {
      $("updated").textContent = data.last_refresh;
    }
    renderList("unread", data.unread);
    renderList("waiting", data.waiting);
    renderList("automatic", data.automatic);
    renderList("promotions", data.promotions || []);

    lastAutoIds = data.automatic.map((item) => item.id);
    lastUnreadAllIds = [...data.unread, ...data.automatic, ...(data.promotions || [])]
      .filter((item) => item.is_unread)
      .map((item) => item.id);
    $("n-mark-all").textContent = lastUnreadAllIds.length;
    $("btn-mark-all-read").disabled = lastUnreadAllIds.length === 0;
    const autoSection = $("btn-auto-read").closest("article");
    if (data.automatic.length === 0 && autoSection) {
      autoSection.style.display = "none";
    } else if (autoSection) {
      autoSection.style.display = "";
    }

    if (options.preload !== false && !document.hidden) {
      preloadEnds(data.unread, data.waiting, data.automatic, data.promotions || []);
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
  ACCOUNT_EMAIL = (data.account || "").toLowerCase();
  PRELOAD_ENABLED = data.preload_enabled !== false;
  PRELOAD_COUNT = data.preload_count || 2;
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
  } else if (!data.can_calendar) {
    $("setup").classList.add("hidden");
    $("btn-auth").textContent = "Autorizar calendário";
    $("btn-auth").classList.remove("hidden");
    showBanner(
      'Calendário ainda não autorizado. Clique em "Autorizar calendário" pra ver conflitos e responder convites por aqui.',
      true
    );
  } else if (!data.can_people) {
    $("setup").classList.add("hidden");
    $("btn-auth").textContent = "Autorizar fotos de contato";
    $("btn-auth").classList.remove("hidden");
    showBanner(
      'Fotos de contato ainda não autorizadas. Clique em "Autorizar fotos de contato" pra ver a foto de quem te manda e-mail (quando disponível).',
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
  $("btn-refresh").classList.add("spinning");
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
    $("btn-refresh").classList.remove("spinning");
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

$("btn-mark-all-read").onclick = async () => {
  if (!lastUnreadAllIds.length) return;
  const proceed = window.confirm(
    `Marcar ${lastUnreadAllIds.length} e-mail(s) não lido(s) como lido no Gmail?`
  );
  if (!proceed) return;
  const btn = $("btn-mark-all-read");
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "Marcando…";
  try {
    const res = await fetch("/api/mark-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: lastUnreadAllIds }),
    });
    btn.innerHTML = original;
    if (res.ok) {
      await loadRadar({ preload: false });
    }
  } finally {
    btn.disabled = lastUnreadAllIds.length === 0;
  }
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
  const n = Math.max(1, PRELOAD_COUNT);
  if (ids.length <= n * 2) return ids;
  const picked = [...ids.slice(0, n), ...ids.slice(-n)];
  return [...new Set(picked)];
}

// N primeiros + N ultimos de CADA secao (nao lidos, aguardando, automaticos,
// promocoes) -- antes so cobria "nao lidos", entao abrir um card de outra
// secao caia sempre no caminho lento (gerar resumo na hora). N e se liga/
// desliga em Configurações.
async function preloadEnds(...sections) {
  if (!PRELOAD_ENABLED || document.hidden || preloadBusy) return;
  const batches = [];
  for (const list of sections) {
    if (!list || !list.length) continue;
    const missing = list.filter((item) => !item.has_summary).map((item) => item.id);
    const ids = pickPreload(missing.length ? missing : list.map((item) => item.id));
    const pending = ids.filter((id) => {
      const row = list.find((item) => item.id === id);
      return row && !row.has_summary;
    });
    if (pending.length) batches.push(pending);
  }
  if (!batches.length) return;
  preloadBusy = true;
  try {
    // Um POST por secao: cada uma ja vem cortada em 2+2 no cliente, entao o
    // corte global do backend (mesma regra, por seguranca) nao reduz de novo.
    for (const ids of batches) {
      await fetch("/api/preload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
    }
    if (!document.hidden) await loadRadar({ preload: false });
  } finally {
    preloadBusy = false;
  }
}

// Dispara o preload dos proximos 2+2 ANTES de navegar (ex.: logo apos
// marcar como lido), pra dar um tempo de vantagem ao backend em vez de
// so comecar depois que a proxima pagina termina de carregar.
async function kickPreload() {
  if (!PRELOAD_ENABLED) return;
  try {
    const res = await fetch(`/api/radar${qs()}`);
    const data = await res.json();
    const sections = [data.unread, data.waiting, data.automatic, data.promotions || []];
    for (const list of sections) {
      if (!list || !list.length) continue;
      const missing = list.filter((item) => !item.has_summary).map((item) => item.id);
      const ids = pickPreload(missing.length ? missing : list.map((item) => item.id));
      if (ids.length) {
        fetch("/api/preload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
          keepalive: true,
        });
      }
    }
  } catch {
    // silencioso: preload e best-effort
  }
}

function splitMessages(body) {
  return (body || "")
    .split(/\n\n----\n\n/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function formatDatePt(raw) {
  const dt = new Date(raw);
  if (isNaN(dt.getTime())) return raw;
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(dt);
}

function parseMessage(block) {
  const m = block.match(/^De:\s*(.*)\nData:\s*(.*)\n\n([\s\S]*)$/);
  if (!m) return { from: "", date: "", text: block };
  return { from: m[1].trim(), date: formatDatePt(m[2].trim()), text: m[3].trim() };
}

// "Fulano" <fulano@x.com> -> {name, email}
function parseFrom(raw) {
  const m = raw.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim().toLowerCase() };
  return { name: raw.trim(), email: raw.trim().toLowerCase() };
}

function initials(name) {
  const parts = name.replace(/[<>"]/g, "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarColor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 55%, 42%)`;
}

// Separa o corpo da mensagem do histórico citado (Gmail sempre repete os
// e-mails anteriores no final -- "Em ... escreveu:" seguido de linhas com
// ">"), pra poder esconder isso atrás de um "..." como o próprio Gmail faz.
const QUOTE_RE = /\n(?=>? ?(?:Em [\s\S]{0,160}?escreveu:|On [\s\S]{0,160}?wrote:))/;
function splitQuoted(text) {
  const m = text.match(QUOTE_RE);
  if (!m || m.index === undefined) return { main: text, quoted: null };
  return { main: text.slice(0, m.index).trimEnd(), quoted: text.slice(m.index).trim() };
}

// Vira links clicáveis. O Gmail embrulha todo link em texto puro num
// redirect de rastreio (google.com/url?q=...) -- aqui a gente desembrulha
// pra mostrar (e apontar) o link real, do jeito que aparece no Gmail.
function linkify(text) {
  const urlRe = /https?:\/\/[^\s<>"')]+/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = urlRe.exec(text))) {
    out += escHtml(text.slice(last, m.index));
    let raw = m[0];
    let trail = "";
    const trailMatch = raw.match(/[.,;:!?]+$/);
    if (trailMatch) {
      trail = trailMatch[0];
      raw = raw.slice(0, -trail.length);
    }
    let href = raw;
    let display = raw;
    if (/^https?:\/\/(www\.)?google\.com\/url\?/.test(raw)) {
      try {
        const real = new URL(raw).searchParams.get("q");
        if (real) {
          href = real;
          display = real;
        }
      } catch {
        // mantém raw se a URL vier malformada
      }
    }
    out += `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">${escHtml(display)}</a>${escHtml(trail)}`;
    last = m.index + m[0].length;
  }
  out += escHtml(text.slice(last));
  return out;
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
      const { name, email } = parseFrom(from);
      const { main, quoted } = splitQuoted(text);
      const last = i === blocks.length - 1;
      const quotedHtml = quoted
        ? `<div class="quote-toggle-row">
             <button type="button" class="quote-toggle">Ver texto completo</button>
           </div>
           <div class="msg-quoted hidden">${linkify(quoted)}</div>`
        : "";
      return `<div class="msg-card ${last ? "open" : ""}" data-idx="${i}">
        <div class="msg-head">
          <span class="avatar" data-email="${escHtml(email)}" style="background:${avatarColor(email || name)}">${escHtml(initials(name))}</span>
          <span class="msg-from">${escHtml(from)}</span>
          <span class="msg-date">${escHtml(date)}</span>
        </div>
        <div class="msg-text">${linkify(main)}${quotedHtml}</div>
      </div>`;
    })
    .join("");
  el.querySelectorAll(".quote-toggle").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const quotedEl = btn.closest(".quote-toggle-row").nextElementSibling;
      const nowHidden = quotedEl.classList.toggle("hidden");
      btn.textContent = nowHidden ? "Ver texto completo" : "Ocultar texto citado";
    };
  });
  el.querySelectorAll(".msg-head").forEach((head) => {
    head.onclick = () => head.closest(".msg-card").classList.toggle("open");
  });
  renderBodyAttachments(lastGmailAttachments);
  loadAvatarPhotos(el.querySelectorAll(".avatar"));
}

// Troca o avatar de iniciais pela foto real quando o Google People API
// (contatos + diretório do Workspace) encontra uma. Silencioso se não
// achar ou se a permissão ainda não foi concedida -- fica no fallback.
function loadAvatarPhotos(avatarEls) {
  const seen = new Set();
  avatarEls.forEach((el) => {
    const email = el.dataset.email;
    if (!email || seen.has(email)) return;
    seen.add(email);
    fetch(`/api/avatar?email=${encodeURIComponent(email)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.photo_url) return;
        document.querySelectorAll(`.avatar[data-email="${CSS.escape(email)}"]`).forEach((node) => {
          const img = document.createElement("img");
          img.src = data.photo_url;
          img.alt = "";
          img.referrerPolicy = "no-referrer";
          img.onerror = () => img.remove();
          node.textContent = "";
          node.style.background = "transparent";
          node.appendChild(img);
        });
      })
      .catch(() => {});
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

// Quando a instrução pede pra "adicionar fulano", o backend tenta achar
// o e-mail real (apelido cadastrado ou histórico de remetentes). Resolvido
// sozinho -> já entra em pendingCc. Ambíguo -> a pessoa escolhe qual
// "fulano" é (renderCcResolution cria os botões); não achado -> só avisa.
function addPendingCc(email) {
  const e = (email || "").trim().toLowerCase();
  if (e && !pendingCc.includes(e)) pendingCc.push(e);
}

function applyCcResolution(msg) {
  if (!msg || !Array.isArray(msg.cc_resolution)) return;
  msg.cc_resolution.forEach((entry) => {
    if (entry.status === "resolved" && entry.candidates && entry.candidates[0]) {
      entry.chosen = entry.candidates[0].email;
      addPendingCc(entry.chosen);
    }
  });
}

function renderCcResolution(msg, msgIdx) {
  if (!Array.isArray(msg.cc_resolution) || !msg.cc_resolution.length) return "";
  const rows = msg.cc_resolution
    .map((entry, ccIdx) => {
      if (entry.chosen) {
        return `<div class="cc-resolution-row done">✓ Copiar: ${escHtml(entry.chosen)}</div>`;
      }
      if (entry.status === "not_found") {
        return `<div class="cc-resolution-row muted">Não achei e-mail pra "${escHtml(entry.query)}" — adicione manualmente no Cc ao enviar.</div>`;
      }
      // ambiguous: mostra as opções pra escolher
      const opts = entry.candidates
        .map(
          (c) =>
            `<button type="button" data-cc-pick="${msgIdx}:${ccIdx}" data-cc-email="${escHtml(c.email)}">${escHtml(c.name || c.email)} &lt;${escHtml(c.email)}&gt;</button>`
        )
        .join("");
      return `<div class="cc-resolution-row">
        <span class="cc-resolution-q">Quem é "${escHtml(entry.query)}"?</span>
        <div class="cc-resolution-opts">${opts}<button type="button" data-cc-pick="${msgIdx}:${ccIdx}" data-cc-email="">nenhum desses</button></div>
      </div>`;
    })
    .join("");
  return `<div class="cc-resolution">${rows}</div>`;
}

function renderChat() {
  const el = $("chat-messages");
  el.innerHTML = chatHistory
    .map((msg, idx) => {
      if (msg.role === "user") {
        return `<div class="chat-msg user">${escHtml(msg.text)}</div>`;
      }
      if (msg.placeholder) {
        return `<div class="chat-msg ai muted-msg">${escHtml(msg.text)}</div>`;
      }
      const ccHtml = renderCcResolution(msg, idx);
      if (msg.kind === "answer") {
        return `<div class="chat-msg ai answer"><div class="draft-label">Resposta</div>${escHtml(msg.text)}${ccHtml}</div>`;
      }
      return `<div class="chat-msg ai"><div class="draft-label">Rascunho</div>${escHtml(msg.text)}${ccHtml}</div>`;
    })
    .join("");
  el.querySelectorAll("[data-cc-pick]").forEach((btn) => {
    btn.onclick = () => {
      const [msgIdx, ccIdx] = btn.dataset.ccPick.split(":").map(Number);
      const entry = chatHistory[msgIdx] && chatHistory[msgIdx].cc_resolution[ccIdx];
      if (!entry) return;
      entry.chosen = btn.dataset.ccEmail || "(nenhum)";
      if (btn.dataset.ccEmail) addPendingCc(btn.dataset.ccEmail);
      renderChat();
    };
  });
  el.scrollTop = el.scrollHeight;
  updateSendBar();
  updateChatResetState();
}

// Lixeira de reiniciar conversa só fica clicável quando há mesmo o que
// limpar: conversa real, rascunho, texto digitado ou anotação pendente.
function updateChatResetState() {
  const hasChat = chatHistory.some((m) => !m.placeholder);
  const hasTyped = $("pane-instr").value.trim().length > 0;
  $("pane-chat-reset").disabled = !hasChat && !hasTyped && !annotations.length;
}

function lastDraft() {
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    const m = chatHistory[i];
    // kind ausente = mensagem antiga (de antes dessa distinção existir),
    // trata como rascunho pra não quebrar conversas já salvas.
    if (m.role === "ai" && !m.placeholder && m.kind !== "answer") {
      return m.text;
    }
  }
  return "";
}

function updateSendBar() {
  const draft = lastDraft();
  const bar = $("send-bar");
  if (!draft) {
    bar.classList.add("hidden");
    $("pane-send").disabled = true;
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

function renderCaptureSuggestion(note, status) {
  const card = $("capture-suggestion");
  if (!note || status !== "pending") {
    card.classList.add("hidden");
    return;
  }
  $("capture-note-text").textContent = note;
  card.classList.remove("hidden");
}

$("capture-dismiss").onclick = async () => {
  if (!paneId) return;
  $("capture-suggestion").classList.add("hidden");
  await fetch(`/api/threads/${paneId}/capture/dismiss`, { method: "POST" });
};

$("capture-approve").onclick = async () => {
  if (!paneId) return;
  $("capture-approve").disabled = true;
  try {
    const res = await fetch(`/api/threads/${paneId}/capture/approve`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      $("capture-suggestion").classList.add("hidden");
      $("pane-status").textContent = `Guardado no cérebro (${data.path}).`;
    } else {
      $("pane-status").textContent = data.detail || "Falha ao guardar.";
    }
  } finally {
    $("capture-approve").disabled = false;
  }
};

// ── Convite de calendário ──
function renderCalTimeline(allEvents) {
  const wrap = $("invite-timeline");
  const hoursEl = $("invite-hours");
  // Eventos de dia inteiro nao entram na timeline por horario (mesma
  // convencao do Google Calendar) -- a data "so dia" tambem nao tem fuso
  // confiavel pra entrar na mesma escala dos eventos com hora.
  const events = allEvents.filter((e) => !e.all_day);
  if (!events.length) {
    wrap.innerHTML = "";
    hoursEl.innerHTML = "";
    return;
  }

  const HOUR_PX = 56;
  const items = events.map((e) => {
    const start = new Date(e.start_iso).getTime();
    const end = e.end_iso ? new Date(e.end_iso).getTime() : start + 30 * 60000;
    return { ...e, startMs: start, endMs: Math.max(end, start + 15 * 60000) };
  });

  let minMs = Math.min(...items.map((i) => i.startMs));
  let maxMs = Math.max(...items.map((i) => i.endMs));
  const HOUR = 3600000;
  minMs = Math.floor(minMs / HOUR) * HOUR - HOUR / 2;
  maxMs = Math.ceil(maxMs / HOUR) * HOUR + HOUR / 2;
  const totalHours = (maxMs - minMs) / HOUR;
  wrap.style.setProperty("--hour-px", `${HOUR_PX}px`);
  wrap.style.height = `${totalHours * HOUR_PX}px`;
  hoursEl.style.height = `${totalHours * HOUR_PX}px`;

  // Colunas pra eventos sobrepostos, igual timeline do Google.
  const sorted = [...items].sort((a, b) => a.startMs - b.startMs);
  const colEnds = [];
  sorted.forEach((ev) => {
    let placed = false;
    for (let c = 0; c < colEnds.length; c++) {
      if (colEnds[c] <= ev.startMs) {
        ev.col = c;
        colEnds[c] = ev.endMs;
        placed = true;
        break;
      }
    }
    if (!placed) {
      ev.col = colEnds.length;
      colEnds.push(ev.endMs);
    }
  });
  const totalCols = colEnds.length || 1;

  wrap.innerHTML = sorted
    .map((ev) => {
      const top = ((ev.startMs - minMs) / HOUR) * HOUR_PX;
      const height = ((ev.endMs - ev.startMs) / HOUR) * HOUR_PX;
      const left = (ev.col / totalCols) * 100;
      const width = 100 / totalCols;
      const cls = [
        "cal-event",
        ev.is_target ? "target" : "",
        ev.is_conflict ? "conflict" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const timeLabel = ev.all_day ? "Dia inteiro" : `${ev.start}–${ev.end}`;
      return `<div class="${cls}" style="top:${top}px;height:${Math.max(height, 20)}px;left:${left}%;width:calc(${width}% - 4px)">
        <div class="cal-event-title">${escHtml(ev.summary)}</div>
        <div class="cal-event-time">${timeLabel}</div>
      </div>`;
    })
    .join("");

  const hourLabels = [];
  for (let t = minMs; t <= maxMs; t += HOUR) {
    const top = ((t - minMs) / HOUR) * HOUR_PX;
    const label = new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    hourLabels.push(`<span class="hour-label" style="top:${top}px">${label}</span>`);
  }
  hoursEl.innerHTML = hourLabels.join("");

  const target = sorted.find((ev) => ev.is_target);
  if (target) {
    const targetTop = ((target.startMs - minMs) / HOUR) * HOUR_PX;
    const container = wrap.closest("#invite-timeline-wrap");
    if (container) {
      container.scrollTop = Math.max(targetTop - container.clientHeight / 2, 0);
    }
  }
}

async function loadInvite(id) {
  try {
    const res = await fetch(`/api/threads/${id}/invite`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.is_invite) {
      $("invite-card").classList.add("hidden");
      return;
    }
    $("invite-summary").textContent = data.summary || "Convite de calendário";
    $("invite-time").textContent = data.start
      ? `${data.day_label || "Hoje"} das ${data.start} às ${data.end || "?"}`
      : "";

    const conflictsEl = $("invite-conflicts");
    if (data.conflicts && data.conflicts.length) {
      conflictsEl.innerHTML =
        `<strong>⚠️ Conflito com ${data.conflicts.length} evento(s):</strong>` +
        data.conflicts.map((c) => `${c.start}–${c.end} ${escHtml(c.summary)}`).join("<br>");
      conflictsEl.classList.remove("hidden");
    } else {
      conflictsEl.classList.add("hidden");
    }

    $("invite-rsvp").classList.toggle("hidden", !!data.needs_calendar_scope);
    $("invite-status").textContent = data.needs_calendar_scope
      ? "Reautorize o Gmail (Entrar no Gmail) pra ver conflitos e responder por aqui."
      : data.calendar_error || "";
    $("invite-card").dataset.uid = data.uid || "";
    // Desesconde ANTES de montar a timeline: com display:none o container
    // tem clientHeight/scrollHeight zerados e o auto-scroll pro horario do
    // evento nao funciona.
    $("invite-card").classList.remove("hidden");
    renderCalTimeline(data.events || []);
  } catch {
    $("invite-card").classList.add("hidden");
  }
}

document.querySelectorAll(".rsvp-btn").forEach((btn) => {
  btn.onclick = async () => {
    if (!paneId) return;
    document.querySelectorAll(".rsvp-btn").forEach((b) => (b.disabled = true));
    try {
      const res = await fetch(`/api/threads/${paneId}/invite/rsvp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: btn.dataset.response }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        document.querySelectorAll(".rsvp-btn").forEach((b) =>
          b.classList.toggle("active", b === btn)
        );
        $("invite-status").textContent = "Resposta enviada.";
        fetch(`/api/threads/${paneId}/mark-read`, { method: "POST" }).then(() =>
          kickPreload()
        );
      } else {
        $("invite-status").textContent = data.detail || "Falha ao responder.";
      }
    } finally {
      document.querySelectorAll(".rsvp-btn").forEach((b) => (b.disabled = false));
    }
  };
});

async function openPane(id, force) {
  paneId = id;
  chatHistory = [];
  $("pane").classList.remove("hidden");
  $("pane-status").textContent = "Carregando…";
  $("pane-summary").textContent = "";
  $("pane-summary").classList.add("loading");
  $("pane-body").textContent = "";
  $("invite-card").classList.add("hidden");
  $("pane-cc").classList.add("hidden");
  $("pane-instr").value = "";
  $("pane-instr").style.height = "auto";
  $("pane-gen").disabled = true;
  annotations = [];
  $("annot-chip").classList.add("hidden");
  $("annot-popup").classList.add("hidden");
  pendingCc = [];
  lastRecipients = { to: [], cc: [] };
  renderAttachments([]);
  lastGmailAttachments = { files: [], message_ids: [] };
  renderChat();
  loadAttachments();
  loadGmailAttachments(id);
  loadRecipients(id);
  const q = force ? "?force=true" : "";
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(`/api/threads/${encodeURIComponent(id)}${q}`, {
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $("pane-summary").classList.remove("loading");
      $("pane-status").textContent = data.detail || "Não abriu o e-mail.";
      return;
    }
    $("pane-subject").textContent = data.subject || "";
    $("pane-from").textContent = data.from_email || "";
    currentTo = data.from_email || "";
    $("pane-status").textContent = data.warning || (data.cached ? "Do cache" : "Gerado agora");
    $("pane-summary").classList.remove("loading");
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
    renderCaptureSuggestion(data.capture_note, data.capture_status);
    loadInvite(id);
    if (data.subject) document.title = data.subject + " · IA.Email";
    setTab("resumo");
  } catch (err) {
    console.error("openPane falhou", err);
    $("pane-summary").classList.remove("loading");
    const timedOut = err && err.name === "AbortError";
    $("pane-status").textContent = timedOut
      ? "Demorou demais pra responder (60s). Tente de novo."
      : "Erro ao carregar este e-mail. Tente de novo.";
  } finally {
    clearTimeout(killer);
  }
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
    await kickPreload();
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

// ── Anexos recebidos no e-mail (Gmail) ──
// Mostrados dentro do Texto completo, junto da mensagem que trouxe cada um
// (imagem vira preview inline, o resto vira chip com Abrir/Baixar).
function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(0)}KB`;
}

let lastGmailAttachments = { files: [], message_ids: [] };

function gmailAttachmentUrl(f) {
  return `/api/threads/${paneId}/gmail-attachments/${encodeURIComponent(
    f.message_id
  )}/${encodeURIComponent(f.attachment_id)}?filename=${encodeURIComponent(f.filename)}`;
}

function renderBodyAttachments(data) {
  const files = (data && data.files) || [];
  const messageIds = (data && data.message_ids) || [];
  document.querySelectorAll("#pane-body .msg-attachments").forEach((n) => n.remove());
  if (!files.length) return;
  const byMessage = {};
  files.forEach((f) => {
    (byMessage[f.message_id] = byMessage[f.message_id] || []).push(f);
  });
  document.querySelectorAll("#pane-body .msg-card").forEach((card) => {
    const msgId = messageIds[Number(card.dataset.idx)];
    const list = msgId && byMessage[msgId];
    if (!list || !list.length) return;
    const holder = document.createElement("div");
    holder.className = "msg-attachments";
    holder.innerHTML = list
      .map((f) => {
        const url = gmailAttachmentUrl(f);
        if ((f.mime_type || "").startsWith("image/")) {
          return `<a class="msg-inline-image" href="${url}" target="_blank" rel="noopener" data-tooltip="Abrir imagem original">
            <img src="${url}" alt="${escHtml(f.filename)}" loading="lazy" />
          </a>`;
        }
        return `<span class="attach-chip gmail">
          📎 ${escHtml(f.filename)} <span class="size">${formatSize(f.size)}</span>
          <a href="${url}" target="_blank" rel="noopener" data-tooltip="Abrir em nova aba">Abrir</a>
          <a href="${url}" download="${escHtml(f.filename)}" data-tooltip="Baixar">↓</a>
        </span>`;
      })
      .join("");
    card.appendChild(holder);
  });
}

async function loadGmailAttachments(id) {
  try {
    const res = await fetch(`/api/threads/${encodeURIComponent(id)}/gmail-attachments`);
    const data = await res.json().catch(() => ({ files: [], message_ids: [] }));
    if (paneId !== id) return;
    lastGmailAttachments = data;
    renderBodyAttachments(data);
  } catch {
    // silencioso: anexos sao um extra, nao trava o resto do painel
  }
}

// ── Para / Cc (quem mais recebeu o e-mail) ──
function fmtAddr(a) {
  return a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email;
}

function renderRecipients(data) {
  lastRecipients = { to: (data && data.to) || [], cc: (data && data.cc) || [] };
  const badge = $("pane-cc");
  const to = (data && data.to) || [];
  const cc = (data && data.cc) || [];
  // Tira o proprio Leo da lista de "Para" pra so mostrar quem mais entrou.
  const toOthers = to.filter((a) => (a.email || "").toLowerCase() !== ACCOUNT_EMAIL);
  if (!toOthers.length && !cc.length) {
    badge.classList.add("hidden");
    return;
  }
  const lines = [];
  if (toOthers.length) lines.push(`Para: ${toOthers.map(fmtAddr).join(", ")}`);
  if (cc.length) lines.push(`Cc: ${cc.map(fmtAddr).join(", ")}`);
  badge.dataset.tooltip = lines.join("\n");
  $("pane-cc-count").textContent = toOthers.length + cc.length;
  badge.classList.remove("hidden");
}

async function loadRecipients(id) {
  try {
    const res = await fetch(`/api/threads/${encodeURIComponent(id)}/recipients`);
    const data = await res.json().catch(() => ({ to: [], cc: [] }));
    if (paneId === id) renderRecipients(data);
  } catch {
    // silencioso: e um extra informativo, nao trava o resto do painel
  }
}

$("pane-attach").onclick = () => $("pane-file").click();

async function uploadFiles(files) {
  if (!paneId || !files.length) return;
  for (const file of files) {
    const form = new FormData();
    form.append("file", file);
    await fetch(`/api/threads/${paneId}/attachments`, { method: "POST", body: form });
  }
  await loadAttachments();
}

$("pane-file").onchange = async () => {
  await uploadFiles([...$("pane-file").files]);
  $("pane-file").value = "";
};

// Colar imagem (Ctrl+V) na caixa de instrução: como o e-mail sai em texto
// puro, nao da pra embutir a imagem "no meio do texto" de verdade -- ela
// vira anexo de verdade, igual ao botao de clipe.
$("pane-instr").addEventListener("paste", async (e) => {
  const items = [...(e.clipboardData ? e.clipboardData.items : [])];
  const imageItems = items.filter((it) => it.type.startsWith("image/"));
  if (!imageItems.length || !paneId) return;
  e.preventDefault();
  const files = imageItems.map((it, i) => {
    const blob = it.getAsFile();
    const ext = (it.type.split("/")[1] || "png").split("+")[0];
    return new File([blob], `colado-${Date.now()}-${i}.${ext}`, { type: it.type });
  });
  $("pane-status").textContent = "Anexando imagem colada…";
  await uploadFiles(files);
  $("pane-status").textContent = "Imagem anexada. Descreva no texto se quer que ela seja citada na resposta.";
});

// ── Exportar contexto pra outra IA ──
$("pane-export-ctx").onclick = async () => {
  if (!paneId) return;
  const btn = $("pane-export-ctx");
  btn.disabled = true;
  try {
    const res = await fetch(`/api/threads/${paneId}/export-context`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $("pane-status").textContent = data.detail || "Falha ao exportar contexto.";
      return;
    }
    try {
      await navigator.clipboard.writeText(data.prompt);
      $("pane-status").textContent = `Contexto salvo em ${data.path} — prompt copiado, é só colar no chat da IA.`;
    } catch {
      $("pane-status").textContent = `Contexto salvo em ${data.path}. Prompt: ${data.prompt}`;
    }
  } finally {
    btn.disabled = false;
  }
};

// Limpa a conversa do chat (rascunho + histórico) e recomeça do zero,
// tanto na tela quanto no que fica salvo pro e-mail.
$("pane-chat-reset").onclick = async () => {
  if (!paneId) return;
  const btn = $("pane-chat-reset");
  btn.disabled = true;
  try {
    await fetch(`/api/threads/${paneId}/chat/reset`, { method: "POST" });
    chatHistory = [
      {
        role: "ai",
        text: "Sem sugestão automática pra este e-mail. Fale aqui embaixo para eu gerar a resposta.",
        placeholder: true,
      },
    ];
    renderChat();
    $("pane-instr").value = "";
    $("pane-instr").style.height = "auto";
    clearAllAnnotations();
    pendingCc = [];
    updateGenButtonState();
    $("pane-status").textContent = "Conversa reiniciada.";
  } finally {
    updateChatResetState();
  }
};

// Sugestao "responder a todos": quem mais estava em Para/Cc na ultima
// mensagem, tirando o proprio Leo e quem ja vai no Para principal --
// somada ao que foi confirmado no chat via "adicione fulano".
function defaultCcSuggestion() {
  const seen = new Set([ACCOUNT_EMAIL, (currentTo || "").toLowerCase()]);
  const out = [];
  [...lastRecipients.to, ...lastRecipients.cc].forEach((a) => {
    const email = (a.email || "").toLowerCase();
    if (email && !seen.has(email)) {
      seen.add(email);
      out.push(email);
    }
  });
  pendingCc.forEach((email) => {
    if (!seen.has(email)) {
      seen.add(email);
      out.push(email);
    }
  });
  return out.join(", ");
}

// Se o texto fala em "anexo"/"anexei"/"segue em anexo" mas não tem
// nenhum arquivo de verdade anexado na resposta, é quase sempre esquecimento.
function draftMentionsAttachment(text) {
  return /anex/i.test(text || "");
}

function currentAttachmentCount() {
  return $("attach-list").querySelectorAll(".attach-chip").length;
}

function openSendModal() {
  const text = lastDraft();
  if (!paneId || !text) return;
  const subject = $("pane-subject").textContent || "(sem assunto)";
  $("modal-to").textContent = currentTo;
  $("modal-cc").value = defaultCcSuggestion();
  $("modal-subject").textContent = subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`;
  $("modal-preview").textContent = text;
  $("modal-attach-warning").classList.toggle(
    "hidden",
    !(draftMentionsAttachment(text) && currentAttachmentCount() === 0)
  );
  $("send-modal").classList.remove("hidden");
}

function closeSendModal() {
  $("send-modal").classList.add("hidden");
}

$("pane-send").onclick = openSendModal;
$("modal-cancel").onclick = closeSendModal;
$("send-modal").onclick = (e) => {
  if (e.target === $("send-modal")) closeSendModal();
};

$("modal-confirm").onclick = async () => {
  const text = lastDraft();
  if (!paneId || !text) return;
  if (draftMentionsAttachment(text) && currentAttachmentCount() === 0) {
    const proceed = window.confirm(
      "O texto menciona anexo, mas nenhum arquivo foi anexado a essa resposta. Enviar mesmo assim?"
    );
    if (!proceed) return;
  }
  $("modal-confirm").disabled = true;
  $("modal-confirm").textContent = "Enviando…";
  try {
    const res = await fetch(`/api/threads/${paneId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, cc: $("modal-cc").value.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    closeSendModal();
    if (!res.ok) {
      $("pane-status").textContent = data.detail || "Falha ao enviar.";
      return;
    }
    $("pane-status").textContent = data.cc ? `Enviado para ${data.to} (Cc: ${data.cc}).` : `Enviado para ${data.to}.`;
    $("send-bar").classList.add("hidden");
    renderAttachments([]);
    pendingCc = [];
    kickPreload();
    if (mailPathId()) {
      setTimeout(() => (window.location.href = "/"), 900);
    } else {
      setTimeout(() => {
        $("pane").classList.add("hidden");
        loadRadar({ preload: false });
      }, 900);
    }
  } finally {
    $("modal-confirm").disabled = false;
    $("modal-confirm").textContent = "Enviar agora";
  }
};

// Autocomplete de e-mail no campo Cc do modal de envio, baseado no
// histórico de remetentes -- mesma ideia do apelido nas Configurações,
// mas aqui funciona por segmento (o campo aceita vários e-mails
// separados por vírgula).
(function setupCcAutocomplete() {
  const input = $("modal-cc");
  const box = $("modal-cc-suggestions");
  let timer = null;

  function currentSegment() {
    const parts = input.value.split(",");
    return { parts, last: parts[parts.length - 1].trim() };
  }

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const { last } = currentSegment();
    if (last.length < 2) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    timer = setTimeout(async () => {
      const res = await fetch(`/api/settings/alias-suggest?q=${encodeURIComponent(last)}`);
      const data = await res.json().catch(() => ({ suggestions: [] }));
      const suggestions = data.suggestions || [];
      if (!suggestions.length) {
        box.classList.add("hidden");
        box.innerHTML = "";
        return;
      }
      box.innerHTML = suggestions
        .map(
          (s, i) => `<button type="button" data-sugg="${i}">
            <span class="sugg-name">${escHtml(s.name || s.email)}</span>
            <span class="sugg-email">${escHtml(s.email)}</span>
          </button>`
        )
        .join("");
      box.querySelectorAll("[data-sugg]").forEach((btn) => {
        btn.onclick = () => {
          const s = suggestions[Number(btn.dataset.sugg)];
          const { parts } = currentSegment();
          parts[parts.length - 1] = ` ${s.email}`;
          input.value = parts.join(",").replace(/^,\s*/, "").trim() + ", ";
          box.classList.add("hidden");
          box.innerHTML = "";
          input.focus();
        };
      });
      box.classList.remove("hidden");
    }, 250);
  });

  document.addEventListener("mousedown", (e) => {
    if (!box.contains(e.target) && e.target !== input) box.classList.add("hidden");
  });
})();

// Botão de gerar ativa com texto na caixa OU com anotações pendentes
// (dá pra mandar só anotação, sem escrever nada no campo livre).
function updateGenButtonState() {
  $("pane-gen").disabled = !$("pane-instr").value.trim() && !annotations.length;
  updateChatResetState();
}

function composedInstruction() {
  const free = $("pane-instr").value.trim();
  if (!annotations.length) return free;
  const notes = annotations
    .map((a, i) => `[${i + 1}] Sobre "${a.quote}": ${a.comment || "(sem comentário)"}`)
    .join("\n");
  return free ? `${notes}\n\n${free}` : notes;
}

// O que aparece na bolha do chat fica "camuflado": a referência ao trecho
// já está marcada no próprio texto (o numerozinho), então aqui só mostra
// o que a pessoa realmente escreveu -- sem repetir a citação inteira.
function visibleChatText() {
  const free = $("pane-instr").value.trim();
  if (free) return free;
  const comments = annotations.map((a) => a.comment).filter(Boolean);
  if (comments.length) return comments.join("\n");
  return annotations.length > 1 ? "(anotações sem comentário)" : "(anotação sem comentário)";
}

// Auto-resize textarea + botão de gerar só ativa com texto de verdade
$("pane-instr").addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 280) + "px";
  updateGenButtonState();
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
  const freeText = $("pane-instr").value.trim();
  if (!freeText && !annotations.length) return;
  const instruction = composedInstruction();
  const visibleText = visibleChatText();

  chatHistory = chatHistory.filter((m) => !m.placeholder);
  chatHistory.push({ role: "user", text: visibleText });
  renderChat();
  $("pane-instr").value = "";
  $("pane-instr").style.height = "auto";
  clearAllAnnotations();

  $("pane-status").textContent = "Gerando rascunho…";
  $("pane-gen").disabled = true; // esvaziou a caixa, então continua desabilitado no finally

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
      applyCcResolution(chatHistory[chatHistory.length - 1]);
      renderChat();
    } else if (data.draft) {
      chatHistory.push({ role: "ai", text: data.draft });
      renderChat();
    }
    $("pane-status").textContent = "Rascunho gerado. Nada foi enviado.";
  } finally {
    updateGenButtonState();
  }
};

// ── Selecionar trecho -> anotação ancorada no texto (igual ao Codex) ──
// Seleciona um pedaço do resumo/thread, marca aquele trecho com um
// número (badge azul) e abre uma caixinha ali do lado pra comentar em
// cima daquele pedaço específico. As anotações viram contexto
// direcionado quando o próximo rascunho é gerado no chat.
let annotations = [];
let annotationSeq = 0;

function annotationChipUpdate() {
  const chip = $("annot-chip");
  if (!annotations.length) {
    chip.classList.add("hidden");
    updateGenButtonState();
    return;
  }
  chip.textContent = `${annotations.length} anotaç${annotations.length > 1 ? "ões" : "ão"}`;
  chip.classList.remove("hidden");
  updateGenButtonState();
}

function unwrapAnnotationMark(annot) {
  if (annot.mark && annot.mark.parentNode) {
    const parent = annot.mark.parentNode;
    while (annot.mark.firstChild) parent.insertBefore(annot.mark.firstChild, annot.mark);
    parent.removeChild(annot.mark);
    parent.normalize();
  }
  if (annot.badge && annot.badge.parentNode) annot.badge.remove();
}

function renumberAnnotations() {
  annotations.forEach((a, i) => {
    if (a.badge) a.badge.textContent = String(i + 1);
  });
}

function removeAnnotation(id) {
  const idx = annotations.findIndex((a) => a.id === id);
  if (idx === -1) return;
  const [annot] = annotations.splice(idx, 1);
  unwrapAnnotationMark(annot);
  renumberAnnotations();
  annotationChipUpdate();
}

function clearAllAnnotations() {
  annotations.forEach(unwrapAnnotationMark);
  annotations = [];
  annotationChipUpdate();
}

function wrapSelectionAsAnnotation(range) {
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

(function setupAnnotations() {
  const toolbar = $("select-toolbar");
  const btn = $("select-add-chat");
  const popup = $("annot-popup");
  const textarea = $("annot-popup-textarea");
  let pendingRange = null;

  function hideToolbar() {
    toolbar.classList.add("hidden");
    pendingRange = null;
  }

  document.addEventListener("mouseup", () => {
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (!text || !paneId) {
        hideToolbar();
        return;
      }
      const areas = [$("pane-summary"), $("pane-body")];
      const inArea = areas.some((el) => el && sel.anchorNode && el.contains(sel.anchorNode));
      if (!inArea) {
        hideToolbar();
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) {
        hideToolbar();
        return;
      }
      pendingRange = sel.getRangeAt(0).cloneRange();
      const left = Math.min(
        Math.max(8, rect.left + rect.width / 2 - 90),
        window.innerWidth - 220
      );
      toolbar.style.left = `${left}px`;
      toolbar.style.top = `${Math.max(8, rect.top - 42)}px`;
      toolbar.classList.remove("hidden");
    }, 0);
  });

  document.addEventListener("mousedown", (e) => {
    if (!toolbar.contains(e.target)) hideToolbar();
  });
  window.addEventListener("scroll", hideToolbar, true);
  window.addEventListener("resize", hideToolbar);

  function positionPopupNear(el) {
    const rect = el.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left - 20), window.innerWidth - 300);
    const top = Math.min(rect.bottom + 8, window.innerHeight - 140);
    popup.style.left = `${left}px`;
    popup.style.top = `${Math.max(8, top)}px`;
  }

  function closePopup() {
    popup.classList.add("hidden");
    popup.dataset.annotId = "";
  }

  function openPopupForNew(mark, badge, quote) {
    const id = ++annotationSeq;
    mark.dataset.annotId = String(id);
    badge.dataset.annotId = String(id);
    annotations.push({ id, quote, comment: "", mark, badge });
    renumberAnnotations();
    annotationChipUpdate();
    popup.dataset.annotId = String(id);
    textarea.value = "";
    positionPopupNear(badge);
    popup.classList.remove("hidden");
    textarea.focus();
  }

  function openPopupForExisting(id, anchorEl) {
    const annot = annotations.find((a) => a.id === id);
    if (!annot) return;
    popup.dataset.annotId = String(id);
    textarea.value = annot.comment;
    positionPopupNear(anchorEl);
    popup.classList.remove("hidden");
    textarea.focus();
  }

  btn.onclick = (e) => {
    // sem isso, o mesmo clique borbulha até o document e o listener de
    // "clicou fora" logo abaixo fecha o popup que acabou de abrir
    e.stopPropagation();
    if (!pendingRange) return;
    const quote = pendingRange.toString().trim();
    window.getSelection().removeAllRanges();
    const { mark, badge } = wrapSelectionAsAnnotation(pendingRange);
    hideToolbar();
    openPopupForNew(mark, badge, quote.length > 600 ? `${quote.slice(0, 600)}…` : quote);
  };

  document.addEventListener("click", (e) => {
    const anchorEl = e.target.closest(".annot-badge, .annot-mark");
    if (anchorEl) {
      const id = Number(anchorEl.dataset.annotId);
      openPopupForExisting(id, anchorEl);
      return;
    }
    if (!popup.contains(e.target)) closePopup();
  });

  $("annot-cancel").onclick = () => {
    const id = Number(popup.dataset.annotId);
    removeAnnotation(id);
    closePopup();
  };

  $("annot-delete").onclick = () => {
    const id = Number(popup.dataset.annotId);
    removeAnnotation(id);
    closePopup();
  };

  $("annot-save").onclick = () => {
    const id = Number(popup.dataset.annotId);
    const annot = annotations.find((a) => a.id === id);
    if (annot) annot.comment = textarea.value.trim();
    closePopup();
  };

  $("annot-chip").onclick = () => {
    if (!annotations.length) return;
    openPopupForExisting(annotations[annotations.length - 1].id, $("annot-chip"));
  };
})();

// ── Configurações: base de contexto, estilo, apelidos, arquivos ──
(function setupSettings() {
  function formatBytes(n) {
    if (!n) return "0B";
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
  }

  function formatWhen(tsSeconds) {
    if (!tsSeconds) return "";
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(tsSeconds * 1000));
  }

  function renderAliases(aliases) {
    const el = $("cfg-aliases-list");
    if (!aliases.length) {
      el.innerHTML = '<p class="files-empty">Nenhum apelido cadastrado ainda.</p>';
      return;
    }
    el.innerHTML = aliases
      .map(
        (a) => `<div class="alias-row" data-alias="${escHtml(a.alias)}">
          <span class="alias-tag">${escHtml(a.alias)}</span>
          <span class="alias-detail">${escHtml(a.name)}${a.email ? ` &lt;${escHtml(a.email)}&gt;` : ""}</span>
          <button type="button" data-remove-alias="${escHtml(a.alias)}" data-tooltip="Excluir">×</button>
        </div>`
      )
      .join("");
    el.querySelectorAll("[data-remove-alias]").forEach((btn) => {
      btn.onclick = async () => {
        await fetch(`/api/settings/aliases/${encodeURIComponent(btn.dataset.removeAlias)}`, {
          method: "DELETE",
        });
        loadAliases();
      };
    });
  }

  async function loadAliases() {
    const res = await fetch("/api/settings/aliases");
    const data = await res.json().catch(() => ({ aliases: [] }));
    renderAliases(data.aliases || []);
  }

  async function loadSettingsForm() {
    const res = await fetch("/api/settings");
    const data = await res.json().catch(() => ({}));
    const s = data.settings || {};
    $("cfg-context-enabled").checked = !!s.context_enabled;
    $("cfg-context-paths").value = (s.context_paths || []).join("\n");
    $("cfg-context-global-enabled").checked = !!s.context_global_enabled;
    $("cfg-context-global-paths").value = (s.context_global_paths || []).join("\n");
    $("cfg-style-preset").value = s.style_preset || "neutro";
    $("cfg-style-custom").value = s.style_custom || "";
    $("cfg-preload-enabled").checked = s.preload_enabled !== false;
    $("cfg-preload-count").value = s.preload_count || 2;
    renderAliases(data.aliases || []);
  }

  function renderFiles(el, files, opts) {
    if (!files.length) {
      el.innerHTML = '<p class="files-empty">Nada aqui.</p>';
      return;
    }
    el.innerHTML = files
      .map((f) => {
        const label = f.path || f.name;
        const delBtn = opts && opts.deletable
          ? `<button type="button" data-del-file="${escHtml(f.name)}" data-tooltip="Apagar">🗑</button>`
          : "";
        return `<div class="file-row">
          <span class="file-path" data-tooltip="${escHtml(label)}">${escHtml(label)}</span>
          <span class="file-meta">${formatBytes(f.size)} · ${formatWhen(f.modified_at)}</span>
          ${delBtn}
        </div>`;
      })
      .join("");
    if (opts && opts.deletable) {
      el.querySelectorAll("[data-del-file]").forEach((btn) => {
        btn.onclick = async () => {
          await fetch(`/api/settings/generated-files/${encodeURIComponent(btn.dataset.delFile)}`, {
            method: "DELETE",
          });
          loadGeneratedFiles();
        };
      });
    }
  }

  async function loadContextFiles() {
    const el = $("cfg-context-files-list");
    el.innerHTML = '<p class="files-empty">Carregando…</p>';
    const res = await fetch("/api/settings/context-files?base=email");
    const data = await res.json().catch(() => ({ files: [] }));
    renderFiles(el, data.files || [], { deletable: false });
  }

  async function loadContextGlobalFiles() {
    const el = $("cfg-context-global-files-list");
    el.innerHTML = '<p class="files-empty">Carregando…</p>';
    const res = await fetch("/api/settings/context-files?base=global");
    const data = await res.json().catch(() => ({ files: [] }));
    renderFiles(el, data.files || [], { deletable: false });
  }

  async function loadGeneratedFiles() {
    const res = await fetch("/api/settings/generated-files");
    const data = await res.json().catch(() => ({ exports: [], context_md: null }));
    renderFiles($("cfg-generated-files-list"), data.exports || [], { deletable: true });
    const info = $("cfg-context-md-info");
    if (data.context_md) {
      info.textContent = `context.md (conhecimento acumulado, não apagável por aqui): ${data.context_md.path} — ${formatBytes(data.context_md.size)}`;
    } else {
      info.textContent = "context.md ainda não existe.";
    }
  }

  async function openSettingsModal() {
    $("settings-modal").classList.remove("hidden");
    $("cfg-context-status").textContent = "";
    $("cfg-context-global-status").textContent = "";
    $("cfg-style-status").textContent = "";
    await loadSettingsForm();
    loadContextFiles();
    loadContextGlobalFiles();
    loadGeneratedFiles();
  }

  $("btn-settings").onclick = openSettingsModal;
  $("settings-close").onclick = () => $("settings-modal").classList.add("hidden");
  $("settings-modal").addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") $("settings-modal").classList.add("hidden");
  });

  $("cfg-context-save").onclick = async () => {
    const paths = $("cfg-context-paths")
      .value.split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context_enabled: $("cfg-context-enabled").checked, context_paths: paths }),
    });
    $("cfg-context-status").textContent = "Salvo.";
    loadContextFiles();
  };

  $("cfg-context-global-save").onclick = async () => {
    const paths = $("cfg-context-global-paths")
      .value.split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context_global_enabled: $("cfg-context-global-enabled").checked,
        context_global_paths: paths,
      }),
    });
    $("cfg-context-global-status").textContent = "Salvo.";
    loadContextGlobalFiles();
  };

  $("cfg-style-save").onclick = async () => {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        style_preset: $("cfg-style-preset").value,
        style_custom: $("cfg-style-custom").value.trim(),
      }),
    });
    $("cfg-style-status").textContent = "Salvo.";
  };

  $("cfg-preload-save").onclick = async () => {
    const count = Math.max(1, parseInt($("cfg-preload-count").value, 10) || 2);
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preload_enabled: $("cfg-preload-enabled").checked,
        preload_count: count,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.settings) {
      PRELOAD_ENABLED = data.settings.preload_enabled !== false;
      PRELOAD_COUNT = data.settings.preload_count || 2;
    }
    $("cfg-preload-status").textContent = "Salvo.";
  };

  $("cfg-alias-add").onclick = async () => {
    const alias = $("cfg-alias-new-alias").value.trim();
    const name = $("cfg-alias-new-name").value.trim();
    const email = $("cfg-alias-new-email").value.trim();
    if (!alias) return;
    await fetch("/api/settings/aliases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias, name, email }),
    });
    $("cfg-alias-new-alias").value = "";
    $("cfg-alias-new-name").value = "";
    $("cfg-alias-new-email").value = "";
    loadAliases();
  };

  $("cfg-context-files-refresh").onclick = loadContextFiles;
  $("cfg-context-global-files-refresh").onclick = loadContextGlobalFiles;

  $("cfg-generated-files-delete-all").onclick = async () => {
    const btn = $("cfg-generated-files-delete-all");
    btn.disabled = true;
    try {
      await fetch("/api/settings/generated-files", { method: "DELETE" });
      loadGeneratedFiles();
    } finally {
      btn.disabled = false;
    }
  };

  // Sugestao de remetente ao digitar o apelido: procura no historico de
  // e-mails quem bate com o texto, pra nao precisar digitar o e-mail na
  // mao (e nao errar).
  let aliasSuggestTimer = null;
  $("cfg-alias-new-alias").addEventListener("input", function () {
    clearTimeout(aliasSuggestTimer);
    const q = this.value.trim();
    const box = $("cfg-alias-suggestions");
    if (q.length < 2) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    aliasSuggestTimer = setTimeout(async () => {
      const res = await fetch(`/api/settings/alias-suggest?q=${encodeURIComponent(q)}`);
      const data = await res.json().catch(() => ({ suggestions: [] }));
      const suggestions = data.suggestions || [];
      if (!suggestions.length) {
        box.classList.add("hidden");
        box.innerHTML = "";
        return;
      }
      box.innerHTML = suggestions
        .map(
          (s, i) => `<button type="button" data-sugg="${i}">
            <span class="sugg-name">${escHtml(s.name || s.email)}</span>
            <span class="sugg-email">${escHtml(s.email)}</span>
          </button>`
        )
        .join("");
      box.querySelectorAll("[data-sugg]").forEach((btn) => {
        btn.onclick = () => {
          const s = suggestions[Number(btn.dataset.sugg)];
          $("cfg-alias-new-name").value = s.name || "";
          $("cfg-alias-new-email").value = s.email || "";
          box.classList.add("hidden");
          box.innerHTML = "";
        };
      });
      box.classList.remove("hidden");
    }, 250);
  });
  document.addEventListener("mousedown", (e) => {
    const box = $("cfg-alias-suggestions");
    if (!box.contains(e.target) && e.target.id !== "cfg-alias-new-alias") {
      box.classList.add("hidden");
    }
  });
})();

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
  const savedScroll = sessionStorage.getItem(LIST_SCROLL_KEY);
  if (savedScroll) window.scrollTo(0, parseInt(savedScroll, 10));
  if (status.authenticated && !status.last_refresh && !status.cached) {
    refresh(false);
  }
})();
