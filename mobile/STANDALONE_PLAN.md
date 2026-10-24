# IA.Email standalone no iPad/iPhone — plano

Objetivo: o app faz tudo sozinho no aparelho (Gmail + IA + banco local), sem o FastAPI do Mac e sem Tailscale.

## 1. Backend atual (app/*.py, ~12,4 mil linhas) → o que vai para TypeScript

| Módulo | Linhas | Destino | Observação |
|---|---|---|---|
| gmail_client.py | 1042 | **Portar** (`src/core/gmail.ts`) | REST da Gmail API via fetch: threads.list/get, modify (labels/lido), drafts, send (MIME base64url), attachments. Parsing MIME/inline (cid) reaproveita a lógica da r22. ~600 linhas TS. |
| llm.py | 448 | **Portar** (`core/llm.ts`) | Cadeia Gemini Flash → Flash-Lite → openrouter/free → Gemma, cooldown 429/404, retry sem thinkingConfig. ~250 TS. |
| copilot.py | 1977 | **Portar o núcleo** (`core/copilot.ts`) | Prompts, `_parse`, heurísticas de papel/bola/urgência, abas do kanban. Lote/fila vira loop com concorrência 2–3. ~900 TS. |
| assistant.py | 1537 | **Portar por partes** | `draft()` com blocos rotulados (r21), resumos, Q&A. Prompts copiados literalmente. ~700 TS. |
| draft_guard.py | 254 | **Portar 1:1** | Puro texto/regex. ~180 TS. |
| verify.py | 406 | Fase 3 | Busca na caixa (Gmail search `q=`) + LLM. |
| summary_templates.py, fixpt.py, recipients.py, classifier.py, board.py, learned.py | ~880 | Portar (prompts/regras puras) | Fácil, quase só strings e regras. |
| history.py | 358 | Portar (fase 3) | Tabela de ações + reversão via labels Gmail. |
| store.py | 1203 | **Reescrever** em `expo-sqlite` | Mesmo esquema SQL (copiar os CREATE TABLE); só a camada de acesso muda. ~600 TS. |
| outbox.py | 344 | Fase 2 | Envio com janela de desfazer: vira fila local + timer enquanto o app está aberto. |
| rag.py, context_base.py, fs_browser.py, metrics.py, assist.py | ~990 | Adiar/descartar | Dependem do disco do Mac / embeddings. |
| calendar_client.py, people_client.py | 333 | Fase 3 (opcional) | Mesmo OAuth, outros escopos. |
| main.py, auth.py, config.py, netstatus.py, preload.py, secrets_guard.py, verify_cli.py | ~2200 | **Não vai** | Servidor HTTP/auth/CLI deixam de existir. |

Reaproveitamento direto: todos os prompts (copilot, draft, resumos, verificador, fixpt), o esquema SQLite, os testes do pytest como especificação (casos viram testes Jest), a UI já feita na r23 (telas, ConfirmModal, MessageParts). Estimativa total: ~4–5 mil linhas TS.

Arquitetura: `src/core/*` (sem React) com a mesma "API" que o `src/api.ts` usa hoje → as telas mudam pouco (troca `fetch(servidor)` por chamadas locais).

## 2. Gmail no iOS

- Biblioteca recomendada: **`@react-native-google-signin/google-signin`** (Sign in with Google nativo; dá `accessToken` renovável). Alternativa: `expo-auth-session` (PKCE) com client iOS.
- **Exige development build**: ambos precisam do URL scheme do client iOS (reversed client id) no Info.plist; **não funciona no Expo Go**. Portanto depende da conta Apple ativa (EAS build) — ou do Xcode com licença aceita para build local.
- Escopos: `gmail.modify` (ler, labels, lido/arquivar), `gmail.compose` (rascunhos), `gmail.send` (envio); opcional `calendar.events`, `contacts.readonly`.
- **Leo cria no Google Cloud** (pode ser o mesmo projeto do backend atual):
  1. Credencial OAuth "iOS" com bundle `com.leodlamare.iaemail` → anota o iOS client ID e o reversed client ID.
  2. Tela de consentimento: tipo Externo, Leo como test user. Em modo **Testing** o refresh token expira em **7 dias** (relogar semanal). Para não expirar: publicar "In production" sem verificação (aviso de "app não verificado", limite 100 usuários — ok para uso pessoal). Escopos Gmail são *restritos*: verificação/auditoria só seria exigida para distribuir a terceiros.
