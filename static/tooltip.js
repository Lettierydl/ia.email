// Tooltip único para tudo que tem data-tooltip. Substitui o ::after em CSS,
// que ficava preso em left:0/right:0 (descentralizado, cortado nas bordas e
// sem funcionar no teclado nem no toque).
(function () {
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);

  let current = null;
  let showTimer = null;
  let touchTimer = null;
  let touchHide = null;

  const textOf = (el) => (el.getAttribute("data-tooltip") || "").trim();

  function labelIconButtons(el) {
    // botão só com ícone não tem nome pra leitor de tela: usa o próprio tooltip
    if (!el.getAttribute("aria-label") && !el.textContent.trim()) {
      el.setAttribute("aria-label", textOf(el));
    }
  }

  function place(el) {
    const margin = 8;
    const gap = 8;
    const r = el.getBoundingClientRect();
    tip.style.left = "0px";
    tip.style.top = "0px";
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
    const fitsBelow = r.bottom + gap + h + margin <= window.innerHeight;
    const fitsAbove = r.top - gap - h >= margin;
    const below = fitsBelow || !fitsAbove;
    const top = below ? r.bottom + gap : r.top - gap - h;
    const arrow = Math.max(12, Math.min(w - 12, r.left + r.width / 2 - left));
    tip.dataset.side = below ? "bottom" : "top";
    tip.style.setProperty("--arrow-x", `${arrow}px`);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function show(el) {
    const text = textOf(el);
    if (!text || !document.contains(el)) return;
    current = el;
    labelIconButtons(el);
    tip.textContent = text;
    place(el);
    tip.classList.add("show");
  }

  function hide() {
    clearTimeout(showTimer);
    clearTimeout(touchTimer);
    current = null;
    tip.classList.remove("show");
  }

  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest("[data-tooltip]");
    if (!el || el === current) return;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(el), 350);
  });

  document.addEventListener("mouseout", (e) => {
    const el = e.target.closest("[data-tooltip]");
    if (el && !el.contains(e.relatedTarget)) hide();
  });

  document.addEventListener("focusin", (e) => {
    const el = e.target.closest && e.target.closest("[data-tooltip]");
    if (el && el.matches(":focus-visible")) show(el);
  });
  document.addEventListener("focusout", hide);

  // Toque: segurar ~0,5s mostra a dica (tocar normal continua só acionando o botão).
  document.addEventListener(
    "touchstart",
    (e) => {
      const el = e.target.closest("[data-tooltip]");
      if (!el) return;
      clearTimeout(touchTimer);
      touchTimer = setTimeout(() => {
        show(el);
        clearTimeout(touchHide);
        touchHide = setTimeout(hide, 2200);
      }, 500);
    },
    { passive: true }
  );
  document.addEventListener("touchend", () => clearTimeout(touchTimer), { passive: true });
  document.addEventListener("touchmove", () => clearTimeout(touchTimer), { passive: true });

  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
  document.addEventListener("mousedown", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hide();
  });

  // Botões só de ícone criados depois do carregamento (cards da lista, etc.)
  // também precisam de nome acessível, sem esperar o primeiro hover/foco.
  const labelAll = () => document.querySelectorAll("[data-tooltip]:not([aria-label])").forEach(labelIconButtons);
  let labelTimer = null;
  new MutationObserver(() => {
    clearTimeout(labelTimer);
    labelTimer = setTimeout(labelAll, 150);
  }).observe(document.body, { childList: true, subtree: true });
  labelAll();
})();
