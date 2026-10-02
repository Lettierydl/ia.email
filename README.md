# IA.Email

Leitor local da caixa Principal (`leo@confrapag.com.br`). Roda sozinho: nao depende do chat do Cursor.

Lista / classifica / atualiza, resume com IA e sugere rascunho de resposta (nunca envia, sem MCP).

## LLM (resumo, rascunho, análise)

Suporta três provedores (Gemini, OpenRouter e Claude), usados como uma **cadeia em ordem de
prioridade**: o app tenta o primeiro modelo e, se acabar a cota, a cobrança falhar ou ele cair,
passa para o próximo. A ordem se escolhe em **Configurações → Modelos de IA** (padrão: Gemini
primeiro, depois modelos gratuitos do OpenRouter). Só entram na cadeia os provedores com chave
no `.env` (veja `.env.example`). O modelo que respondeu por último aparece no cabeçalho do painel.
`RADAR_LLM_PROVIDER` ainda existe, mas só muda qual provedor vem primeiro quando a cadeia não foi
personalizada.

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

## App de mesa (Electron)

Prefere uma janela própria em vez de aba do navegador? `desktop/` tem um
wrapper Electron que sobe o mesmo Docker e abre a mesma tela numa janela
nativa — veja `desktop/README.md`.