- Tokens no `expo-secure-store` (o google-signin já guarda no Keychain).

### 2.1 Onde colar o client ID iOS (Fase 1 já implementada)

O app lê o client ID do `app.json` e vem com **placeholder**. Enquanto ele não for trocado, Ajustes → Conta Google mostra "client ID não configurado". No Expo Go, mostra "requer development build". Nos dois casos o resto do app continua funcionando.

Depois de criar a credencial OAuth **iOS** no Google Cloud (bundle `com.leodlamare.iaemail`), o console mostra um client ID no formato `123456789-abc123.apps.googleusercontent.com`. Cole em **dois lugares** do `mobile/app.json`:

1. `expo.extra.googleAuth.iosClientId`: o client ID inteiro.
   ```json
   "extra": { "googleAuth": { "iosClientId": "123456789-abc123.apps.googleusercontent.com" } }
   ```
2. `iosUrlScheme`, dentro do plugin `@react-native-google-signin/google-signin` em `expo.plugins`: o **reversed client ID**, ou seja, `com.googleusercontent.apps.` + a parte do client ID antes de `.apps.googleusercontent.com`.
   ```json
   ["@react-native-google-signin/google-signin", { "iosUrlScheme": "com.googleusercontent.apps.123456789-abc123" }]
   ```

O `iosUrlScheme` vai para o Info.plist **no build**. Depois de trocar os valores, é preciso gerar um **novo development build** (`eas build --profile development`); recarregar o JS não basta.

- Escopo pedido: **só** `https://www.googleapis.com/auth/gmail.modify`. Esse escopo cobre ler, mexer em rótulos e marcar como lido/arquivar. Rascunho e envio (`gmail.compose`/`gmail.send`) ficam para a Fase 2.
- Na tela de consentimento do Google Cloud, deixe o escopo `gmail.modify` cadastrado e o Leo como test user (ou publique "In production" sem verificação, ver acima).
- O token fica com o google-signin (Keychain) e é renovado sozinho (`getTokens`). Ele nunca vai para o SQLite, para log ou para a tela.

### 2.2 O que a Fase 1 faz no aparelho (fonte "local")

- **Sync** (`src/core/sync.ts`): roda ao abrir o app, ao voltar para ele (AppState `active`), no puxar-para-baixo e no ⟳. É incremental pelo `historyId` (`history.list`). Se o history devolver 404, ou se ainda não houver `historyId` salvo, faz a listagem completa, igual ao `refresh()` do Mac: 50 recentes da Principal + 300 não lidas. Grava `threads`, `messages` (com anexos e imagens inline) e `threads.body_text`, este no formato do Mac.
- **Copiloto** (`src/core/copilot.ts`): é o porte do `app/copilot.py`, com os mesmos prompts (há um teste que compara o texto com o Python, caractere a caractere). As regras "só em cópia" e "pedido a outra pessoa" estão incluídas. A fila tem concorrência 2 e grava em `copilot_items`. Sem chave de IA, a leitura é por regra.
- **Telas**: quadro, lista e detalhe leem pela camada `src/data/`. A fonte é "local" (padrão) ou "servidor", escolhida em Ajustes → Fonte de dados. Na Fase 1, ações, rascunho, envio, resumos, histórico e "aprender" ainda usavam o servidor; ações, rascunho, envio e histórico passaram para o aparelho na Fase 2 (seção 2.3).

### 2.3 O que a Fase 2 faz no aparelho (fonte "local")

