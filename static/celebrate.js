// Caixa zerada (/copilot), inline -- sem modal. A cena da praia (personagem de
// óculos tomando água de coco, sol, ondas, confete discreto) só aparece com o
// quadro inteiro vazio, grande na área do quadro ("Por hoje é só! Caixa zerada
// 🥥"); coluna vazia com e-mail em outra coluna fica no texto simples.
// Anima só na renderização que segue a transição >0 → 0 (fresh) e, depois de
// ~6 s, fica parada (cz-still) até chegar item novo. Re-render não reinicia:
// keep() devolve ao DOM o nó que já estava na tela.
// prefers-reduced-motion: sempre parada. SVG inline + CSS (celebrate.css).
(function () {
  const ANIM_MS = 6000;
  const CONFETTI = [
    [26, 8, "#ff8a80", 0], [58, 2, "#ffd54f", 0.6], [92, 10, "#81d4fa", 1.1], [128, 4, "#a5d6a7", 0.3],
    [160, 9, "#ce93d8", 0.9], [196, 3, "#ffab91", 0.2], [214, 12, "#fff176", 1.3], [44, 14, "#80cbc4", 1.6],
    [146, 15, "#f48fb1", 1.8], [108, 6, "#ffe082", 0.45],
  ];

  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (_) { return false; }
  }

  // opts.confetti: confete no céu; opts.title: rótulo acessível
  function artSVG(opts) {
    opts = opts || {};
    const confetti = opts.confetti
      ? `<g class="cz-confetti">${CONFETTI.map(([x, y, c, d], i) => `<rect x="${x}" y="${y}" width="${i % 3 ? 4 : 3}" height="${i % 2 ? 7 : 5}" rx="1" fill="${c}" transform="rotate(${(i * 37) % 90} ${x} ${y})" style="animation-delay:${d}s"/>`).join("")}</g>`
      : "";
    return `<svg class="cz-art" viewBox="0 0 240 160" role="img" aria-label="${opts.title || "Pessoa na praia, de óculos escuros, tomando água de coco"}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="cz-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#bfe6ff"/><stop offset="1" stop-color="#fff1d6"/></linearGradient>
  </defs>
  <rect width="240" height="160" rx="18" fill="url(#cz-sky)"/>
  <g class="cz-sun"><g class="cz-rays" stroke="#ffc83d" stroke-width="3" stroke-linecap="round">
    <path d="M196 10v-6M196 66v6M168 38h-6M224 38h6M176 18l-4-4M216 58l4 4M216 18l4-4M176 58l-4 4"/></g>
    <circle cx="196" cy="38" r="17" fill="#ffd54f"/></g>
  <g class="cz-cloud" fill="#fff" opacity=".9"><ellipse cx="62" cy="32" rx="18" ry="7"/><ellipse cx="74" cy="28" rx="11" ry="8"/></g>
  ${confetti}
  <g class="cz-sea">
    <rect y="92" width="240" height="30" fill="#7cc8ec"/>
    <path class="cz-wave" d="M-40 96q10-6 20 0t20 0 20 0 20 0 20 0 20 0 20 0 20 0 20 0 20 0 20 0 20 0 20 0 20 0 20 0v8h-320z" fill="#a8dcf4"/>
    <path class="cz-wave cz-wave2" d="M-40 108q10-5 20 0t20 0 20 0 20 0 20 0 20 0 20 0 20 0 20 0 20 0 20 0 20 0 20 0 20 0 20 0v6h-320z" fill="#5fb8e2"/>
  </g>
  <path d="M0 118q60-10 120-2t120-4v48H0z" fill="#f7dca4"/>
  <g class="cz-palm">
    <path d="M30 150q6-40 2-74" stroke="#a0703c" stroke-width="6" fill="none" stroke-linecap="round"/>
    <g fill="#5cae6a"><path d="M32 76q-22-6-30 8 14-10 30-8z"/><path d="M32 76q20-14 34-2-16-6-34 2z"/><path d="M32 76q-6-20 8-28-4 14-8 28z"/><path d="M32 76q-18 6-20 24 6-16 20-24z"/><path d="M32 76q16 2 22 18-8-12-22-18z"/></g>
    <circle cx="30" cy="80" r="3.5" fill="#8d6e3f"/><circle cx="36" cy="81" r="3.5" fill="#8d6e3f"/>
  </g>
  <g class="cz-person">
    <rect x="96" y="128" width="78" height="7" rx="3.5" fill="#ff8a65"/>
    <path d="M150 128q14-2 26 2" stroke="#f2b98f" stroke-width="7" stroke-linecap="round" fill="none"/>
    <path d="M146 131q16 2 28 6" stroke="#f2b98f" stroke-width="7" stroke-linecap="round" fill="none"/>
    <path d="M112 130q2-26 22-28 16 2 18 26z" fill="#4fc3a1"/>
    <path d="M118 112h6M126 108h5" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".7"/>
    <circle cx="130" cy="90" r="13" fill="#f2b98f"/>
    <path d="M117 88q2-14 14-14 12 0 13 12-6-6-14-6-8 0-13 8z" fill="#5d4037"/>
    <g class="cz-glasses"><rect x="121" y="86" width="9" height="6" rx="2.5" fill="#263238"/><rect x="133" y="86" width="9" height="6" rx="2.5" fill="#263238"/><path d="M130 88h3" stroke="#263238" stroke-width="1.6"/></g>
    <path d="M126 97q4 3 8 0" stroke="#8d4a3a" stroke-width="1.6" fill="none" stroke-linecap="round"/>
    <g class="cz-sip">
      <path d="M140 116q14-4 12-16" stroke="#f2b98f" stroke-width="6" stroke-linecap="round" fill="none"/>
      <circle cx="152" cy="98" r="9" fill="#7cb342"/><circle cx="152" cy="98" r="5.5" fill="#c5e1a5"/>
      <path d="M151 96l-12-3" stroke="#ff7eb3" stroke-width="2" stroke-linecap="round"/>
    </g>
  </g>
</svg>`;
  }

  // Cena inline do quadro zerado. opts.key: chave para keep() (padrão "all");
  // opts.fresh: acabou de zerar → anima.
  function sceneHTML(opts) {
    opts = opts || {};
    const anim = !!opts.fresh && !reducedMotion();
    return `<div class="cz-scene cz-big ${anim ? "cz-anim cz-fresh" : "cz-still"}" data-cz="${opts.key || "all"}" role="status">
      ${artSVG({ confetti: true, title: "Praia tranquila: pessoa de óculos tomando água de coco" })}
      <p class="cz-title">${opts.title || "Por hoje é só! Caixa zerada 🥥"}</p>
      <p class="cz-sub">${opts.sub || "Nada pendente no quadro. Pode respirar."}</p></div>`;
  }

  // Re-render sem reiniciar a animação: guarda as cenas que já estão em `box`,
  // roda render() e troca cada cena nova (não fresh) pela antiga de mesma chave.
  function keep(box, render) {
    const old = {};
    if (box) box.querySelectorAll(".cz-scene[data-cz]").forEach((el) => (old[el.dataset.cz] = el));
    render();
    if (!box) return;
    box.querySelectorAll(".cz-scene[data-cz]").forEach((el) => {
      const prev = old[el.dataset.cz];
      if (prev && prev !== el && !el.classList.contains("cz-fresh")) el.replaceWith(prev);
    });
    settle(box);
  }

  // Cena que começou a animar para (cz-still) depois de ~6 s.
  function settle(box) {
    (box || document).querySelectorAll(".cz-scene.cz-fresh").forEach((el) => {
      el.classList.remove("cz-fresh");
      setTimeout(() => { el.classList.remove("cz-anim"); el.classList.add("cz-still"); }, api.animMs);
    });
  }

  const api = { artSVG, sceneHTML, keep, settle, reducedMotion, animMs: ANIM_MS };
  window.Celebrate = api;
})();
