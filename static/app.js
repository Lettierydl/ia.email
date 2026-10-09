const $ = (id) => document.getElementById(id);

// Navegação aqui é troca de página de verdade (/ e /mail/<id>), não SPA --
// o navegador tenta restaurar o scroll sozinho, mas a lista é montada via
// fetch depois do load, então a restauração automática roda cedo demais e
// perde a posição. Guardamos e reaplicamos na mão.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
const LIST_SCROLL_KEY = "ia_email_list_scroll";
window.addEventListener("pagehide", () => {
  if (location.pathname === "/") sessionStorage.setItem(LIST_SCROLL_KEY, String(window.scrollY));
  if (paneId && window.DraftPersist) {
    const ta = $("pane-draft");
    if (ta) window.DraftPersist.flushBeacon(paneId, ta.value);
  }
});
window.addEventListener("beforeunload", () => {
  if (paneId && window.DraftPersist) {
    const ta = $("pane-draft");
    if (ta) window.DraftPersist.flushBeacon(paneId, ta.value);
  }
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
// Para/Cc em chips (static/recipients.js), editáveis no composer e no modal
// de envio. Padrão = o que o envio usaria (reply_to/reply_cc do /recipients).
let mailRc = { to: [], cc: [], participants: [], touched: false };
let mailRcData = {}; // resposta completa do /recipients
let mailRcInstr = ""; // último pedido "responda a X" (para o aviso de destinatário)
let mailRcKeep = ""; // "Manter" clicado neste aviso
// Responder a UMA mensagem da thread (static/msgreply.js): { idx, all, id, label } | null
let mailTarget = null;
let mailMsgs = []; // {from, date} de cada mensagem da thread (rótulo do alvo sem Gmail)
// Configurações do Copiloto: "Ao enviar, marcar como resolvido e voltar ao quadro"
// (no /mail: voltar à lista). Padrão ligado.
let sendResolveBack = true;
fetch("/api/copilot/settings").then((r) => r.json()).then((p) => { sendResolveBack = p.send_resolve_back !== false; }).catch(() => {});

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
  const viewOriginal = `<button type="button" class="quick-view-original" data-id="${item.id}" data-tooltip="Ver e-mail original">
        ${Icons.svg("eye")}
      </button>`;
  const quickReadTooltip = item.fyi_only ? "Marcar como lido (só cópia, sem ação)" : "Marcar como lido";
  const quickRead = `<button type="button" class="quick-read" data-id="${item.id}" data-tooltip="${quickReadTooltip}">
        ${Icons.svg("check-circle-double")}
      </button>`;
  const notInterested = item.is_marketing
    ? `<button type="button" class="quick-not-interested" data-id="${item.id}" data-tooltip="Não tenho interesse (remetente vai pra Promoções sempre)">
        ${Icons.svg("role-ignorar")}
      </button>`
    : "";
  const from = escHtml(item.from_email || item.from_name || "");
  const subject = escHtml(item.subject || "(sem assunto)");
  const snippet = escHtml(item.snippet || "");
  return `<a class="card${item.fyi_only ? " fyi" : ""}${item.is_unread ? " unread" : ""}" href="${href}" data-id="${item.id}">
    <div class="row-main">
      <span class="from" title="${from}">${from}</span>
      <span class="subject-line">
        <span class="subject-text">${subject}</span>${snippet ? ` <span class="snippet-text">— ${snippet}</span>` : ""}
      </span>
      <span class="card-right">
        <span class="time">${item.time}</span>
        <span class="card-actions">
          ${viewOriginal}
          ${quickRead}
          ${notInterested}
        </span>
      </span>
    </div>
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
let lastPromoUnreadIds = [];
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
    $("c-sent").textContent = (data.sent || []).length;
    $("btn-hidden").textContent = `Restaurar ocultos (${data.hidden})`;
    if (data.last_refresh) {
      $("updated").textContent = data.last_refresh;
    }
    renderList("unread", data.unread);
    renderList("waiting", data.waiting);
    renderList("automatic", data.automatic);
    renderList("promotions", data.promotions || []);
    renderList("sent", data.sent || []);

    lastAutoIds = data.automatic.map((item) => item.id);
    lastPromoUnreadIds = (data.promotions || []).filter((item) => item.is_unread).map((item) => item.id);
    lastUnreadAllIds = [...data.unread, ...data.automatic, ...(data.promotions || [])]
      .filter((item) => item.is_unread)
      .map((item) => item.id);
    $("n-mark-all").textContent = lastUnreadAllIds.length;
    $("btn-mark-all-read").disabled = lastUnreadAllIds.length === 0;
    $("btn-auto-read").disabled = lastAutoIds.length === 0;
    $("btn-promo-read").disabled = lastPromoUnreadIds.length === 0;

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
    const who = data.llm_model || data.llm_provider;
    const label = tokens ? `${who} · ${tokens.toLocaleString("pt-BR")} tokens hoje` : who;
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
// Abas da caixa (Não lidos/Aguardando/Automáticos/Promoções/Enviados) --
// só uma lista visível por vez, igual às abas do Gmail.
function switchListTab(name) {
  document.querySelectorAll(".mail-tab").forEach((btn) => {
    btn.classList.toggle("on", btn.dataset.listTab === name);
  });
  document.querySelectorAll("[data-list-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.listPanel !== name);
  });
  $("btn-auto-read").classList.toggle("hidden", name !== "automatic");
  $("btn-promo-read").classList.toggle("hidden", name !== "promotions");
}
document.querySelectorAll(".mail-tab").forEach((btn) => {
  btn.onclick = () => switchListTab(btn.dataset.listTab);
});

$("m-unanswered").onclick = () => switchListTab("waiting");
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
  const n = lastUnreadAllIds.length;
  const proceed = await window.Dialog.confirm({
    title: `Marcar ${n} e-mail${n === 1 ? "" : "s"} como lido${n === 1 ? "" : "s"}?`,
    body: "Todos os não lidos desta lista ficam como lidos no Gmail.",
    ok: "Marcar como lido", cancel: "Cancelar",
  });
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

// ── Marcar lidos em massa (Automáticos / Promoções) ──
// Botão silenciava qualquer falha (permissão, erro do Gmail, etc): dava
// a impressão de "não funciona" quando na real só não tinha feedback
// nenhum. Agora mostra erro no banner se a chamada falhar, e avisa se
// clicado sem nada pra marcar (defensivo -- o botão já fica disabled
// nesse caso, mas evita ficar mudo se algo ficar dessincronizado).
const MARK_READ_ICON = Icons.svg("check-circle-double", { size: 16, cls: "ic-inline" });

async function markReadBulk(ids, btn) {
  if (!ids.length) {
    showBanner("Nada pra marcar como lido aqui.", true);
    setTimeout(() => showBanner("", false), 2500);
    return;
  }
  btn.disabled = true;
  btn.textContent = "Marcando…";
  try {
    const res = await fetch("/api/mark-read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      await loadRadar({ preload: false });
    } else {
      showBanner(bannerDetail(data), true);
    }
  } catch {
    showBanner("Falha de rede ao marcar como lido.", true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = MARK_READ_ICON;
  }
}

$("btn-auto-read").onclick = () => markReadBulk(lastAutoIds, $("btn-auto-read"));
$("btn-promo-read").onclick = () => markReadBulk(lastPromoUnreadIds, $("btn-promo-read"));

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
  mailMsgs = blocks.map((b) => { const { from, date } = parseMessage(b); return { from, date }; });
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
      // O toggle "Ver texto completo" fica no fim do texto principal --
      // se a mensagem for longa, ninguém percebe que tem e-mail anterior
      // citado escondido lá embaixo. Por isso também avisa logo no
      // cabeçalho da mensagem, de forma clicável, pra achar sem rolar tudo.
      const quotedHint = quoted
        ? `<button type="button" class="msg-quoted-hint" data-tooltip="Esta mensagem cita um e-mail anterior -- clique pra ver">${Icons.svg("reply", { size: 14 })} e-mail anterior citado</button>`
        : "";
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
          ${quotedHint}
          <span class="msg-date">${escHtml(date)}</span>
          ${window.MsgReply ? MsgReply.headHTML(i) : ""}
          ${window.MsgSummary ? MsgSummary.buttonHTML() : ""}
        </div>
        <div class="msg-text">${linkify(main)}${quotedHtml}</div>
      </div>`;
    })
    .join("");
  function toggleQuote(btn) {
    const quotedEl = btn.closest(".msg-text").querySelector(".msg-quoted");
    const nowHidden = quotedEl.classList.toggle("hidden");
    btn.closest(".msg-text").querySelector(".quote-toggle").textContent = nowHidden
      ? "Ver texto completo"
      : "Ocultar texto citado";
    return { quotedEl, nowHidden };
  }
  el.querySelectorAll(".quote-toggle").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      toggleQuote(btn);
    };
  });
  el.querySelectorAll(".msg-quoted-hint").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const card = btn.closest(".msg-card");
      card.classList.add("open");
      const quoteToggle = card.querySelector(".quote-toggle");
      const { quotedEl, nowHidden } = toggleQuote(quoteToggle);
      if (!nowHidden) quotedEl.scrollIntoView({ behavior: "smooth", block: "center" });
    };
  });
  el.querySelectorAll(".msg-head").forEach((head) => {
    head.onclick = () => head.closest(".msg-card").classList.toggle("open");
  });
  // "Resumir este e-mail" (static/msgsummary.js, o mesmo do /copilot)
  if (window.MsgSummary && paneId) MsgSummary.bind(el, paneId);
  // Para/Cc por mensagem + Responder / Responder a todos (static/msgreply.js, o mesmo do /copilot)
  if (window.MsgReply && paneId) MsgReply.bind(el, paneId, { me: ACCOUNT_EMAIL, onReply: mailReplyToMessage });
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
// "fulano" é (ChatUI, em static/chat.js, cria os botões); não achado -> só avisa.
function addPendingCc(email) {
  const e = (email || "").trim().toLowerCase();
  if (e && !pendingCc.includes(e)) pendingCc.push(e);
  // Para/Cc já editados à mão: o "adicione fulano" entra direto no Cc
  if (e && mailRc.touched && !mailRc.to.includes(e) && !mailRc.cc.includes(e)) mailRc.cc.push(e);
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

// Chat com a IA: bolhas desenhadas por static/chat.js (o mesmo do /copilot e
// do /compose). O rascunho mais recente vai para a caixa #pane-draft, que é o
// texto enviado -- editável; o chat mostra a versão resumida.
let draftAi = ""; // último rascunho da IA posto na caixa (para saber se o Leo editou)

function draftEdited() {
  const v = $("pane-draft").value.trim();
  return !!v && v !== draftAi.trim();
}

function setDraft(text, fromAi) {
  $("pane-draft").value = text || "";
  if (fromAi) draftAi = text || "";
  updateSendBar();
  updateFixBtn();
}

// ── "Corrigir português" (rascunho inteiro) e "Usar meu texto (só corrigir)" ──
let mailFixing = false;
let mailKeep = false; // toggle ligado à mão
let mailKeepOff = null; // pedido em que o Leo desligou o "detectado"
function updateFixBtn() {
  const b = $("pane-fixpt");
  if (b) b.disabled = mailFixing || !$("pane-draft").value.trim();
}
const mailKeepAuto = () => !mailKeep && mailKeepOff !== $("pane-instr").value && !!Composer.keepTextRequest($("pane-instr").value);
const mailKeepOn = () => mailKeep || mailKeepAuto();
function updateKeepChip() {
  const el = $("pane-keep");
  if (!el) return;
  const tmp = document.createElement("div");
  tmp.innerHTML = Composer.keepChipHTML("pane-keep", mailKeep, mailKeepAuto());
  el.innerHTML = tmp.firstChild.innerHTML;
  el.setAttribute("aria-pressed", tmp.firstChild.getAttribute("aria-pressed"));
  if (mailKeepOn() && $("pane-instr").value.trim()) $("pane-gen-label").textContent = "Usar meu texto";
}
$("pane-keep").onclick = () => {
  mailKeep = !mailKeepOn();
  if (!mailKeep) mailKeepOff = $("pane-instr").value;
  updateGenLabel();
  updateKeepChip();
  $("pane-instr").focus({ preventScroll: true });
};
$("pane-fixpt").onclick = async () => {
  const ta = $("pane-draft");
  const sent = ta.value;
  if (!paneId || mailFixing || !sent.trim()) return;
  const tid = paneId;
  mailFixing = true;
  updateFixBtn();
  $("pane-fixpt-label").textContent = "Corrigindo…";
  $("draft-status").textContent = "Corrigindo o português…";
  let data = null;
  let err = "";
  try { data = await Composer.fixPortuguese(tid, { text: sent }); } catch (e) { err = e.message; }
  mailFixing = false;
  $("pane-fixpt-label").textContent = "Corrigir português";
  updateFixBtn();
  if (paneId !== tid) return;
  if (err) { $("draft-status").textContent = err; return; }
  if (ta.value !== sent) { $("draft-status").textContent = "O rascunho mudou enquanto a IA corrigia; nada foi trocado."; return; }
  if (!data.changed || data.text === sent) { $("draft-status").textContent = "Nada para corrigir: o português já está certo."; return; }
  const n = annot.replaceText(ta, 0, sent.length, data.text);
  $("draft-status").textContent = "Português corrigido. Tom e conteúdo mantidos.";
  annot.notice(`Português corrigido (${n === 1 ? "1 mudança" : `${n} mudanças`}). Tom e conteúdo mantidos.`, () => annot.undo());
};

function renderChat(opts) {
  const real = chatHistory.filter((m) => !m.placeholder && !m.typing).length;
  $("chat-count").textContent = String(real);
  ChatUI.render($("chat-messages"), chatHistory, {
    compactDrafts: true,
    onCcPick: (_m, _c, email) => { if (email) addPendingCc(email); updateSendBar(); },
    onUseDraft: (text) => { setDraft(text, true); $("draft-status").textContent = "Versão anterior do rascunho na caixa."; },
  });
  // rascunho novo da IA: vai para a caixa (a não ser que o Leo tenha editado
  // e o rascunho não tenha vindo de uma geração pedida agora)
  const ai = lastDraft();
  if (ai && ai !== draftAi && ((opts && opts.forceDraft) || !draftEdited())) setDraft(ai, true);
  updateGenLabel();
  updateSendBar();
  updateChatResetState();
}

// Lixeira de reiniciar conversa só fica clicável quando há mesmo o que
// limpar: conversa real, rascunho, texto digitado ou anotação pendente.
function updateChatResetState() {
  const hasChat = chatHistory.some((m) => !m.placeholder);
  const hasTyped = $("pane-instr").value.trim().length > 0 || $("pane-draft").value.trim().length > 0;
  $("pane-chat-reset").disabled = !hasChat && !hasTyped && !annotations.length;
}

// último rascunho da IA no chat (kind ausente = mensagem antiga, vale como rascunho)
function lastDraft() {
  return ChatUI.lastDraft(chatHistory);
}

// o que vai ser enviado: o texto da caixa (rascunho da IA, editado ou não)
function currentDraft() {
  return $("pane-draft").value.trim();
}

function updateGenLabel() {
  const adjust = !!currentDraft();
  $("pane-gen-label").textContent = adjust ? "Ajustar" : "Gerar";
  $("pane-gen").dataset.tooltip = adjust ? "Ajustar o rascunho com a instrução" : "Gerar o rascunho com a instrução";
  updateKeepChip();
}

// Para/Cc da mensagem escolhida (cabeçalhos do Gmail); sem eles, o remetente do bloco.
function mailTargetRc() {
  if (!mailTarget) return null;
  const meta = window.MsgReply && paneId ? MsgReply.get(paneId) : null;
  const r = meta && MsgReply.recipientsFor(meta, mailTarget.idx, mailTarget.all, ACCOUNT_EMAIL);
  if (r && r.to.length) return r;
  const m = mailMsgs[mailTarget.idx];
  const from = m ? MsgReply.parseAddr(m.from).email : "";
  return from && from !== ACCOUNT_EMAIL ? { to: [from], cc: null } : null;
}

function mailTargetMeta() {
  const meta = mailTarget && window.MsgReply && paneId ? MsgReply.get(paneId) : null;
  return meta ? meta[mailTarget.idx] || null : null;
}

function mailTargetFromChat(chat) {
  const last = [...(chat || [])].reverse().find((m) => m.role === "ai" && m.kind !== "answer" && !m.placeholder);
  const a = last && last.alvo;
  if (!a || a.idx == null || !window.MsgReply) return null;
  return { idx: Number(a.idx), all: true, id: a.message_id || "", label: MsgReply.label({ de: a.de, data: a.data }) };
}

async function mailReplyToMessage(idx, all) {
  const id = paneId;
  const m = mailMsgs[idx] || {};
  mailTarget = { idx, all, id: "", label: MsgReply.label({ de: m.from, data: m.date }) };
  mailRc.touched = false; // destinatários voltam a sair da mensagem escolhida
  mailRcInstr = "";
  mailRcKeep = "";
  setTab("resumo");
  updateSendBar();
  const box = $("pane-composer");
  if (box && box.scrollIntoView) box.scrollIntoView({ behavior: "smooth", block: "start" });
  $("pane-instr").focus({ preventScroll: true });
  const meta = await MsgReply.load(id);
  if (paneId !== id || !mailTarget || mailTarget.idx !== idx) return;
  const mm = meta && meta[idx];
  if (mm) Object.assign(mailTarget, { id: mm.id || "", label: MsgReply.label(mm) });
  updateSendBar();
}

function clearMailTarget() {
  mailTarget = null;
  mailRc.touched = false;
  $("draft-status").textContent = "Voltou a responder à última mensagem.";
  updateSendBar();
}

function paintMailTarget() {
  const host = $("pane-target");
  if (!host) return;
  host.innerHTML = window.MsgReply ? MsgReply.bannerHTML(mailTarget, "pm") : "";
  const clear = $("pm-target-clear");
  if (clear) clear.onclick = clearMailTarget;
}

function mailRcState() {
  if (!mailRc.touched) {
    const tr = mailTargetRc();
    const to = tr ? tr.to : ((mailRcData.reply_to && mailRcData.reply_to.length) ? mailRcData.reply_to : [currentTo])
      .map((e) => (e || "").toLowerCase()).filter(Boolean);
    mailRc.to = to;
    if (tr && tr.cc) {
      const seen = new Set([ACCOUNT_EMAIL, ...to]);
      mailRc.cc = (mailTarget.all ? tr.cc : []).concat(pendingCc).filter((e) => !seen.has(e) && seen.add(e));
    } else {
      mailRc.cc = mailTarget && !mailTarget.all ? pendingCc.filter((e) => !to.includes(e)) : defaultCcSuggestion(to).split(", ").filter(Boolean);
    }
  }
  const known = new Map((mailRc.participants || []).map((p) => [p.email, p]));
  const tm = mailTargetMeta();
  [...(mailRcData.participants || []), ...(tm ? [tm.from, ...(tm.to || []), ...(tm.cc || [])] : []), ...lastRecipients.to, ...lastRecipients.cc, { email: currentTo, name: "" }].forEach((p) => {
    const e = ((p && p.email) || "").toLowerCase();
    if (e && e !== ACCOUNT_EMAIL && (!known.has(e) || (p.name && !known.get(e).name))) known.set(e, { email: e, name: p.name || "" });
  });
  mailRc.participants = [...known.values()];
  return mailRc;
}

function mailRcSuggestion() {
  const st = mailRcState();
  const text = currentDraft();
  const sug = (mailRcInstr && Recipients.suggest(text, st, { instruction: mailRcInstr, me: ACCOUNT_EMAIL }))
    || Recipients.suggest(text, st, { me: ACCOUNT_EMAIL });
  return sug && Recipients.sugKey(sug, st) !== mailRcKeep ? sug : null;
}

// Desenha chips + aviso num container (composer "pm" ou modal "md").
function paintMailRc(host, sugHost, prefix) {
  if (!host) return;
  const st = mailRcState();
  if (!host.contains(document.activeElement)) {
    host.innerHTML = Recipients.editorHTML(st, prefix);
    Recipients.bind(host, st, prefix, () => paintMailRcSug(sugHost, prefix, host));
  }
  paintMailRcSug(sugHost, prefix, host);
}

function paintMailRcSug(sugHost, prefix, host) {
  if (!sugHost) return;
  const sug = mailRcSuggestion();
  sugHost.innerHTML = Recipients.suggestHTML(sug, prefix);
  if (!sug) return;
  sugHost.querySelector(`#${prefix}-rc-swap`).onclick = () => {
    Recipients.applySuggestion(mailRcState(), sug);
    host.innerHTML = "";
    paintMailRc(host, sugHost, prefix);
  };
  sugHost.querySelector(`#${prefix}-rc-keep`).onclick = () => {
    mailRcKeep = Recipients.sugKey(sug, mailRcState());
    paintMailRcSug(sugHost, prefix, host);
  };
}

function updateSendBar() {
  const draft = currentDraft();
  paintMailTarget();
  paintMailRc($("send-target"), $("send-rc-sug"), "pm");
  const bar = $("send-bar");
  if (!draft) {
    bar.classList.add("hidden");
    $("pane-send").disabled = true;
    return;
  }
  bar.classList.remove("hidden");
  $("pane-send").disabled = !canSend;
  $("pane-send").title = canSend ? "" : "Reautorize o Gmail (Entrar no Gmail) para poder enviar.";
}

const WORKING_ICON =
  '<svg class="working-icon" viewBox="0 0 34 34" aria-hidden="true">' +
  '<rect x="3.5" y="3.5" width="21" height="27" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
  '<path class="w-line l1" d="M8.5 11h11"/><path class="w-line l2" d="M8.5 16.5h11"/><path class="w-line l3" d="M8.5 22h6"/>' +
  '<path class="w-star" d="M27 3l1.2 3 3 1.2-3 1.2L27 11.4l-1.2-3-3-1.2 3-1.2z"/>' +
  '<g class="w-pen"><path d="M22 27l6.5-6.5 2.4 2.4L24.4 29.4 21.2 30z" fill="currentColor"/></g></svg>';

// Texto + ícone animado de "a IA está trabalhando" (substitui o "Gerando…" seco).
function workingHTML(label) {
  return (
    `<span class="working" role="status" aria-live="polite">${WORKING_ICON}` +
    `<span class="working-text">${escHtml(label)}</span>` +
    '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></span>'
  );
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
      $("pane-status").textContent = data.category
        ? `Guardado no cérebro, categoria "${data.category}" (${data.path}).`
        : `Guardado no cérebro (${data.path}).`;
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

// Gmail usa o mesmo thread_id que a API já devolve pra montar o link direto
// da conversa -- authuser garante que abre na conta certa mesmo se o
// navegador tiver várias contas Google logadas.
function gmailThreadUrl(id) {
  const authuser = ACCOUNT_EMAIL ? `?authuser=${encodeURIComponent(ACCOUNT_EMAIL)}` : "";
  return `https://mail.google.com/mail/${authuser}#all/${encodeURIComponent(id)}`;
}


function showDraftChip(on, loading) {
  const chip = $("draft-chip");
  if (!chip) return;
  chip.classList.toggle("hidden", !on);
  chip.classList.toggle("loading", !!loading);
  chip.textContent = "Rascunho salvo";
}

function setPaneDraftLoading(on) {
  const wrap = $("pane-draft-wrap");
  if (wrap) wrap.classList.toggle("loading", !!on);
}

function applySavedDraft(id, text, fromAi) {
  const body = text || "";
  if (body) {
    setDraft(body, !!fromAi);
    showDraftChip(true, false);
    setPaneDraftLoading(false);
    $("draft-status").textContent = draftEdited() ? "Rascunho salvo (editado por você)." : "Rascunho salvo.";
    if (window.DraftPersist) window.DraftPersist.remember(id, body);
  } else {
    showDraftChip(false, false);
    setPaneDraftLoading(false);
  }
  updateSendBar();
  updateGenButtonState();
}

async function openPane(id, force) {
  paneId = id;
  $("pane-open-gmail").href = gmailThreadUrl(id);
  chatHistory = [];
  $("pane").classList.remove("hidden");
  $("pane-status").innerHTML = workingHTML("Lendo o e-mail e preparando o resumo");
  $("pane-summary").textContent = "";
  $("pane-summary").classList.add("loading");
  $("pane-body").textContent = "";
  $("invite-card").classList.add("hidden");
  $("pane-cc").classList.add("hidden");
  $("pane-instr").value = "";
  $("pane-instr").style.height = "auto";
  $("pane-gen").disabled = true;
  draftAi = "";
  // Rascunho: pinta na hora se já temos cache; senão skeleton + chip até a API.
  const cachedDraft = window.DraftPersist ? window.DraftPersist.cacheGet(id) : null;
  setDraft(cachedDraft || "", false);
  $("draft-status").textContent = "";
  if (cachedDraft) {
    showDraftChip(true, false);
    setPaneDraftLoading(false);
    $("draft-status").textContent = "Rascunho salvo.";
  } else {
    // Sem cache: skeleton na caixa (sem chip ainda — chip só quando API/cache confirma).
    showDraftChip(false, false);
    setPaneDraftLoading(true);
  }
  // Prefetch paralelo (GET /draft sqlite, ou cache) — não espera o analyze.
  const draftPrefetch = window.DraftPersist
    ? window.DraftPersist.prefetch(id).then((text) => {
        if (paneId !== id || text == null) return;
        if (text) applySavedDraft(id, text, false);
        else if (!currentDraft()) { showDraftChip(false, false); setPaneDraftLoading(false); }
      }).catch(() => {})
    : Promise.resolve();
  annot.reset(); // e-mail novo: esquece as anotações (as marcas sumiram com o conteúdo)
  pendingCc = [];
  lastRecipients = { to: [], cc: [] };
  mailRc = { to: [], cc: [], participants: [], touched: false };
  mailRcData = {};
  mailRcInstr = "";
  mailRcKeep = "";
  mailTarget = null;
  mailMsgs = [];
  renderAttachments([]);
  lastGmailAttachments = { files: [], message_ids: [] };
  renderChat();
  loadAttachments();
  loadGmailAttachments(id);
  loadRecipients(id);

  // Corpo cru primeiro (sem LLM, rápido) pra já mostrar o e-mail completo
  // na tela enquanto o resumo (mais lento) ainda carrega por baixo.
  // Depois do restart: original-preview também traz draft.
  fetch(`/api/threads/${encodeURIComponent(id)}/original-preview`)
    .then((res) => res.json())
    .then((data) => {
      if (paneId !== id) return;
      $("pane-subject").textContent = data.subject || "";
      $("pane-from").textContent = data.from_email || "";
      currentTo = data.from_email || "";
      renderBody(data.body || "");
      if (data.subject) document.title = data.subject + " · IA.Email";
      if (data.draft != null && data.draft !== "" && !draftEdited()) {
        applySavedDraft(id, data.draft, data.draft === lastDraft());
      } else if (data.has_draft === false && !currentDraft()) {
        showDraftChip(false, false);
        setPaneDraftLoading(false);
      }
    })
    .catch(() => {});

  const q = force ? "?force=true" : "";
  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), 120000);
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
    // o último rascunho foi para uma mensagem específica: continua nela
    if (!mailTarget) {
      mailTarget = mailTargetFromChat(chatHistory);
      if (mailTarget && !mailTarget.id) {
        const tid = id;
        MsgReply.load(tid).then((meta) => {
          const mm = meta && mailTarget && paneId === tid && meta[mailTarget.idx];
          if (mm && !mailTarget.id) { Object.assign(mailTarget, { id: mm.id || "", label: MsgReply.label(mm) }); updateSendBar(); }
        });
      }
    }
    if (!chatHistory.length && !data.warning) {
      chatHistory.push({
        role: "ai",
        text: "Sem sugestão automática pra este e-mail. Fale aqui embaixo para eu gerar a resposta.",
        placeholder: true,
      });
    }
    renderChat();
    await draftPrefetch;
    // Prefer the sqlite draft (edits do Leo) over the last chat AI draft when they differ.
    if (data.draft) {
      if (data.draft !== currentDraft()) applySavedDraft(id, data.draft, data.draft === lastDraft());
      else { showDraftChip(true, false); setPaneDraftLoading(false); if (window.DraftPersist) window.DraftPersist.remember(id, data.draft); }
    } else if (!currentDraft()) {
      showDraftChip(false, false);
      setPaneDraftLoading(false);
      if (window.DraftPersist) window.DraftPersist.cacheClear(id);
    } else {
      setPaneDraftLoading(false);
    }
    renderCaptureSuggestion(data.capture_note, data.capture_status);
    loadInvite(id);
    if (data.subject) document.title = data.subject + " · IA.Email";
    setTab("resumo");
  } catch (err) {
    console.error("openPane falhou", err);
    $("pane-summary").classList.remove("loading");
    const timedOut = err && err.name === "AbortError";
    $("pane-status").textContent = timedOut
      ? "Demorou demais pra responder (2 min). Tente de novo."
      : "Erro ao carregar este e-mail. Tente de novo.";
  } finally {
    clearTimeout(killer);
  }
}

