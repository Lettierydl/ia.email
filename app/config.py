from __future__ import annotations

import os
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

# O container roda com relogio do sistema em UTC; todo horario exibido pro
# Leo tem que passar por essa TZ explicitamente (datetime.now() sozinho
# nao converte nada, so herda o fuso do SO).
TZ = ZoneInfo("America/Fortaleza")

ROOT = Path(__file__).resolve().parent.parent
ENV_POINTER = Path.home() / ".config" / "mind-matson" / "env-file"
if ENV_POINTER.is_file():
    pointed = Path(ENV_POINTER.read_text(encoding="utf-8").strip())
    if pointed.is_file():
        load_dotenv(pointed)
load_dotenv(ROOT / ".env", override=True)

DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

ACCOUNT = os.getenv("RADAR_ACCOUNT", "leo@confrapag.com.br").strip().lower()
HOST = os.getenv("RADAR_HOST", "127.0.0.1")
BIND_HOST = os.getenv("RADAR_BIND", HOST)
PORT = int(os.getenv("RADAR_PORT", "8765"))
PUBLIC_HOST = os.getenv("RADAR_PUBLIC_HOST", "127.0.0.1")
TOKEN_PATH = DATA_DIR / "gmail-token.json"
DB_PATH = DATA_DIR / "radar.sqlite"
RAG_DB_PATH = DATA_DIR / "rag.sqlite"
CLIENT_SECRETS_PATH = DATA_DIR / "client-secrets.json"

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/directory.readonly",
]
REDIRECT_URI = f"http://{PUBLIC_HOST}:{PORT}/api/auth/callback"

CONTEXT_MD = Path(
    "/Users/leo/Learning Base/principal_agents/emails/context.md"
)

# Pasta dedicada ao botao "exportar contexto" do Radar -- NUNCA usar
# CONTEXT_MD para isso: aquele arquivo ja tem uma rotina/ruleset de outro
# fluxo (Codex/MCP) e seria destruido por um write_text() nele.
# Um arquivo por e-mail exportado; arquivos mais velhos que
# EMAIL_EXPORT_RETENTION_DAYS sao apagados a cada nova exportacao.
EMAIL_EXPORT_DIR = Path(
    "/Users/leo/Learning Base/principal_agents/emails/radar-contextos"
)
EMAIL_EXPORT_RETENTION_DAYS = 7

# Pastas sugeridas por padrao na tela de configuracoes pra base de contexto
# (ficam desligadas ate o Leo ligar explicitamente -- so um ponto de partida).
# Duas bases separadas: uma focada em e-mail/trabalho (mais estreita, pensada
# pra dar contexto direcionado ao responder), outra a Learning Base inteira
# (mais ampla, conhecimento geral de sistemas/produto pra dar mais
# propriedade e automatizar respostas que dependem de contexto do negocio).
LEARNING_BASE_DEFAULT = Path("/Users/leo/Learning Base/principal_agents/emails")
LEARNING_BASE_GLOBAL_DEFAULT = Path("/Users/leo/Learning Base")

# lb-company/ e lb-personal/ -- usadas pelo roteamento de "Guardar no
# cerebro" e "Exportar contexto" pra escolher destino em QUALQUER lugar da
# Learning Base (nao so em principal_agents/*, que era o unico pedaco
# escrito antes). Precisa de mount read-write no docker-compose.yml.
LB_COMPANY_DIR = LEARNING_BASE_GLOBAL_DEFAULT / "lb-company"
LB_PERSONAL_DIR = LEARNING_BASE_GLOBAL_DEFAULT / "lb-personal"
CONTEXT_MAX_CHARS = 20000
CONTEXT_GLOBAL_MAX_CHARS = 15000
CONTEXT_MAX_FILES_LISTED = 300

HOME_CLIENT_SECRETS = Path.home() / ".config" / "mind-matson" / "gmail-oauth.keys.json"


def _first_env(*names: str) -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return ""


def client_id() -> str:
    return _first_env(
        "GOOGLE_GMAIL_CLIENT_ID",
        "GOOGLE_CLIENT_ID_GMAIL",
        "GOOGLE_CLIENT_ID",
    )


def client_secret() -> str:
    return _first_env(
        "GOOGLE_GMAIL_CLIENT_SECRET",
        "GOOGLE_CLIENT_SECRET_GMAIL",
        "GOOGLE_CLIENT_SECRET",
    )


def oauth_credentials_file() -> Path | None:
    for key in (
        "RADAR_GMAIL_OAUTH_CREDENTIALS",
        "GOOGLE_GMAIL_OAUTH_CREDENTIALS",
        "GOOGLE_OAUTH_CREDENTIALS",
    ):
        override = os.getenv(key, "").strip()
        if override and Path(override).is_file():
            return Path(override)
    if HOME_CLIENT_SECRETS.is_file():
        return HOME_CLIENT_SECRETS
    if CLIENT_SECRETS_PATH.is_file():
        return CLIENT_SECRETS_PATH
    return None
