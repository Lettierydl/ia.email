// Ícones padrão do sistema (/, /mail, /compose, /settings, /copilot, /board).
// Todos outline 24x24, stroke 1.75 em currentColor -- exceto o "M" do Gmail,
// colorido. O envelope ("mail") sai azul por padrão. Uso:
//   Icons.svg("sparkles")                       -> string <svg>
//   Icons.html("reply", { size: 18, title: "Responder" })
//   <span data-icon="gmail" data-icon-size="18"></span>  (Icons.hydrate preenche)
// O app mobile (mobile/src/icons.ts) repete os mesmos paths.
(function () {
  // Cada ícone: markup interno do <svg>. `fill: true` = desenho preenchido
  // com cores próprias (sem stroke); `color` = cor padrão do traço.
  const I = {
    sparkles: {
      d: '<path d="M9.94 15.5a2 2 0 0 0-1.44-1.44l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0l1.58 6.13a2 2 0 0 0 1.44 1.44l6.13 1.58a.5.5 0 0 1 0 .96l-6.13 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z"/><path d="M20 3v4M22 5h-4M4 17v2M5 18H3"/>',
    },
    mail: {
      color: "#1a73e8",
      d: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="m3 7 7.94 5.4a1.9 1.9 0 0 0 2.12 0L21 7"/>',
    },
    gmail: {
      fill: true,
      d: '<path fill="#4285F4" d="M1.64 21h3.82v-9.27L0 7.64v11.73C0 20.27.73 21 1.64 21z"/><path fill="#34A853" d="M18.55 21h3.81c.9 0 1.64-.73 1.64-1.64V7.64l-5.45 4.09z"/><path fill="#FBBC04" d="M18.55 4.64v7.09L24 7.64V5.45c0-2.02-2.31-3.18-3.93-1.96z"/><path fill="#EA4335" d="M5.45 11.73V4.64L12 9.55l6.55-4.91v7.09L12 16.64z"/><path fill="#C5221F" d="M0 5.45v2.19l5.45 4.09V4.64L3.93 3.49C2.31 2.27 0 3.43 0 5.45z"/>',
    },
    reply: { d: '<path d="M9 17 4 12l5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>' },
    "reply-all": { d: '<path d="M7 17 2 12l5-5"/><path d="m12 17-5-5 5-5"/><path d="M22 18v-2a4 4 0 0 0-4-4H7"/>' },
    forward: { d: '<path d="m15 17 5-5-5-5"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>' },
    // Delegar: passar a bola para alguém (pessoa + seta saindo)
    handoff: { d: '<circle cx="9" cy="7.5" r="3.5"/><path d="M3 20v-1.5A4.5 4.5 0 0 1 7.5 14h3"/><path d="M15 17h7"/><path d="m19 14 3 3-3 3"/>' },
    bell: { d: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>' },
    "bell-off": { d: '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/>' },
    // Resolvido: duplo check em círculo (metáfora de "lido")
    "check-circle-double": { d: '<circle cx="12" cy="12" r="10"/><path d="m5.8 12.4 2.4 2.4 4.6-5.6"/><path d="m10.4 12.4 2.4 2.4 5-5.8"/>' },
    check: { d: '<path d="M20 6 9 17l-5-5"/>' },
    eye: { d: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>' },
    "eye-off": { d: '<path d="M10.7 5.1A10.7 10.7 0 0 1 22 12a13 13 0 0 1-1.7 2.6"/><path d="M14.1 14.2a3 3 0 0 1-4.3-4.3"/><path d="M17.5 17.5A10.8 10.8 0 0 1 2 12a13.4 13.4 0 0 1 4.5-5.1"/><path d="m2 2 20 20"/>' },
    reopen: { d: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>' },
    refresh: { d: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/>' },
    thread: { d: '<path d="M4 6h16M4 11h16M4 16h10M4 21h14"/>' },
    summary: { d: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h6"/><path d="M8 13h8M8 17h8M8 9h2"/>' },
    send: { d: '<path d="M14.5 21.7a.5.5 0 0 0 .94-.03l6.5-19a.5.5 0 0 0-.64-.63l-19 6.5a.5.5 0 0 0-.02.93l7.93 3.18a2 2 0 0 1 1.11 1.11z"/><path d="m21.85 2.15-10.94 10.94"/>' },
    // Aprender: lâmpada (a IA guarda a ideia para os próximos e-mails)
    learn: { d: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>' },
    chat: { d: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
    trash: { d: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' },
    attach: { d: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>' },
    export: { d: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h6"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/>' },
    back: { d: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>' },
    folder: { d: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>' },
    file: { d: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h6"/>' },
    "chevron-up": { d: '<path d="m18 15-6-6-6 6"/>' },
    "chevron-down": { d: '<path d="m6 9 6 6 6-6"/>' },
    "chevron-right": { d: '<path d="m9 18 6-6-6-6"/>' },
    zoom: { d: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>' },
    search: { d: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>' },
    close: { d: '<path d="M18 6 6 18M6 6l12 12"/>' },
    settings: { d: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>' },
    pencil: { d: '<path d="M21.17 6.81a2.83 2.83 0 0 0-4-4L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>' },
    calendar: { d: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>' },
    clock: { d: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>' },
    user: { d: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>' },
    users: { d: '<circle cx="9" cy="8" r="4"/><path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/><path d="M22 21v-1a6 6 0 0 0-4-5.6"/>' },
    // Seu papel (camada 1)
    "role-demanda": { d: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>' },
    "role-opiniao": { d: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 21l1.9-5.1A8.4 8.4 0 1 1 21 11.5z"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.8c0 1.7-2.4 2.2-2.4 2.2"/><path d="M12 15.5h.01"/>' },
    "role-copia": { d: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>' },
    "role-fyi": { d: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>' },
    "role-ignorar": { d: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>' },
    // Urgência
    "urg-alta": { d: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>' },
    "urg-media": { d: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>' },
    "urg-baixa": { d: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>' },
  };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // opts: size (px, padrão 20), title (vira <title> + aria-label), cls, color, stroke
  function svg(name, opts) {
    const icon = I[name];
    if (!icon) return "";
    opts = opts || {};
    const size = opts.size || 20;
    const color = opts.color || icon.color;
    const a11y = opts.title ? `role="img" aria-label="${esc(opts.title)}"` : 'aria-hidden="true"';
    const paint = icon.fill
      ? 'fill="none" stroke="none"'
      : `fill="none" stroke="currentColor" stroke-width="${opts.stroke || 1.75}" stroke-linecap="round" stroke-linejoin="round"`;
    return `<svg class="ic ic-${name}${opts.cls ? ` ${esc(opts.cls)}` : ""}" viewBox="0 0 24 24" width="${size}" height="${size}" ${paint}${color ? ` style="color:${esc(color)}"` : ""} focusable="false" ${a11y}>${opts.title ? `<title>${esc(opts.title)}</title>` : ""}${icon.d}</svg>`;
  }

  // <span data-icon="nome" data-icon-size="18" data-icon-title="..."> vira o svg
  function hydrate(root) {
    (root || document).querySelectorAll("[data-icon]").forEach((el) => {
      if (el.dataset.iconDone === el.dataset.icon) return;
      el.innerHTML = svg(el.dataset.icon, { size: Number(el.dataset.iconSize) || undefined, title: el.dataset.iconTitle, color: el.dataset.iconColor });
      el.dataset.iconDone = el.dataset.icon;
    });
  }

  window.Icons = { svg, html: svg, hydrate, has: (n) => n in I, names: () => Object.keys(I) };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => hydrate());
  else hydrate();
})();
