# Copiloto no iPad via TestFlight — checklist do Leo

O código já está pronto para build (iPad em retrato e paisagem, ATS restrito,
tela de servidor com "Testar conexão"). O que falta depende de **contas e
acessos seus** — nada disso foi feito automaticamente (sem login, build ou envio).

Ordem sugerida. Marque conforme for fazendo.

## 1. Conta Apple Developer (Individual)

- [ ] Concluir a ativação da conta **Apple Developer Program — Individual** (pagamento
      anual aprovado e e-mail "Welcome to the Apple Developer Program" recebido).
      Até a ativação, o `eas build` não consegue gerar certificado nem perfil.
- [ ] Aceitar os contratos pendentes em <https://developer.apple.com/account> e
      em App Store Connect → **Business/Agreements** (o "Free Apps" basta para TestFlight).

## 2. App Store Connect — criar o app

- [ ] App Store Connect → **Apps → +  → Novo app**:
  - Plataforma: **iOS**
  - Nome: `Copiloto` (se estiver ocupado na loja, ex.: `Copiloto IA.Email`)
  - Idioma principal: Português (Brasil)
  - **Bundle ID**: `com.leodlamare.iaemail` (se não aparecer na lista, registre antes em
    developer.apple.com → Identifiers, ou deixe o `eas build` registrar no passo 4 e volte aqui)
  - **SKU**: qualquer código seu, único, ex.: `iaemail-copiloto-001`
  - Acesso: Acesso total
- [ ] Anotar o **Apple ID numérico do app** (App Information → Apple ID). O `eas submit`
      pergunta; opcionalmente vai em `eas.json` → `submit.production.ios.ascAppId`.

## 3. EAS (Expo) — login e projeto

No Mac, dentro de `mobile/`:

```bash
npx eas-cli@latest login          # sua conta Expo (crie em expo.dev se não tiver)
npx eas-cli@latest init           # cria o projeto no expo.dev e grava extra.eas.projectId no app.json
```

- [ ] `app.json` passou a ter `"extra": { "eas": { "projectId": "…" } }` (e `owner`). Revise o diff.

## 4. Build de produção

```bash
npx eas-cli@latest build -p ios --profile production
```

- [ ] Na primeira vez, o EAS pede login da Apple (Apple ID + 2FA) e oferece gerar
      certificado de distribuição e perfil — aceite ("Let EAS manage").
- [ ] `buildNumber` sobe sozinho a cada build (`autoIncrement` + `appVersionSource: local`):
      o `app.json` muda localmente; mantenha esse diff.
- [ ] `ITSAppUsesNonExemptEncryption: false` já está no `app.json` (só HTTPS padrão do iOS),
      então o TestFlight não pergunta de exportação de criptografia.

## 5. Enviar para o TestFlight

```bash
npx eas-cli@latest submit -p ios --profile production --latest
```

- [ ] Aguardar o processamento no App Store Connect (5–30 min; chega e-mail).
- [ ] App Store Connect → app → **TestFlight → Testadores internos**: criar grupo
      (ex.: "Leo") e adicionar seu Apple ID. Interno não passa por revisão da Apple.
- [ ] No iPad: instalar o app **TestFlight** da App Store e aceitar o convite.

## 6. Servidor acessível do iPad (Tailscale)

O `docker-compose.yml` publica a porta **só em `127.0.0.1:8765`** — de propósito.
O iPad chega no Mac pelo Tailscale, com HTTPS do próprio Tailscale:

- [ ] Instalar o **Tailscale** no Mac e no iPad, mesma conta (mesmo tailnet).
- [ ] No painel do Tailscale (admin console → DNS): **MagicDNS** e **HTTPS Certificates** ligados.
- [ ] No Mac, publicar o servidor só dentro do tailnet:

  ```bash
  tailscale serve --bg 8765          # https://<nome-do-mac>.<tailnet>.ts.net -> http://127.0.0.1:8765
  tailscale serve status             # confere a URL
  ```

  (Não use `tailscale funnel`: ele abre para a internet.)
- [ ] Endereço que vai no app: `https://<nome-do-mac>.<tailnet>.ts.net` (sem porta).

### Por que HTTPS *.ts.net (e o que o ATS permite)

- O app **não** tem mais `NSAllowsArbitraryLoads`. HTTPS com certificado válido sempre funciona.
- `NSExceptionDomains` → `ts.net` (com subdomínios) aceita também `http://…ts.net`,
  caso use MagicDNS sem `tailscale serve` (o tráfego já vai cifrado pelo WireGuard).
- **IP do Tailscale (100.64.0.0/10)**: o ATS não aceita faixa de IP como exceção.
  Ficou `NSAllowsLocalNetworking: true` (rede local/IP literal); na prática o iOS costuma
  liberar `http://100.x.y.z`, mas a Apple não garante isso para IPs fora da LAN — e, com a
  porta presa em `127.0.0.1`, esse caminho nem alcança o servidor sem mudar o compose.
  **Use o `https://…ts.net`.**

## 7. Token e acesso remoto

- [ ] No `.env` da **raiz do repo** (no Mac, não no container), deixar
      `IA_EMAIL_AUTH_LOCALHOST_LIVRE=false` antes de usar o túnel. Depois: `./start.sh`
      (o container só lê o `.env` ao ser recriado).
- [ ] O token é a chave `IA_EMAIL_API_TOKEN` desse mesmo `.env` (gerado pelo `./start.sh`).
      Para ver o valor (só no seu terminal): `.venv/bin/python -m app.auth --mostrar`.
      Para trocar: `--rotacionar` + `./start.sh` (e cole o novo no iPad).
- [ ] No navegador do Mac, com `false`, o `/login` pede o token uma vez (cookie de 90 dias).

## 8. Configurar o app no iPad

- [ ] Abrir o Copiloto → **⚙ Ajustes → Servidor**:
  - Endereço: `https://<nome-do-mac>.<tailnet>.ts.net`
  - Token de acesso: colar o `IA_EMAIL_API_TOKEN` (fica no Keychain do iPad)
  - Tocar **Salvar e testar conexão**. Esperado:
    - ✓ Servidor respondeu … (/api/health)
    - ✓ Acesso autorizado com o token salvo
    - ✓ Conta do Gmail: …
- [ ] Se aparecer "O servidor recusou o token salvo": token errado/rotacionado.
      "Sem conexão com …": Tailscale desligado no iPad/Mac ou `tailscale serve` parado.

## 9. Conferência rápida no iPad (sem enviar e-mail)

- [ ] Paisagem: lista à esquerda, detalhe à direita; retrato estreito/Split View: lista → detalhe.
- [ ] Detalhe: 📑 Resumo detalhado, 🔎 Verificar na caixa, conversa completa com imagens inline
      e anexos (tocar abre a folha do iOS para ver/salvar em Arquivos).
- [ ] Responder: Para/Cc editáveis, chips "+ Cc". **Não toque em "Enviar agora"** num teste.
- [ ] 🕘 Histórico: Desfazer/Refazer de uma ação simples (ex.: Resolvido → Desfazer).