// ── Popup "ver e-mail original" (hover no ícone de olho da lista) ──
// Mostra a última mensagem da thread crua, sem passar pelo resumo da IA --
// útil pra conferir rápido sem abrir o e-mail. O popup rola por dentro
// (thread longa) e fica aberto enquanto o mouse estiver nele ou no ícone --
// só fecha de vez (com um pequeno atraso) quando sai dos dois.
function buildOriginalPopupContent(subject, body) {
  const blocks = splitMessages(body);
  if (!blocks.length) return `<div class="original-popup-body">Sem conteúdo pra mostrar.</div>`;
  const { from, date, text } = parseMessage(blocks[blocks.length - 1]);
  const { name, email } = parseFrom(from || "");
  return `
    <div class="original-popup-head">
      <div><span class="label">De</span>${escHtml(name)}${email && email !== name ? ` &lt;${escHtml(email)}&gt;` : ""}</div>
      ${date ? `<div><span class="label">Data</span>${escHtml(date)}</div>` : ""}
      ${subject ? `<div><span class="label">Assunto</span>${escHtml(subject)}</div>` : ""}
    </div>
    <div class="original-popup-body">${escHtml(text || "(sem texto)")}</div>
  `;
}

function positionOriginalPopup(anchorEl) {
  const popup = $("original-email-popup");
  const rect = anchorEl.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  // Perto do fim da lista não cabe embaixo -- abre pra cima em vez de
  // cortar o popup na borda da tela.
  let top =
    spaceBelow >= popup.offsetHeight + 12 || spaceBelow >= spaceAbove
      ? rect.bottom + 6
      : rect.top - popup.offsetHeight - 6;
  top = Math.max(12, Math.min(top, window.innerHeight - popup.offsetHeight - 12));
  popup.style.top = `${top}px`;
  const left = Math.min(rect.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - 12);
  popup.style.left = `${Math.max(left, 12)}px`;
}

