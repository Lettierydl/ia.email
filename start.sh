#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
# Token de acesso (IA_EMAIL_API_TOKEN) tem que existir no .env do HOST antes
# do compose: o container só lê o .env via env_file. Não imprime o valor.
if [[ -x .venv/bin/python ]]; then
  .venv/bin/python -m app.auth --garantir
else
  python3 -m app.auth --garantir
fi
exec docker compose up -d --build
