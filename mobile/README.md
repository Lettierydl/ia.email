# Copiloto — app mobile (iOS + Android)

App React Native (Expo SDK 57, TypeScript) com o mesmo Copiloto do `/copilot` web:
o que precisa de você, em 3 camadas — **seu papel**, **o que aconteceu** e **o que eu faria** (com o porquê).

Nada no app envia e-mail. Assumir / Cobrar / Delegar / Aplicar só mudam o estado do item ou
preparam rascunho no servidor; o envio continua sendo feito por você na tela de e-mail
(o botão **Abrir rascunho** abre essa tela do servidor no navegador do aparelho).

## O que tem na v1

- **Home**: data, saudação, cartões **Hoje** e **Aguardando outras pessoas**, botão ⟳ (pede leitura da IA em lote, com progresso) e ⚙ (ajustes).
- **Abas**: Precisa de você · Aguardando outras pessoas · Só conhecimento (com contagem; "Resolvido" saiu do quadro: resolver marca lido no Gmail e volta para a lista), lista de cards com faixa de urgência, chips (papel, urgência, prazo, status, "sem resposta há…") e avatar de quem está com o próximo passo. Puxe para baixo para atualizar.
- **Detalhe**: 1 Seu papel · 2 O que aconteceu · 3 O que eu faria (opções com confiança, **Aplicar** e **Por quê?** com as evidências), "Preciso de contexto", tarefas, fatos e histórico.
- **Ações** (barra fixa): **Assumir**, **Cobrar** (só quando está aguardando outras pessoas), **Delegar**, **Resolvido / Reabrir**.
- **Delegar** em 2 modos: *às claras* (rascunho na própria thread com Cc de quem já está nela) ou *e-mail novo silencioso* (só para a pessoa). Sugestão de nomes via `/api/settings/alias-suggest`.
- **Ajustes**: endereço do servidor (salvo no aparelho), skin **Clean pastel** ou **Caderno**, horários do resumo diário/semanal e prévia do **digest**.

## Estrutura

```
mobile/
├── App.tsx                    # providers + navegação (pilha simples, BackHandler no Android)
├── app.json                   # nome, bundle id (com.leodlamare.iaemail), iPad retrato+paisagem, ATS restrito (HTTPS; http só *.ts.net/rede local)
├── TESTFLIGHT.md              # checklist do que depende do Leo para chegar ao iPad
├── eas.json                   # perfis EAS: development / preview / production
└── src/
    ├── api.ts                 # cliente HTTP + base URL configurável
    ├── types.ts               # contrato de /api/copilot (espelha app/copilot.py)
    ├── labels.ts              # rótulos pt-BR e formatação de datas
    ├── theme.ts               # skins clean / caderno (mesma paleta do static/copilot.css)
    ├── components/
    │   ├── ui.tsx             # T, Chip, Avatar, Btn, Block, Sheet, Toast
    │   └── DelegateSheet.tsx  # folha de Delegar (2 modos)
    └── screens/
        ├── HomeScreen.tsx
        ├── DetailScreen.tsx
        └── SettingsScreen.tsx
```

## Endpoints usados

| Método | Rota | Uso |
|---|---|---|
| GET | `/api/copilot` | home: saudação, cartões, abas, itens, job |
| GET | `/api/copilot/status` | progresso da leitura em lote |
| POST | `/api/copilot/run?limit=12` | pede leitura da IA dos e-mails novos |
| GET | `/api/copilot/{id}` (`?refresh=1` relê com IA) | detalhe |
| POST | `/api/copilot/{id}/action` | `assumir`, `cobrar`, `delegar` (`para`, `modo`, `nome`, `nota`), `aplicar` (`opcao`), `resolver`, `reabrir`, `tarefa` (`index`, `feita`) |
| GET | `/api/copilot/digest?period=daily\|weekly` | prévia do resumo |
| GET/POST | `/api/copilot/settings` | skin e horários do digest |
| GET | `/api/settings/alias-suggest?q=` | sugestões no Delegar |
| GET | `/api/avatar?email=` | foto do avatar |
| GET | `/api/health` | "Testar conexão" (sem token) |
| GET | `/api/status` | "Testar conexão" (rota autenticada) e conta de envio |
| GET | `/api/threads/{id}/recipients` | Para/Cc padrão (`reply_to`/`reply_cc`) e participantes no Responder |
| POST | `/api/threads/{id}/send` | envio (só após o ConfirmModal), com `to` e `cc` editados |
| GET/POST | `/api/copilot/{id}/verificar` | Verificar na caixa (GET = cache; POST = gera) |
| GET/POST | `/api/copilot/{id}/resumo-detalhado` | Resumo detalhado (POST = regerar) |
| POST | `/api/copilot/{id}/mensagens/{idx}/resumo` | Resumir uma mensagem (direto/abrangente) |
| GET | `/api/historico` · POST `/api/historico/{id}/desfazer` · `/refazer` · `/desfazer-ultimo` | 🕘 Histórico |
| GET | `/api/threads/{id}/gmail-attachments` (+ `/{mid}/image?attachment_id=`, `/{mid}/file?attachment_id=`) | imagens inline (campo `inline`) e anexos |