function showOriginalPopupLoading(anchorEl) {
  const popup = $("original-email-popup");
  popup.innerHTML = `<div class="original-popup-body">Carregando…</div>`;
  popup.classList.remove("hidden");
  positionOriginalPopup(anchorEl);
}

function showOriginalPopup(anchorEl, subject, body) {
  const popup = $("original-email-popup");
  popup.innerHTML = buildOriginalPopupContent(subject, body);
  popup.classList.remove("hidden");
  positionOriginalPopup(anchorEl);
}

function hideOriginalPopup() {
  $("original-email-popup").classList.add("hidden");
}

// Ícones da lista: um por card, recriados a cada renderList -- delegação de
// evento com mouseover/mouseout (que borbulham, ao contrário de
// mouseenter/mouseleave) evita ter que religar listener em cada render.
// Busca o corpo sob demanda e guarda em cache por thread_id.
(function setupListOriginalPopup() {
  const cache = {};
  let hoveredId = null;
  let hideTimer = null;

  function cancelHide() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function scheduleHide() {
    cancelHide();
    hideTimer = setTimeout(() => {
      hoveredId = null;
      hideOriginalPopup();
    }, 200);
  }

  document.addEventListener("mouseover", (e) => {
    const btn = e.target.closest(".quick-view-original");
    if (!btn) return;
    cancelHide();
    if (hoveredId === btn.dataset.id) return;
    hoveredId = btn.dataset.id;
    const id = btn.dataset.id;
    if (cache[id]) {
      showOriginalPopup(btn, cache[id].subject, cache[id].body);
      return;
    }
    showOriginalPopupLoading(btn);
    fetch(`/api/threads/${encodeURIComponent(id)}/original-preview`)
      .then((res) => res.json())
      .then((data) => {
        cache[id] = data;
        if (hoveredId === id) showOriginalPopup(btn, data.subject, data.body);
      })
      .catch(() => {
        if (hoveredId === id) hideOriginalPopup();
      });
  });

  document.addEventListener("mouseout", (e) => {
    const btn = e.target.closest(".quick-view-original");
    if (!btn || btn.contains(e.relatedTarget)) return;
    scheduleHide();
  });

  // Segura o popup aberto enquanto o mouse estiver nele (pra dar tempo de
  // rolar o conteúdo) e fecha ao sair dele de vez.
  const popup = $("original-email-popup");
  popup.addEventListener("mouseover", cancelHide);
  popup.addEventListener("mouseout", (e) => {
    if (popup.contains(e.relatedTarget)) return;
    scheduleHide();
  });
})();

