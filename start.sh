#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
exec docker compose up -d --build
