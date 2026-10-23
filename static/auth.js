// Carregado antes dos outros scripts: qualquer chamada /api/* que voltar 401
// (token ausente/expirado, ex.: depois de rotacionar) manda pra /login e volta
// pra mesma página depois. Os fetch() do app ficam como estão.
(function () {
  const originalFetch = window.fetch.bind(window);
  let redirecionando = false;

  function ehApiDoApp(input) {
    try {
      const raw = typeof input === "string" ? input : (input && input.url) || "";
      const url = new URL(raw, location.href);
      return url.origin === location.origin && url.pathname.startsWith("/api/") && url.pathname !== "/api/login";
    } catch (_) {
      return false;
    }
  }

  window.fetch = async function (input, init) {
    const res = await originalFetch(input, init);
    if (res.status === 401 && !redirecionando && ehApiDoApp(input)) {
      redirecionando = true;
      const next = location.pathname + location.search;
      location.href = "/login?next=" + encodeURIComponent(next);
    }
    return res;
  };
})();