document.addEventListener("click", (e) => {
  if (e.target.closest(".quick-view-original")) {
    e.preventDefault();
    e.stopPropagation();
  }
});

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
  el.innerHTML = window.Composer
    ? window.Composer.attachChipsHTML(files)
    : files.map((f) => `<span class="attach-chip">📎 ${escHtml(f.name)} <button type="button" data-attach-rm="${escHtml(f.name)}">×</button></span>`).join("");
  el.querySelectorAll("[data-attach-rm]").forEach((btn) => {
    btn.onclick = async () => {
      await fetch(`/api/threads/${paneId}/attachments/${encodeURIComponent(btn.dataset.attachRm)}`, {
        method: "DELETE",
      });
      loadAttachments();
    };
  });
  el.querySelectorAll("[data-attach-insert]").forEach((btn) => {
    btn.onclick = () => {
      if (window.Composer) window.Composer.insertAttachRef($("pane-draft"), btn.dataset.attachInsert);
      updateSendBar();
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

function gmailAttachmentUrl(f, asDownload) {
  const q = new URLSearchParams({ filename: f.filename || "anexo" });
  if (asDownload) q.set("download", "1");
  // Path clássico (já no ar). ?download=1 passa a forçar disposition após restart.
  return `/api/threads/${encodeURIComponent(paneId)}/gmail-attachments/${encodeURIComponent(f.message_id)}/${encodeURIComponent(f.attachment_id)}?${q}`;
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
        const url = gmailAttachmentUrl(f, false);
        const urlDl = gmailAttachmentUrl(f, true);
        if ((f.mime_type || "").startsWith("image/")) {
          return `<a class="msg-inline-image" href="${url}" target="_blank" rel="noopener" title="Abrir imagem original">
            <img src="${url}" alt="${escHtml(f.filename)}" loading="lazy" />
          </a>`;
        }
        return `<span class="attach-chip gmail">
          📎 ${escHtml(f.filename)} <span class="size">${formatSize(f.size)}</span>
          <a href="${url}" target="_blank" rel="noopener" title="Abrir">Abrir</a>
          <a href="${urlDl}" download="${escHtml(f.filename)}" title="Baixar">Baixar</a>
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
    if (paneId === id) {
      mailRcData = res.ok ? data : {};
      renderRecipients(data);
      updateSendBar();
    }
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
    const where = data.category ? ` (destino: ${data.category})` : "";
    try {
      await navigator.clipboard.writeText(data.prompt);
      $("pane-status").textContent = `Contexto salvo em ${data.path}${where} — prompt copiado, é só colar no chat da IA.`;
    } catch {
      $("pane-status").textContent = `Contexto salvo em ${data.path}${where}. Prompt: ${data.prompt}`;
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
    draftAi = "";
    setDraft("", false);
    showDraftChip(false, false);
    setPaneDraftLoading(false);
    if (window.DraftPersist) window.DraftPersist.cacheClear(paneId);
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
function defaultCcSuggestion(toList) {
  const seen = new Set([ACCOUNT_EMAIL, ...(toList || [currentTo]).map((e) => (e || "").toLowerCase())]);
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
  const text = currentDraft();
  if (!paneId || !text) return;
  // Garante o texto no sqlite antes do modal (evita perda se o envio falhar / a página cair).
  if (window.DraftPersist) window.DraftPersist.flush(paneId, text);
  const subject = $("pane-subject").textContent || "(sem assunto)";
  annot.dismissNotice(); // "Trecho reescrito · Desfazer" não fica por cima da confirmação
  $("modal-rcpt").innerHTML = "";
  paintMailRc($("modal-rcpt"), $("modal-rc-sug"), "md");
  $("modal-target").classList.toggle("hidden", !mailTarget);
  $("modal-target-label").textContent = mailTarget ? mailTarget.label || "mensagem escolhida" : "";
  $("modal-error").textContent = "";
  $("modal-error").classList.add("hidden");
  const files = [...$("attach-list").querySelectorAll(".attach-chip")].map((c) => {
    const rm = c.querySelector("[data-attach-rm]");
    return (c.dataset.name || (rm && rm.dataset.attachRm) || c.textContent.replace(/[📎×]/gu, "")).trim();
  }).filter(Boolean);
  $("modal-attachments").textContent = files.length ? files.join(", ") : "nenhum";
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
  updateSendBar(); // chips editados no modal valem também no composer
}

$("pane-send").onclick = openSendModal;
$("modal-cancel").onclick = closeSendModal;
$("send-modal").onclick = (e) => {
  if (e.target === $("send-modal")) closeSendModal();
};
$("send-modal").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !(window.Dialog && window.Dialog.isOpen())) { e.stopPropagation(); closeSendModal(); }
});

$("modal-confirm").onclick = async () => {
  const text = currentDraft();
  if (!paneId || !text) return;
  const st = mailRcState();
  const bad = Recipients.commitInputs($("modal-rcpt"), st);
  const fail = bad || (!st.to.length ? "Coloque pelo menos uma pessoa no Para." : "");
  if (fail) {
    $("modal-error").textContent = fail;
    $("modal-error").classList.remove("hidden");
    paintMailRc($("modal-rcpt"), $("modal-rc-sug"), "md");
    return;
  }
  if (draftMentionsAttachment(text) && currentAttachmentCount() === 0) {
    const proceed = await window.Dialog.confirm({
      title: "Enviar sem anexo?",
      body: "O texto fala em anexo, mas nenhum arquivo foi anexado a esta resposta.",
      ok: "Enviar sem anexo", cancel: "Voltar",
    });
    if (!proceed) return;
  }
  const payload = { text, to: st.to.slice(), cc: st.cc.join(", ") };
  if (mailTarget) {
    // id do Gmail da mensagem escolhida (In-Reply-To/References dela)
    if (!mailTarget.id) {
      const meta = await MsgReply.load(paneId, true);
      const mm = meta && meta[mailTarget.idx];
      if (mm) mailTarget.id = mm.id || "";
    }
    if (!mailTarget.id) {
      $("modal-error").textContent = "Não deu para identificar no Gmail a mensagem que você escolheu. Tente de novo ou clique em \"voltar para a última\".";
      $("modal-error").classList.remove("hidden");
      return;
    }
    payload.reply_to_message_id = mailTarget.id;
  }
  $("modal-confirm").disabled = true;
  $("modal-confirm").textContent = "Enviando…";
  try {
    const res = await fetch(`/api/threads/${paneId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      closeSendModal();
      const detail = typeof data.detail === "string" ? data.detail : "Falha ao enviar.";
      const maybeSent = /pode ter|confira no gmail/i.test(detail);
      $("pane-status").textContent = maybeSent
        ? (/confira no gmail/i.test(detail) ? detail : "Pode ter sido enviado — confira no Gmail antes de reenviar. " + detail)
        : detail;
      return;
    }
    $("send-modal").classList.add("hidden");
    annot.dismissNotice();
    // sem conexão: o servidor pôs na fila de envio (202 queued) -- sai sozinho depois
    const who = `${data.to || st.to.join(", ")}${(data.queued ? st.cc.join(", ") : data.cc) ? ` (Cc: ${data.queued ? st.cc.join(", ") : data.cc})` : ""}`;
    $("pane-status").textContent = data.queued
      ? `Na fila de envio para ${who}. ${data.message || "Sai quando a conexão voltar."}`
      : `Enviado para ${who}${sendResolveBack ? " · Resolvido" : "."}`;
    mailRc = { to: [], cc: [], participants: [], touched: false };
    mailTarget = null;
    if (window.MsgReply) MsgReply.invalidate(paneId); // a resposta é mensagem nova na thread
    if (window.NetStatus) window.NetStatus.refresh();
    $("send-bar").classList.add("hidden");
    draftAi = "";
    setDraft("", false);
    showDraftChip(false, false);
    setPaneDraftLoading(false);
    if (window.DraftPersist && !data.queued) window.DraftPersist.cacheClear(paneId);
    renderAttachments([]);
    pendingCc = [];
    kickPreload();
    // Configurações do Copiloto → "Ao enviar, marcar como resolvido e voltar ao
    // quadro": no /mail volta para a lista; desligado, fica no e-mail.
    if (!sendResolveBack) {
      setTimeout(() => { if (paneId) openPane(paneId); }, 900);
    } else if (mailPathId()) {
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

// Autocomplete de e-mail baseado no histórico de remetentes -- mesma ideia
// do apelido nas Configurações, funciona por segmento (o campo aceita
// vários e-mails separados por vírgula). Reutilizado pelo Cc do modal de
// resposta e pelo Para/Cc do compositor de e-mail novo.
function setupEmailAutocomplete(inputId, boxId) {
  const input = $(inputId);
  const box = $(boxId);
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
}
setupEmailAutocomplete("compose-to", "compose-to-suggestions");
setupEmailAutocomplete("compose-cc", "compose-cc-suggestions");

// ── Compor e-mail novo -- mesma dinâmica de chat da resposta (instrução ->
// IA escreve o rascunho -> revisa -> envia), só que sem thread nenhuma por
// trás. Estado fica só em memória (composeChatHistory): não existe row no
// banco pra pendurar isso até o e-mail sair de verdade.
function composePathActive() {
  return location.pathname === "/compose";
}

let composeChatHistory = [];

let composeDraftAi = "";

function lastComposeDraft() {
  return $("compose-draft").value.trim();
}

function renderComposeChat(opts) {
  $("compose-chat-count").textContent = String(composeChatHistory.filter((m) => !m.typing).length);
  ChatUI.render($("compose-chat-messages"), composeChatHistory, {
    compactDrafts: true,
    empty: "Diga embaixo o que quer escrever: eu escrevo o rascunho na caixa.",
    onCcPick: (_m, _c, email) => { if (email) addPendingCc(email); },
    onUseDraft: (text) => { $("compose-draft").value = text; composeDraftAi = text; updateComposeSendBar(); },
  });
  const ai = ChatUI.lastDraft(composeChatHistory);
  const box = $("compose-draft");
  const edited = box.value.trim() && box.value.trim() !== composeDraftAi.trim();
  if (ai && ai !== composeDraftAi && ((opts && opts.forceDraft) || !edited)) {
    box.value = ai;
    composeDraftAi = ai;
  }
  $("compose-gen-label").textContent = box.value.trim() ? "Ajustar" : "Gerar";
  updateComposeSendBar();
}

function updateComposeSendBar() {
  const draft = lastComposeDraft();
  const bar = $("compose-send-bar");
  if (!draft) {
    bar.classList.add("hidden");
    $("compose-send").disabled = true;
    return;
  }
  bar.classList.remove("hidden");
  $("compose-send-target").textContent = `Para: ${$("compose-to").value.trim() || "?"}`;
  $("compose-send").disabled = !canSend;
  $("compose-send").title = canSend ? "" : "Reautorize o Gmail (Entrar no Gmail) para poder enviar.";
}

$("compose-draft").addEventListener("input", () => {
  $("compose-gen-label").textContent = $("compose-draft").value.trim() ? "Ajustar" : "Gerar";
  updateComposeSendBar();
});

$("compose-instr").addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 280) + "px";
  $("compose-gen").disabled = !this.value.trim();
});
$("compose-instr").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("compose-gen").click();
  }
});

