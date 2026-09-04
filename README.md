# IA.Email

Leitor local da caixa Principal (`leo@confrapag.com.br`). Roda sozinho: nao depende do chat do Cursor.

Lista / classifica / atualiza, resume com IA e sugere rascunho de resposta (nunca envia, sem MCP).

## LLM (resumo, rascunho, análise)

Suporta três provedores, escolhidos automaticamente pela primeira chave presente no `.env`
(ordem: Claude > Gemini > OpenRouter), ou fixados com `RADAR_LLM_PROVIDER=anthropic|gemini|openrouter`.
Veja `.env.example` para as variáveis de cada um. O provedor ativo aparece no cabeçalho do painel.

## Subir (Docker — fica no ar até você desligar)

```bash
cd /Users/leo/Workspace/Assistentes/ia_email
docker compose up -d --build
```

Abra http://127.0.0.1:8765

```bash
docker compose down          # desliga
docker compose logs -f radar # log
```

Abra http://127.0.0.1:8765 — **Entrar no Gmail** na primeira vez.

Cliente OAuth: tipo **Desktop**, Gmail API ligada. Redirect usado:

`http://127.0.0.1:8765/api/auth/callback`

No Google Cloud, se o login falhar com `redirect_uri_mismatch`, acrescente esse URI (ou use Desktop, que aceita loopback).

Token fica em `data/gmail-token.json` (nao versionado). Escopos atuais: `gmail.modify` e `gmail.send`.