## Pré-requisitos

- Node 20+ (testado com Node 25 / npm 11).
- Servidor IA.Email rodando (`./start.sh` na raiz do repo) em `http://127.0.0.1:8765`.
- Para simulador iOS: Xcode instalado **e licença aceita** (`sudo xcodebuild -license accept`; sem isso o Expo mostra `Unable to run simctl … code 69`).
- Para emulador Android: Android Studio com um AVD criado.
- Para celular físico: app **Expo Go** (App Store / Play Store) compatível com SDK 57.

## Rodar

```bash
cd mobile
npm install
npx expo start          # abre o Metro; depois tecle i (iOS), a (Android) ou leia o QR no Expo Go
# atalhos:
npm run ios             # simulador iOS
npm run android         # emulador Android
```

## Endereço do servidor (base URL)

O endereço fica salvo no aparelho e pode ser trocado em **⚙ Ajustes → Servidor → Salvar e testar conexão** (testa `/api/health` e uma rota autenticada e mostra o resultado na tela).
Padrão sem nada salvo:

| Onde o app roda | Endereço | Observação |
|---|---|---|
| Simulador iOS | `http://127.0.0.1:8765` | funciona direto |
| Emulador Android | `http://10.0.2.2:8765` | 10.0.2.2 é o Mac visto de dentro do emulador |
| Celular físico (Expo Go) | `http://<IP-do-Mac>:8765` | mesma rede Wi-Fi; veja o IP com `ipconfig getifaddr en0` |

Também dá para fixar o padrão por variável de ambiente ao subir o Metro:

```bash
EXPO_PUBLIC_API_URL=http://192.168.0.10:8765 npx expo start
```

**Atenção — celular físico:** o `docker-compose.yml` publica a porta só em `127.0.0.1:8765`,
então o celular não alcança o servidor. Para testar no aparelho, publique na rede local
(trocando para `"8765:8765"` ou `"0.0.0.0:8765:8765"`) **conscientemente** e de preferência
via túnel (Tailscale/cloudflared) em vez de abrir a porta na rede. Fora do Mac a API exige o
token de acesso (abaixo), mas o tráfego em `http://` vai sem criptografia: use rede confiável.
(O `docker-compose.yml` continua em `127.0.0.1`.)

O botão **Abrir rascunho / Abrir e-mail** abre `/<rota>` do servidor no navegador do aparelho,
então vale a mesma regra de alcance (e o navegador pede o token uma vez na tela `/login`).

## Token de acesso

A API do IA.Email exige `IA_EMAIL_API_TOKEN` para quem não está no próprio Mac.

1. No Mac: `.venv/bin/python -m app.auth --mostrar` (na raiz do repo).
2. No app: **Ajustes → Servidor → Token de acesso**, cole e toque **Salvar e testar conexão**.

O token fica no Keychain (iOS) / Keystore (Android) via `expo-secure-store` e vai em todo request
como `Authorization: Bearer …` (avatares servidos pelo IA.Email também). Resposta 401 aparece como
"Token inválido ou ausente. Confira em Ajustes.". Salvar o campo vazio apaga o token do aparelho.

## Build (EAS) — iPad / TestFlight

Passo a passo do que depende de você (conta Apple, App Store Connect, EAS, Tailscale, token): **[TESTFLIGHT.md](TESTFLIGHT.md)**.

- Layout: largura ≥ 768 (iPad) = duas colunas (lista + detalhe); menor = lista → detalhe.

- Bundle id iOS e package Android: `com.leodlamare.iaemail`. `ios.buildNumber` / `android.versionCode`
  começam em 1; `cli.appVersionSource: "local"` + `autoIncrement` no perfil `production` sobe esses
  números no `app.json` a cada build.
- Perfis (`eas.json`):
  - `development`: `developmentClient: true`, distribuição interna. **Precisa do `expo-dev-client`**
    (não instalado de propósito): `npx expo install expo-dev-client` antes de usar esse perfil.
    Para testar sem ele, use o Expo Go ou o perfil `preview`.
  - `preview`: build interno (ad hoc no iOS: o iPad precisa estar registrado com `eas device:create`).
  - `production`: para App Store/TestFlight.
- `submit.production.ios` está vazio (placeholder): preencha `appleId`, `ascAppId` (só dígitos, do
  App Store Connect) e `appleTeamId` quando o app existir lá.
- Fluxo (feito pelo Leo, com login dele): `eas login` → `eas build -p ios --profile production` →
  `eas submit -p ios --profile production`.

## Verificações

```bash
npx tsc --noEmit        # typecheck
npx expo-doctor         # dependências e config
npx expo export --platform ios --platform android --output-dir /tmp/copiloto-export   # garante que o bundle compila
```

## Fora do escopo da v1

- Publicação na App Store / Play Store (preparada no `eas.json`; o build/submit não foi rodado).
- Notificação push do digest (o servidor ainda só monta o resumo).
- Envio de e-mail pelo app (proposital: o envio continua na tela de e-mail).