$("compose-gen").onclick = async () => {
  const freeText = $("compose-instr").value.trim();
  if (!freeText) return;
  // texto editado na caixa: entra no histórico como a versão atual do rascunho
  const box = $("compose-draft").value.trim();
  if (box && box !== composeDraftAi.trim()) composeChatHistory.push({ role: "ai", kind: "draft", text: box });
  composeChatHistory.push({ role: "user", text: freeText });
  const sentHistory = composeChatHistory.slice();
  composeChatHistory.push({ role: "ai", placeholder: true, typing: true, text: "" });
  renderComposeChat();
  $("compose-instr").value = "";
  $("compose-instr").style.height = "auto";
  $("compose-gen").disabled = true;
  try {
    const res = await fetch("/api/compose/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: $("compose-to").value.trim(),
        subject: $("compose-subject").value.trim(),
        instruction: freeText,
        comment: "",
        chat: sentHistory,
      }),
    });
    const data = await res.json().catch(() => ({}));
    composeChatHistory = composeChatHistory.filter((m) => !m.typing);
    if (!res.ok) {
      renderComposeChat();
      showBanner(data.detail || "Falha ao gerar rascunho.", true);
      return;
    }
    const aiMsg = { role: "ai", text: data.text, kind: data.kind };
    if (data.cc_resolution) aiMsg.cc_resolution = data.cc_resolution;
    composeChatHistory.push(aiMsg);
    applyCcResolution(aiMsg);
    renderComposeChat({ forceDraft: true });
  } catch {
    composeChatHistory = composeChatHistory.filter((m) => !m.typing);
    renderComposeChat();
    showBanner("Falha de rede ao gerar rascunho.", true);
  } finally {
    $("compose-gen").disabled = !$("compose-instr").value.trim();
  }
};