- **Ações** (`src/core/actions.ts`, porte de `ACTIONS`/`act` do `copilot.py`): acompanhar/assumir, cobrar, delegar (às claras ou e-mail novo silencioso, com recado), aplicar sugestão, resolver, reabrir, aguardar, só conhecimento e tarefa. Status em `copilot_items`, registro em `copilot_actions` e linha em `historico_acoes` (`src/core/history.ts`, porte de `history.py`). **Resolver** marca lido **e arquiva** no Gmail (`modify` tirando `UNREAD` e `INBOX`); desfazer recoloca os dois rótulos. A tela Histórico desfaz/refaz no próprio aparelho.
- **Rascunho com IA** (`src/core/assistant.ts`): porte do `draft()` com os mesmos prompts (teste compara com o Python), "usar meu texto" com o `fixpt.ts` e a guarda de vazamento (uma nova tentativa com "CORREÇÃO OBRIGATÓRIA"; se persistir, o composer destaca os trechos). Sem RAG/cérebro do Mac.
- **Envio** (`src/core/outbox.ts`): MIME RFC 2822 em UTF-8 (assunto com acento em RFC 2047, `In-Reply-To`/`References`, `threadId`), `messages.send` com o escopo `gmail.modify`. Sempre: ConfirmModal "Enviar para X?" → fila com **10 s para desfazer** → envio. Sem rede, fica na fila e sai no próximo sync/volta ao app; o detalhe mostra o status e permite cancelar.
- **Composer**: escolhe a mensagem a responder (padrão: última de outra pessoa), Para/Cc em chips com sugestões dos participantes, pré-preenchidos como "responder a todos" sem o Leo.
- Ainda no servidor depois da Fase 2: resumos detalhados/por mensagem, Verificar na caixa, Aprender (passaram para o aparelho na Fase 3, seção 2.4), avatar, prefs/digest, links "Abrir no /mail".

### 2.4 O que a Fase 3 faz no aparelho (fonte "local")

- **Resumos** (`src/core/summaries.ts`, porte de `resumo_detalhado`/`resumo_mensagem` do `copilot.py`): mesmos prompts e mesma limpeza da resposta (teste compara com o Python). Cache no SQLite (`copilot_resumos` com retrato `internal_date` + nº de mensagens: mensagem nova deixa desatualizado e regera; `copilot_msg_resumos` por SHA-256 do texto + modo). Regerar refaz; se a IA falhar e houver cache, mostra o antigo com aviso. Os "trechos de contexto" são só as decisões anteriores do banco (sem RAG). Os modelos de `summary_templates.py` estão em `src/core/summaryTemplates.ts` (iguais ao Python; ainda sem tela de escolha no app).
- **Verificar na caixa** (`src/core/verify.ts`, porte de `verify.py`): IA extrai afirmações → consultas saneadas (só operadores conhecidos) → `gmail.searchMessages` (só `messages.list` + `messages.get format=metadata`, nada de modify/send) → IA julga. Cache em `copilot_verificacoes`; mensagem nova invalida.
- **Aprender** (`src/core/learned.ts`): adicionar (thread/pessoa/geral, mesmas validações e mensagens do Python, bloqueia credencial), listar as relevantes à conversa e remover. Continua entrando nos prompts do copiloto, do rascunho e dos resumos pelo `notesBlock`. Sem o espelho Markdown na Learning Base.
- **Telas**: `ResumoSheet`, `VerifySheet`, o "Resumir este e-mail" do `MessageParts` e o `LearnSheet` usam a camada `src/data/` (local ou servidor), não o `api.ts` direto.
- **Segundo plano** (`src/core/background.ts`): a tarefa `runBackgroundSync` faz só o sync incremental curto (sem login ou sem `historyId` → não roda; sem IA, sem outbox). `expo-background-task`/`expo-task-manager` **não estão instalados**: o registro recebe um adaptador e hoje fica "indisponível". Para ligar: `npx expo install expo-background-task expo-task-manager` + o trecho comentado no topo do arquivo + novo development build.
- Ainda no servidor: avatar, prefs/digest do painel, links "Abrir no /mail", RAG/cérebro do Mac, resolver coluna inteira, calendário/contatos.

## 3. Chaves de IA no aparelho

