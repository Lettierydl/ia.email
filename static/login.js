// Tela /login: manda o token pro /api/login, que devolve o cookie httpOnly
// da sessão e o caminho seguro pra voltar (?next=).
(function () {
  const form = document.getElementById("lg-form");
  const input = document.getElementById("lg-token");
  const erro = document.getElementById("lg-erro");
  const botao = document.getElementById("lg-entrar");
  const next = new URLSearchParams(location.search).get("next") || "/";

  function mostrarErro(msg) {
    erro.textContent = msg;
    erro.hidden = !msg;
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const token = input.value.trim();
    if (!token) {
      mostrarErro("Cole o token de acesso.");
      return;
    }
    botao.disabled = true;
    mostrarErro("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, next }),
        credentials: "same-origin",
      });
      if (res.status === 401) {
        mostrarErro("Token inválido. Confira e tente de novo.");
        input.select();
        return;
      }
      if (!res.ok) {
        mostrarErro("Não deu para entrar agora. Tente de novo.");
        return;
      }
      const data = await res.json();
      location.replace(data.next || "/");
    } catch (_) {
      mostrarErro("Servidor fora do ar. Confira se o IA.Email está rodando.");
    } finally {
      botao.disabled = false;
    }
  });
})();