function openComposeSendModal() {
  const text = lastComposeDraft();
  if (!text) return;
  $("compose-modal-to").textContent = $("compose-to").value.trim() || "(vazio)";
  $("compose-modal-cc").textContent = $("compose-cc").value.trim() || "(nenhum)";
  $("compose-modal-subject").textContent = $("compose-subject").value.trim() || "(sem assunto)";
  $("compose-modal-preview").textContent = text;
  $("compose-send-modal").classList.remove("hidden");
}
function closeComposeSendModal() {
  $("compose-send-modal").classList.add("hidden");
}
$("compose-send").onclick = openComposeSendModal;
$("compose-modal-cancel").onclick = closeComposeSendModal;
$("compose-send-modal").onclick = (e) => {
  if (e.target === $("compose-send-modal")) closeComposeSendModal();
};
$("compose-modal-confirm").onclick = async () => {
  const text = lastComposeDraft();
  const to = $("compose-to").value.trim();
  if (!text || !to) return;
  $("compose-modal-confirm").disabled = true;
  $("compose-modal-confirm").textContent = "Enviando…";
  try {
    const res = await fetch("/api/compose/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to,
        cc: $("compose-cc").value.trim(),
        subject: $("compose-subject").value.trim(),
        text,
      }),
    });
    const data = await res.json().catch(() => ({}));
    closeComposeSendModal();
    if (!res.ok) {
      showBanner(data.detail || "Falha ao enviar.", true);
      return;
    }
    showBanner(data.queued ? `Na fila de envio. ${data.message || "Sai quando a conexão voltar."}` : `E-mail enviado para ${data.to}.`, true);
    setTimeout(() => {
      window.location.href = "/";
    }, 900);
  } finally {
    $("compose-modal-confirm").disabled = false;
    $("compose-modal-confirm").textContent = "Enviar agora";
  }
};