- Tela Ajustes: campos Gemini API key e OpenRouter API key → `expo-secure-store` (Keychain). Nunca no SQLite nem em log.
- Gemini (`generativelanguage.googleapis.com`) e OpenRouter (`openrouter.ai/api/v1`) funcionam com `fetch` no React Native (não há CORS em app nativo; HTTPS satisfaz o ATS). Funciona inclusive no Expo Go.
- Cuidado: timeout via `AbortController`; respostas grandes ok.

## 4. Banco e sincronização

- `expo-sqlite` (funciona no Expo Go): tabelas threads, messages, copilot_items, historico_acoes, settings, llm_usage — portar o esquema de store.py. Anexos/imagens: cache em `expo-file-system` com limite e limpeza.
- Sync: (a) ao abrir/voltar ao app (`AppState` active) → `history.list` do Gmail a partir do último `historyId` (incremental, barato); (b) pull-to-refresh; (c) `expo-background-task` (BGTaskScheduler): **o iOS decide quando roda** (mín. ~15 min, frequentemente horas; não roda se o app foi fechado à força; ~30 s de execução). Usar só para sync curto de cabeçalhos, sem chamar LLM em lote. Não testável no Expo Go (precisa dev build).
- Notificação de e-mail novo em tempo real exigiria push (Gmail watch + Pub/Sub + servidor) → fora do escopo standalone.

## 5. Fases

### Fase 0 — Base (1 rodada)
- `src/core/` com db (expo-sqlite + migrações), llm.ts, Ajustes com chaves (SecureStore) e botão "Testar IA".
- Jest (`jest-expo`) para llm/draft_guard/parsers.
- Roda no **Expo Go** (sem Gmail ainda: testar IA e banco com dados de exemplo).
- Leo: colar a chave Gemini/OpenRouter no app.

### Fase 1 — MVP: ler, classificar, kanban (2–3 rodadas)
- `@react-native-google-signin/google-signin` + gmail.ts (list/get/modify, só leitura + marcar lido/arquivar), sync ao abrir + pull-to-refresh.
- copilot.ts (prompts e parse portados) com fila local; kanban/duas colunas da r23 lendo do SQLite.
- Imagens inline e anexos (download para cache, `expo-sharing`).
- **Precisa dev build** → depende da Apple: conta ativa + `eas build --profile development` (ou TestFlight). Leo: client ID iOS no Google Cloud, consentimento, login Google no app, instalar o dev build.

### Fase 2 — Rascunho e envio (1–2 rodadas)
- assistant.draft + draft_guard (alerta_copia), Para/Cc, correção de português, gmail drafts/send (MIME com anexos), outbox com desfazer de alguns segundos + ConfirmModal.
- Testes Jest com Gmail simulado (nenhum envio real em teste).
- Leo: validar envio real para si mesmo.

### Fase 3 — Resto (2+ rodadas)
- Histórico + desfazer, Verificar na caixa, resumos detalhados/por mensagem, resolvido, aprendizado de regras, `expo-background-task`, calendário/contatos opcionais, iPhone (layout estreito já existe).
- Descartar: RAG local do Mac, fs_browser.

## Bloqueios
1. **Gmail OAuth exige development build** → nada de Gmail real antes da conta Apple ativa (até 2 dias úteis) ou de aceitar a licença do Xcode para build local (decisão do Leo).
2. Refresh token de 7 dias se o consentimento ficar em "Testing".
3. Background no iOS é imprevisível: classificação acontece com o app aberto.
4. Cota da IA passa a ser só das chaves do Leo no aparelho (hoje Gemini Flash está sem cota; Flash-Lite e openrouter/free funcionam).

## O que o Leo precisa fazer
- Agora: decidir se mantém o SDK 58 + Expo Go para a Fase 0; colar chaves de IA no app quando a Fase 0 estiver pronta.
- Google Cloud: criar o OAuth client **iOS** (bundle `com.leodlamare.iaemail`), ajustar a tela de consentimento (test user ou produção não verificada), habilitar Gmail API no projeto.
- Apple: após ativação, `eas login`/`init` e `eas build --profile development` (ou TestFlight), instalar no iPad.
