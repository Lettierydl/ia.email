"""Roda o Verificador numa thread real, pelo terminal (SÓ LEITURA no Gmail).

    .venv/bin/python -m app.verify_cli <thread_id>              # usa o cache se houver
    .venv/bin/python -m app.verify_cli <thread_id> --regerar    # refaz (IA + buscas)
    .venv/bin/python -m app.verify_cli <thread_id> --json       # resposta crua da API
    .venv/bin/python -m app.verify_cli --consulta 'from:x@y.com in:anywhere'  # só a busca saneada

No Gmail, só users.threads.get / users.messages.list / users.messages.get
(format=metadata). Nada é enviado, marcado, arquivado nem rotulado. Grava
apenas no SQLite local (cache da verificação e, se a thread ainda não estava
no radar, os metadados dela).
"""
from __future__ import annotations

import argparse
import json
import sys

from . import gmail_client, store, verify

_SELO = {"confirmado": "✅ Confirmado", "nao_encontrado": "⚪ Não encontrado", "inconclusivo": "🟡 Inconclusivo"}


def _print(out: dict) -> None:
    origem = "cache" if out.get("cached") else "gerado agora"
    print(f"Gerado em {out.get('gerado_em') or '?'} ({origem}){' · DESATUALIZADO' if out.get('desatualizado') else ''}")
    if out.get("aviso"):
        print(f"Aviso: {out['aviso']}")
    for i, af in enumerate(out.get("afirmacoes") or [], 1):
        print(f"\n{i}. {af['texto']}\n   {_SELO.get(af['veredito'], af['veredito'])} — {af['explicacao']}")
        for ev in af.get("evidencias") or []:
            print(f"   · {ev['data']} | {ev['de']} | {ev['assunto']} [{ev.get('pasta', '')}]")
            print(f"     {ev['gmail_url']}{'  (no app: ' + ev['app_url'] + ')' if ev.get('app_url') else ''}")
        for c in af.get("consultas") or []:
            print(f"   ? {c['q']} -> {c['resultados']}{' ERRO: ' + c['erro'] if c.get('erro') else ''}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m app.verify_cli", description="Verificador (só leitura no Gmail).")
    ap.add_argument("thread_id", nargs="?")
    ap.add_argument("--regerar", action="store_true", help="ignora o cache e refaz")
    ap.add_argument("--json", action="store_true", help="imprime o JSON da API")
    ap.add_argument("--consulta", help="só roda uma busca saneada e lista os resultados")
    args = ap.parse_args(argv)
    store.init()
    if args.consulta:
        q = verify.sanitize_query(args.consulta)
        print(f"Consulta saneada: {q!r}")
        if q:
            for hit in gmail_client.search_messages(q, verify.MAX_RESULTADOS):
                print(f"· {hit['data']} | {hit['de']} | {hit['assunto']} | {hit['thread_id']}")
        return 0
    if not args.thread_id:
        ap.error("informe o thread_id (ou --consulta)")
    if not store.get_thread(args.thread_id):
        print("Thread fora do radar local: buscando os metadados no Gmail (só leitura)…", file=sys.stderr)
        gmail_client.refresh_thread(args.thread_id)
    try:
        out = verify.verificar(args.thread_id, force=args.regerar)
    except (LookupError, RuntimeError) as exc:
        print(f"Erro: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        _print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