$("compose-close").onclick = () => {
  window.location.href = "/";
};
$("btn-compose").onclick = () => {
  window.location.href = "/compose";
};

// Botão de gerar ativa com texto na caixa OU com anotações pendentes
// (dá pra mandar só anotação, sem escrever nada no campo livre).
function updateGenButtonState() {
  $("pane-gen").disabled = !$("pane-instr").value.trim() && !annotations.length;
  updateChatResetState();
  updateKeepChip();
}

function composedInstruction() {
  return Annotate.compose($("pane-instr").value, annotations);
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
  // a bolha mostra o mesmo texto que vai para a IA (e que o servidor salva no
  // chat): citações listadas, trecho encurtado pelo ChatUI, comentário inteiro
  const visibleText = instruction;
  // caixa editada: a IA reescreve a partir dela ("Rascunho anterior" no prompt)
  const currentDraftText = draftEdited() ? currentDraft() : "";
  // "Usar meu texto (só corrigir)" ligado à mão: o campo inteiro é o e-mail
  const keepFlag = mailKeep;

  chatHistory = chatHistory.filter((m) => !m.placeholder);
  chatHistory.push({ role: "user", text: visibleText });
  chatHistory.push({ role: "ai", placeholder: true, typing: true, text: "" });
  renderChat();
  $("pane-instr").value = "";
  $("pane-instr").style.height = "auto";
  clearAllAnnotations();

  // status da geração fica colado no campo da IA (logo acima dele), não no topo do painel
  $("draft-status").innerHTML = workingHTML("Escrevendo o rascunho");
  $("pane-gen").disabled = true; // esvaziou a caixa, então continua desabilitado no finally

  try {
    const res = await fetch(`/api/threads/${paneId}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({
        instruction: keepFlag ? freeText : instruction,
        comment: "",
        current_draft: currentDraftText,
      }, keepFlag ? { keep_text: true } : {}, mailTarget ? Object.assign({ alvo_idx: mailTarget.idx }, mailTarget.id ? { reply_to_message_id: mailTarget.id } : {}) : {})),
    });
    const data = await res.json().catch(() => ({}));
    chatHistory = chatHistory.filter((m) => !m.typing);
    if (!res.ok) {
      renderChat();
      $("draft-status").textContent = data.detail || "Falha no rascunho.";
      return;
    }
    if (Recipients.instructionTarget(instruction).para) mailRcInstr = instruction;
    const sd = data.sugestao_destinatarios;
    if (sd && sd.email && !mailRcState().participants.some((p) => p.email === sd.email)) mailRc.participants.push({ email: sd.email, name: sd.nome || "" });
    if (Array.isArray(data.chat) && data.chat.length) {
      chatHistory = data.chat.slice();
      applyCcResolution(chatHistory[chatHistory.length - 1]);
      renderChat({ forceDraft: true });
    } else if (data.draft) {
      chatHistory.push({ role: "ai", text: data.draft });
      renderChat({ forceDraft: true });
    }
    const lastMsg = chatHistory[chatHistory.length - 1];
    const answered = lastMsg && lastMsg.kind === "answer";
    $("draft-status").textContent = answered ? "A IA respondeu no chat; o rascunho da caixa continua o mesmo." : "Rascunho novo da IA na caixa. Nada foi enviado.";
    mailKeep = false;
    mailKeepOff = null;
    updateKeepChip();
    // "Usar meu texto": o texto do Leo, só corrigido -> destaca as mudanças; Desfazer volta sem correção
    if (data.keep_text) {
      $("draft-status").textContent = data.aviso || (data.corrigido ? "Seu texto foi para o rascunho, só com o português corrigido." : "Seu texto foi para o rascunho como está (nada a corrigir).");
      const ta = $("pane-draft");
      if (data.corrigido && data.original && ta.value === data.draft) {
        const n = annot.flashChanges(ta, data.original, data.draft, 0);
        annot.setUndo(ta, data.original);
        annot.notice(`Usei seu texto, só com o português corrigido (${n === 1 ? "1 mudança" : `${n} mudanças`}).`, () => annot.undo());
      }
    }
    // pronto para o próximo pedido: campo da IA (embaixo do rascunho) focado e à vista
    $("pane-instr").focus({ preventScroll: true });
    if ($("pane-instr").scrollIntoView) $("pane-instr").scrollIntoView({ block: "nearest" });
  } catch {
    chatHistory = chatHistory.filter((m) => !m.typing);
    renderChat();
    $("draft-status").textContent = "Falha de rede ao gerar o rascunho. Tente de novo.";
  } finally {
    updateGenButtonState();
  }
};

// ── Selecionar trecho -> anotação ancorada no texto (igual ao Codex) ──
// Seleciona um pedaço do resumo/thread, marca aquele trecho com um
// número (badge azul) e abre uma caixinha ali do lado pra comentar em
// cima daquele pedaço específico. As anotações viram contexto
// direcionado quando o próximo rascunho é gerado no chat. A mecânica
// (barrinha, marca, popup) mora em static/annotate.js, a mesma do /copilot.
let annotations = []; // cópia de annot.list(), atualizada a cada mudança

function annotationChipUpdate(list) {
  annotations = list;
  $("annot-chips").innerHTML = Composer.annotChipsHTML(annotations);
  updateGenButtonState();
}

const annot = Annotate.create({
  areas: () => [$("pane-summary"), $("pane-body"), $("chat-messages")],
  textareas: () => [$("pane-draft")],
  enabled: () => !!paneId,
  onChange: annotationChipUpdate,
  // "Reescrever" na seleção do rascunho: só o trecho, sem regerar nem Ajustar;
  // o annotate.js troca no textarea e dispara input -> autosave (listener abaixo).
  rewrite: async (req) => {
    if (!paneId) throw new Error("Abra um e-mail.");
    let res;
    try {
      res = await fetch(`/api/threads/${encodeURIComponent(paneId)}/rewrite-passage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
    } catch (_) {
      throw new Error("Sem conexão com o servidor.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Não deu para reescrever o trecho.");
    return data.replacement;
  },
  // "Corrigir português" na seleção do rascunho: só ortografia/pontuação do trecho
  fixPortuguese: async (req) => {
    if (!paneId) throw new Error("Abra um e-mail.");
    const d = await Composer.fixPortuguese(paneId, { draft: req.draft, start: req.start, end: req.end });
    return d.replacement;
  },
});

