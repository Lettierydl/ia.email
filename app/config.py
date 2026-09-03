from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

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
CLIENT_SECRETS_PATH = DATA_DIR / "client-secrets.json"

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
]
REDIRECT_URI = f"http://{PUBLIC_HOST}:{PORT}/api/auth/callback"

CONTEXT_MD = Path(
    "/Users/leo/Learning Base/principal_agents/emails/context.md"
)

# Arquivo dedicado ao botao "exportar contexto" do Radar -- NUNCA usar
# CONTEXT_MD para isso: aquele arquivo ja tem uma rotina/ruleset de outro
# fluxo (Codex/MCP) e seria destruido por um write_text().
EMAIL_EXPORT_MD = Path(
    "/Users/leo/Learning Base/principal_agents/emails/radar-email-atual.md"
)

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
