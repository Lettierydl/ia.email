"""Token de acesso da API e das páginas do IA.Email.

Só stdlib de propósito: `python -m app.auth` roda no Mac (start.sh, app de
mesa) antes do container subir, às vezes com o python3 do sistema.

Regras (ver também SUMMARY/README):
- O token mora em IA_EMAIL_API_TOKEN, no .env da RAIZ do projeto no host.
  O docker-compose lê esse .env via env_file, então o container só enxerga
  um token novo depois de recriado (start.sh / `docker compose up -d`).
- O valor NUNCA é impresso nem logado (exceto `--mostrar`, pedido explícito).
- Aceito em `Authorization: Bearer <t>`, `X-IA-Email-Token: <t>` ou no cookie
  httpOnly do web (que guarda um HMAC derivado do token, não o token).
- "Local livre" (IA_EMAIL_AUTH_LOCALHOST_LIVRE, padrão true): dispensa token
  só para requisição que veio do próprio Mac. Ver `is_local_request`.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import ipaddress
import os
import secrets
import sys
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = ROOT / ".env"
ENV_KEY = "IA_EMAIL_API_TOKEN"
COOKIE_NAME = "ia_email_sessao"
COOKIE_MAX_AGE = 60 * 60 * 24 * 90  # 90 dias
UNAUTHORIZED_DETAIL = "Token inválido ou ausente."

# Rotas que nunca pedem token. /static fica livre: só tem HTML/CSS/JS sem
# dado nenhum (os dados vêm todos de /api/*, que é protegido).
PUBLIC_PATHS = {"/api/health", "/login", "/api/login", "/api/logout", "/favicon.ico"}
PUBLIC_PREFIXES = ("/static/",)

# Qualquer um desses headers = a requisição passou por proxy/túnel
# (cloudflared, Tailscale serve/funnel, nginx...). Aí nunca é "local", mesmo
# que o IP de origem pareça ser o do Mac.
PROXY_HEADERS = (
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-port",
    "x-real-ip",
    "forwarded",
    "via",
    "true-client-ip",
    "cf-connecting-ip",
    "cf-ray",
    "cf-visitor",
    "tailscale-user-login",
    "tailscale-user-name",
    "tailscale-headers-info",
)
LOCAL_HOSTNAMES = {"127.0.0.1", "localhost", "::1"}


# ── .env ───────────────────────────────────────────────────────────────


def read_env_value(key: str, env_path: Path = ENV_PATH) -> str:
    if not env_path.is_file():
        return ""
    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or "=" not in stripped:
            continue
        name, _, value = stripped.partition("=")
        if name.strip().removeprefix("export ").strip() == key:
            return value.strip().strip('"').strip("'")
    return ""


def upsert_env(values: dict, env_path: Path = ENV_PATH) -> None:
    """Atualiza/insere chaves no .env sem apagar as outras linhas."""
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.is_file() else []
    pending = dict(values)
    out = []
    for line in lines:
        stripped = line.strip()
        name = stripped.partition("=")[0].strip().removeprefix("export ").strip()
        if not stripped.startswith("#") and "=" in stripped and name in pending:
            out.append(f"{name}={pending.pop(name)}")
        else:
            out.append(line)
    out.extend(f"{k}={v}" for k, v in pending.items())
    env_path.write_text("\n".join(out) + "\n", encoding="utf-8")
    try:
        env_path.chmod(0o600)
    except OSError:
        pass


def current_token() -> str:
    return os.environ.get(ENV_KEY, "").strip()


def ensure_token(env_path: Path = ENV_PATH) -> bool:
    """Garante um token: env > .env > gera e grava no .env. True se gerou.

    Rodando no container, /app/.env não é o .env do host (não há volume pra
    ele): quem gera de verdade é o start.sh / app de mesa no Mac, antes do
    `docker compose up`. Se mesmo assim faltar, o token gerado aqui fica só
    no container e ninguém o conhece -- falha fechada para acesso remoto, e o
    acesso local segue pela regra de localhost.
    """
    if current_token():
        return False
    saved = read_env_value(ENV_KEY, env_path)
    if saved:
        os.environ[ENV_KEY] = saved
        return False
    token = secrets.token_urlsafe(32)
    try:
        upsert_env({ENV_KEY: token}, env_path)
    except OSError:
        pass
    os.environ[ENV_KEY] = token
    return True


def rotate_token(env_path: Path = ENV_PATH) -> None:
    token = secrets.token_urlsafe(32)
    upsert_env({ENV_KEY: token}, env_path)
    os.environ[ENV_KEY] = token


# ── validação ─────────────────────────────────────────────────────────


def token_ok(candidate: Optional[str]) -> bool:
    expected = current_token()
    if not expected or not candidate:
        return False
    return hmac.compare_digest(candidate.strip().encode(), expected.encode())


def session_value() -> str:
    """Valor do cookie: HMAC do token (rotacionar o token derruba as sessões)."""
    expected = current_token()
    return hmac.new(expected.encode(), b"ia-email-web-sessao", hashlib.sha256).hexdigest()


def cookie_ok(candidate: Optional[str]) -> bool:
    if not current_token() or not candidate:
        return False
    return hmac.compare_digest(candidate.encode(), session_value().encode())


def localhost_livre() -> bool:
    raw = os.environ.get("IA_EMAIL_AUTH_LOCALHOST_LIVRE", "true").strip().lower()
    return raw not in ("0", "false", "no", "nao", "não", "off")


def _default_gateways(route_file: Path = Path("/proc/net/route")) -> set:
    """Gateway(s) padrão do container (Linux). Vazio fora do Linux/Docker."""
    gateways = set()
    try:
        rows = route_file.read_text().splitlines()[1:]
    except OSError:
        return gateways
    for row in rows:
        cols = row.split()
        if len(cols) > 2 and cols[1] == "00000000":
            try:
                gw = bytes.fromhex(cols[2])[::-1]
                gateways.add(str(ipaddress.IPv4Address(gw)))
            except ValueError:
                continue
    return gateways


def local_ips() -> set:
    """IPs de origem tratados como "o próprio Mac".

    - loopback (127.0.0.0/8, ::1): app rodando direto no Mac;
    - gateway padrão do container: com a porta publicada em 127.0.0.1, o
      Docker entrega a conexão vinda do Mac com o IP do gateway da bridge;
    - IA_EMAIL_AUTH_LOCAL_IPS (vírgula): escape manual se o Docker Desktop
      usar outro IP de origem.
    """
    ips = set(_default_gateways())
    extra = os.environ.get("IA_EMAIL_AUTH_LOCAL_IPS", "")
    ips.update(part.strip() for part in extra.split(",") if part.strip())
    return ips


def _is_loopback(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_loopback
    except ValueError:
        return False


def _host_name(host_header: str) -> str:
    host = (host_header or "").strip().lower()
    if host.startswith("["):
        return host[1:].split("]", 1)[0]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def is_local_request(client_ip: Optional[str], headers, gateways: Optional[Iterable[str]] = None) -> bool:
    """Requisição feita do próprio Mac, sem passar por proxy/túnel.

    As três condições juntas:
    1. IP de origem é loopback ou gateway da bridge docker (ou extra manual);
    2. nenhum header de proxy (X-Forwarded-*, Forwarded, Via, CF-*, Tailscale-*);
    3. Host é 127.0.0.1/localhost/::1 (túnel manda o nome público dele).
    Um túnel rodando no Mac que encaminha TCP cru para 127.0.0.1:8765 sem
    reescrever nada passaria -- por isso, ao expor, desligue
    IA_EMAIL_AUTH_LOCALHOST_LIVRE.
    """
    if not client_ip:
        return False
    allowed = set(gateways) if gateways is not None else local_ips()
    if not (_is_loopback(client_ip) or client_ip in allowed):
        return False
    lowered = {k.lower() for k in headers.keys()}
    if any(h in lowered for h in PROXY_HEADERS):
        return False
    return _host_name(headers.get("host", "")) in LOCAL_HOSTNAMES


def is_public_path(path: str) -> bool:
    return path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES)


def extract_token(headers) -> str:
    auth = headers.get("authorization", "")
    if auth[:7].lower() == "bearer ":
        return auth[7:].strip()
    return headers.get("x-ia-email-token", "").strip()


def request_authorized(request) -> bool:
    if localhost_livre() and is_local_request(
        request.client.host if request.client else None, request.headers
    ):
        return True
    if token_ok(extract_token(request.headers)):
        return True
    return cookie_ok(request.cookies.get(COOKIE_NAME))


def safe_next(target: Optional[str]) -> str:
    """Só caminho relativo do próprio app (evita open redirect)."""
    target = (target or "").strip()
    if not target.startswith("/") or target.startswith("//") or "\\" in target:
        return "/"
    if target.startswith(("/login", "/api/")):
        return "/"
    return target


def login_redirect_url(path: str, query: str = "") -> str:
    target = path + (f"?{query}" if query else "")
    return "/login?next=" + quote(safe_next(target), safe="")


def is_https(request) -> bool:
    if request.url.scheme == "https":
        return True
    return request.headers.get("x-forwarded-proto", "").lower() == "https"


# ── CLI ───────────────────────────────────────────────────────────────


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.auth",
        description="Token de acesso do IA.Email (IA_EMAIL_API_TOKEN no .env do projeto).",
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--garantir", action="store_true", help="gera e grava no .env se ainda não existir (não imprime)")
    group.add_argument("--mostrar", action="store_true", help="imprime o token atual")
    group.add_argument("--rotacionar", action="store_true", help="gera um token novo e grava no .env (não imprime)")
    args = parser.parse_args(argv)

    if args.garantir:
        os.environ.pop(ENV_KEY, None)
        created = ensure_token()
        print("Token gerado e gravado no .env." if created else "Token já existe no .env.")
        return 0
    if args.rotacionar:
        rotate_token()
        print(
            "Token novo gravado no .env. Recrie o container (./start.sh) para valer; "
            "web, app de mesa e iPad vão pedir o token de novo."
        )
        return 0
    token = read_env_value(ENV_KEY)
    if not token:
        print("Ainda não há token. Rode: python -m app.auth --garantir", file=sys.stderr)
        return 1
    print(token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