// caixa do rascunho: editar habilita Enviar e troca Gerar -> Ajustar
$("pane-draft").addEventListener("input", () => {
  $("draft-status").textContent = draftEdited() ? "Editado por você." : ($("pane-draft").value.trim() ? "Rascunho salvo." : "");
  if ($("pane-draft").value.trim()) showDraftChip(true, false);
  else showDraftChip(false, false);
  updateGenLabel();
  updateSendBar();
  updateChatResetState();
  updateFixBtn();
  if (paneId && window.DraftPersist) window.DraftPersist.schedule(paneId, $("pane-draft").value);
});

function clearAllAnnotations() {
  annot.clear();
}


// ── Configurações agora é uma página (/settings), em static/settings.js ──
$("btn-settings").onclick = () => {
  window.location.href = "/settings";
};

// Quais rótulos viram negrito no resumo depende do formato escolhido; a lista
// vem do servidor (todos os formatos), com o padrão antigo como reserva.
fetch("/api/summary/templates")
  .then((r) => r.json())
  .then((d) => {
    if (Array.isArray(d.headers) && d.headers.length) SUMMARY_HEADERS.splice(0, SUMMARY_HEADERS.length, ...d.headers);
  })
  .catch(() => {});

// ── Piloto automático ──
function autopilotPathActive() {
  return location.pathname === "/autopilot";
}

function relativeMinutes(iso) {
  if (!iso) return "";
  const diffMs = new Date(iso).getTime() - Date.now();
  const mins = Math.round(diffMs / 60000);
  if (mins <= 0) return "a qualquer momento";
  return `em ~${mins} min`;
}

function renderAutopilotList(el, items, opts) {
  if (!items.length) {
    el.innerHTML = '<p class="files-empty">Nada aqui.</p>';
    return;
  }
  el.innerHTML = items
    .map((it) => {
      const title = it.subject || "(sem assunto)";
      const meta = [
        it.from_email,
        it.confidence != null ? `confiança ${(it.confidence * 100).toFixed(0)}%` : "",
        it.scheduled_send_at ? `envia ${relativeMinutes(it.scheduled_send_at)}` : "",
        it.status === "sent" ? "enviado" : "",
        it.status === "cancelled" ? "cancelado" : "",
        it.status === "failed" ? `falhou: ${it.error || ""}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const cancelBtn =
        opts && opts.cancelable
          ? `<button type="button" data-ap-cancel="${it.id}" class="ghost danger">Cancelar</button>`
          : "";
      return `<div class="file-row" style="flex-direction:column;align-items:flex-start;gap:4px">
        <div style="display:flex;justify-content:space-between;width:100%;gap:8px">
          <span class="file-path" data-tooltip="${escHtml(title)}">${escHtml(title)}</span>
          ${cancelBtn}
        </div>
        <span class="file-meta">${escHtml(meta)}</span>
        ${it.reasoning ? `<span class="settings-hint" style="margin:0">${escHtml(it.reasoning)}</span>` : ""}
      </div>`;
    })
    .join("");
  if (opts && opts.cancelable) {
    el.querySelectorAll("[data-ap-cancel]").forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        await fetch(`/api/autopilot/queue/${btn.dataset.apCancel}/cancel`, { method: "POST" });
        loadAutopilotQueue();
      };
    });
  }
}

async function loadAutopilotQueue() {
  const res = await fetch("/api/autopilot/queue");
  const data = await res.json().catch(() => ({ items: [] }));
  renderAutopilotList($("ap-queue-list"), data.items || [], { cancelable: true });
}

async function loadAutopilotLog() {
  const res = await fetch("/api/autopilot/log");
  const data = await res.json().catch(() => ({ items: [] }));
  renderAutopilotList($("ap-log-list"), data.items || [], { cancelable: false });
}

async function loadAutopilotAlerts() {
  const res = await fetch("/api/autopilot/alerts");
  const data = await res.json().catch(() => ({ items: [] }));
  renderAutopilotList($("ap-alerts-list"), data.items || [], { cancelable: false });
}

async function loadAutopilotDrafts() {
  const res = await fetch("/api/autopilot/drafts");
  const data = await res.json().catch(() => ({ items: [] }));
  renderAutopilotList($("ap-drafts-list"), data.items || [], { cancelable: false });
}

async function loadAutopilotPatterns() {
  const res = await fetch("/api/autopilot/patterns");
  const data = await res.json().catch(() => ({ digest: "", updated_at: null }));
  $("ap-patterns-digest").textContent = data.digest || "(nenhum digest gerado ainda.)";
  $("ap-patterns-updated").textContent = data.updated_at
    ? `Última atualização: ${new Date(data.updated_at).toLocaleString("pt-BR")}`
    : "Nunca gerado ainda.";
}

async function loadAutopilotSettingsForm() {
  const res = await fetch("/api/settings");
  const data = await res.json().catch(() => ({}));
  const s = data.settings || {};
  $("ap-enabled").checked = !!s.autopilot_enabled;
  $("ap-level").value = s.autopilot_level || "conservador";
  $("ap-buffer").value = s.autopilot_buffer_minutes || 10;
}

async function initAutopilotPage() {
  await loadAutopilotSettingsForm();
  loadAutopilotPatterns();
  loadAutopilotQueue();
  loadAutopilotLog();
  loadAutopilotAlerts();
  loadAutopilotDrafts();
  setInterval(loadAutopilotQueue, 30000);
}

$("btn-autopilot").onclick = () => {
  window.location.href = "/autopilot";
};
$("autopilot-close").onclick = () => {
  window.location.href = "/";
};
$("ap-settings-save").onclick = async () => {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      autopilot_enabled: $("ap-enabled").checked,
      autopilot_level: $("ap-level").value,
      autopilot_buffer_minutes: Math.max(1, parseInt($("ap-buffer").value, 10) || 10),
    }),
  });
  const data = await res.json().catch(() => ({}));
  $("ap-settings-status").textContent = res.ok ? "Salvo." : data.detail || "Falha ao salvar.";
};
$("ap-patterns-refresh").onclick = async () => {
  const btn = $("ap-patterns-refresh");
  btn.disabled = true;
  btn.textContent = "Gerando…";
  try {
    const res = await fetch("/api/autopilot/patterns/refresh", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      $("ap-patterns-digest").textContent = data.digest || "";
      $("ap-patterns-updated").textContent = "Última atualização: agora";
    } else {
      showBanner(data.detail || "Falha ao atualizar padrões.", true);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Atualizar padrões";
  }
};

(async () => {
  const mailId = mailPathId();
  const status = await loadStatus();
  // Vindo do Copiloto (delegar/cobrar): chega com destinatários e rascunho
  // prontos na URL. Só preenche a tela -- enviar continua sendo clique do Leo.
  const prefill = new URLSearchParams(location.search);
  if (composePathActive()) {
    document.body.classList.add("composing");
    $("compose-page").classList.remove("hidden");
    $("compose-to").value = prefill.get("to") || "";
    $("compose-cc").value = prefill.get("cc") || "";
    $("compose-subject").value = prefill.get("subject") || "";
    if (prefill.get("draft")) {
      composeChatHistory.push({ role: "ai", text: prefill.get("draft"), kind: "draft" });
      renderComposeChat();
    }
    $("compose-to").focus();
    return;
  }
  if (location.pathname === "/settings") {
    document.body.classList.add("composing", "settings-view");
    $("settings-page").classList.remove("hidden");
    return;
  }
  if (autopilotPathActive()) {
    document.body.classList.add("composing");
    $("autopilot-page").classList.remove("hidden");
    await initAutopilotPage();
    return;
  }
  if (mailId) {
    document.body.classList.add("conversation");
    $("back-inbox").classList.remove("hidden");
    $("btn-refresh").classList.add("hidden");
    await openPane(mailId);
    (prefill.get("cc") || "").split(",").forEach((email) => email.trim() && addPendingCc(email.trim()));
    return;
  }
  await loadRadar();
  const savedScroll = sessionStorage.getItem(LIST_SCROLL_KEY);
  if (savedScroll) window.scrollTo(0, parseInt(savedScroll, 10));
  if (status.authenticated && !status.last_refresh && !status.cached) {
    refresh(false);
  }
})();
