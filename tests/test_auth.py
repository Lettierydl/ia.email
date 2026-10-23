"""Token de acesso (app/auth.py + middleware em app/main.py)."""
import logging

import pytest

from app import auth
from app.main import app
from conftest import TEST_TOKEN, RawTestClient

LOCAL_URL = "http://127.0.0.1:8765"
_GATEWAYS_REAL = auth._default_gateways


def _from_ip(ip):
    """App ASGI com IP de origem fixo (o TestClient manda "testclient")."""

    async def asgi(scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            scope = dict(scope, client=(ip, 50000))
        await app(scope, receive, send)

    return asgi


def _client(ip="203.0.113.7", base_url=LOCAL_URL, **kw):
    return RawTestClient(_from_ip(ip), base_url=base_url, follow_redirects=False, **kw)


@pytest.fixture(autouse=True)
def _sem_gateway(monkeypatch):
    # Determinístico: nenhum gateway docker "real" da máquina de teste.
    monkeypatch.setattr(auth, "_default_gateways", lambda *a, **k: set())
    monkeypatch.delenv("IA_EMAIL_AUTH_LOCAL_IPS", raising=False)
    monkeypatch.setenv("IA_EMAIL_AUTH_LOCALHOST_LIVRE", "true")
    monkeypatch.setenv(auth.ENV_KEY, TEST_TOKEN)


# ── sem token / token errado ───────────────────────────────────────────


def test_api_sem_token_401():
    res = _client().get("/api/status")
    assert res.status_code == 401
    assert res.json()["detail"] == auth.UNAUTHORIZED_DETAIL


def test_pagina_sem_token_redireciona_login():
    res = _client().get("/copilot/abc?x=1")
    assert res.status_code == 302
    assert res.headers["location"] == "/login?next=%2Fcopilot%2Fabc%3Fx%3D1"


@pytest.mark.parametrize("path", ["/", "/board", "/settings", "/mail/t1"])
def test_paginas_html_protegidas(path):
    assert _client().get(path).status_code == 302


def test_token_errado_401():
    c = _client()
    assert c.get("/api/health").status_code == 200
    assert c.get("/api/settings", headers={"Authorization": "Bearer errado"}).status_code == 401
    assert c.get("/api/settings", headers={"X-IA-Email-Token": "errado"}).status_code == 401
    c.cookies.set(auth.COOKIE_NAME, "errado")
    assert c.get("/api/settings").status_code == 401


def test_sem_token_configurado_nada_passa(monkeypatch):
    monkeypatch.setenv(auth.ENV_KEY, "")
    res = _client().get("/api/settings", headers={"Authorization": "Bearer "})
    assert res.status_code == 401


# ── formas aceitas ─────────────────────────────────────────────────────


def test_bearer_ok():
    res = _client().get("/api/settings", headers={"Authorization": f"Bearer {TEST_TOKEN}"})
    assert res.status_code == 200


def test_header_x_ia_email_token_ok():
    res = _client().get("/api/settings", headers={"X-IA-Email-Token": TEST_TOKEN})
    assert res.status_code == 200


def test_login_seta_cookie_httponly_e_libera_paginas():
    c = _client()
    res = c.post("/api/login", json={"token": TEST_TOKEN, "next": "/copilot"})
    assert res.status_code == 200
    assert res.json()["next"] == "/copilot"
    cookie = res.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert "secure" not in cookie  # http local
    assert TEST_TOKEN.lower() not in cookie  # cookie é HMAC, não o token
    assert c.get("/api/settings").status_code == 200
    assert c.get("/board").status_code == 200
    c.post("/api/logout")
    assert c.get("/api/settings").status_code == 401


def test_login_cookie_secure_em_https():
    res = _client(base_url="https://ia.exemplo").post("/api/login", json={"token": TEST_TOKEN})
    assert "secure" in res.headers["set-cookie"].lower()


def test_login_token_errado_401_sem_cookie():
    res = _client().post("/api/login", json={"token": "errado"})
    assert res.status_code == 401
    assert "set-cookie" not in res.headers


@pytest.mark.parametrize(
    "alvo,esperado",
    [("/copilot", "/copilot"), ("//evil.com", "/"), ("https://evil.com", "/"), ("/\\evil", "/"), ("/api/x", "/"), ("", "/")],
)
def test_next_so_caminho_local(alvo, esperado):
    assert auth.safe_next(alvo) == esperado


def test_rotacionar_derruba_cookie(monkeypatch):
    c = _client()
    c.post("/api/login", json={"token": TEST_TOKEN})
    monkeypatch.setenv(auth.ENV_KEY, "outro-token")
    assert c.get("/api/settings").status_code == 401


# ── rotas livres ───────────────────────────────────────────────────────


def test_health_login_static_livres():
    c = _client()
    assert c.get("/api/health").json() == {"ok": True}
    assert c.get("/login").status_code == 200
    assert c.get("/static/login.js").status_code == 200


def test_callback_oauth_protegido():
    # Protegido de propósito: o redirect do Google é navegação top-level,
    # então o cookie SameSite=Lax vai junto (e do Mac é local de todo jeito).
    assert _client().get("/api/auth/callback?code=x").status_code == 401


# ── localhost livre ────────────────────────────────────────────────────


def test_loopback_livre_ligado():
    assert _client("127.0.0.1").get("/api/settings").status_code == 200
    assert _client("127.0.0.1").get("/copilot").status_code == 200


def test_loopback_livre_desligado(monkeypatch):
    monkeypatch.setenv("IA_EMAIL_AUTH_LOCALHOST_LIVRE", "false")
    assert _client("127.0.0.1").get("/api/settings").status_code == 401
    res = _client("127.0.0.1").get("/api/settings", headers={"Authorization": f"Bearer {TEST_TOKEN}"})
    assert res.status_code == 200


def test_gateway_docker_conta_como_local(monkeypatch):
    monkeypatch.setattr(auth, "_default_gateways", lambda *a, **k: {"172.18.0.1"})
    assert _client("172.18.0.1").get("/api/settings").status_code == 200
    assert _client("172.18.0.5").get("/api/settings").status_code == 401


def test_ips_extras_por_env(monkeypatch):
    monkeypatch.setenv("IA_EMAIL_AUTH_LOCAL_IPS", "192.168.65.1")
    assert _client("192.168.65.1").get("/api/settings").status_code == 200


@pytest.mark.parametrize(
    "header",
    ["X-Forwarded-For", "Forwarded", "X-Real-IP", "Via", "CF-Connecting-IP", "Tailscale-User-Login", "X-Forwarded-Proto"],
)
def test_header_de_proxy_nao_vira_local(header):
    res = _client("127.0.0.1").get("/api/settings", headers={header: "1.2.3.4"})
    assert res.status_code == 401


def test_host_de_tunel_nao_vira_local():
    res = _client("127.0.0.1", base_url="https://mac.tailnet.ts.net").get("/api/settings")
    assert res.status_code == 401


def test_host_localhost_e_ipv6():
    assert auth.is_local_request("::1", {"host": "[::1]:8765"}, gateways=set())
    assert auth.is_local_request("127.0.0.1", {"host": "localhost:8765"}, gateways=set())
    assert not auth.is_local_request(None, {"host": "localhost"}, gateways=set())
    assert not auth.is_local_request("10.0.0.2", {"host": "localhost"}, gateways=set())


def test_gateway_lido_do_proc_net_route(tmp_path):
    route = tmp_path / "route"
    route.write_text(
        "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\n"
        "eth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000\n"
        "eth0\t000012AC\t00000000\t0001\t0\t0\t0\t0000FFFF\n"
    )
    assert _GATEWAYS_REAL(route) == {"172.18.0.1"}


# ── token nunca em log ─────────────────────────────────────────────────


def test_token_nao_aparece_em_logs(caplog, capsys, monkeypatch):
    caplog.set_level(logging.DEBUG)
    c = _client()
    c.get("/api/settings", headers={"Authorization": f"Bearer {TEST_TOKEN}x"})
    c.get("/api/settings", headers={"X-IA-Email-Token": TEST_TOKEN})
    c.post("/api/login", json={"token": TEST_TOKEN})
    c.post("/api/login", json={"token": TEST_TOKEN + "errado"})
    c.get("/copilot")
    out = capsys.readouterr()
    assert TEST_TOKEN not in caplog.text
    assert TEST_TOKEN not in out.out + out.err


# ── .env ───────────────────────────────────────────────────────────────


def test_ensure_token_gera_e_grava_no_env(tmp_path, monkeypatch, capsys):
    env = tmp_path / ".env"
    env.write_text("GOOGLE_GMAIL_CLIENT_ID=abc\n# comentario\n")
    monkeypatch.delenv(auth.ENV_KEY, raising=False)
    assert auth.ensure_token(env) is True
    gerado = auth.read_env_value(auth.ENV_KEY, env)
    assert len(gerado) >= 40
    assert "GOOGLE_GMAIL_CLIENT_ID=abc" in env.read_text()
    assert oct(env.stat().st_mode)[-3:] == "600"
    # segunda vez não troca
    monkeypatch.delenv(auth.ENV_KEY, raising=False)
    assert auth.ensure_token(env) is False
    assert auth.read_env_value(auth.ENV_KEY, env) == gerado
    assert gerado not in capsys.readouterr().out


def test_rotate_token_troca_valor(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    monkeypatch.delenv(auth.ENV_KEY, raising=False)
    auth.ensure_token(env)
    antes = auth.read_env_value(auth.ENV_KEY, env)
    auth.rotate_token(env)
    assert auth.read_env_value(auth.ENV_KEY, env) != antes
    assert env.read_text().count(auth.ENV_KEY) == 1


def test_setup_oauth_nao_apaga_token(tmp_path, monkeypatch):
    from app import main

    monkeypatch.setattr(main, "ROOT", tmp_path)
    monkeypatch.setenv("GOOGLE_GMAIL_CLIENT_ID", "")
    monkeypatch.setenv("GOOGLE_GMAIL_CLIENT_SECRET", "")
    (tmp_path / ".env").write_text(f"{auth.ENV_KEY}=preservar\n")
    monkeypatch.setattr(main.gmail_client, "has_client", lambda: True)
    res = _client("127.0.0.1").post("/api/auth/setup", json={"client_id": "cid", "client_secret": "sec"})
    assert res.status_code == 200
    texto = (tmp_path / ".env").read_text()
    assert f"{auth.ENV_KEY}=preservar" in texto and "GOOGLE_GMAIL_CLIENT_ID=cid" in texto
