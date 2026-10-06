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
├── app.json                   # nome, bundle id, ATS liberado para http local
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

O endereço fica salvo no aparelho e pode ser trocado em **⚙ Ajustes → Servidor → Testar e salvar**.
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
(trocando para `"8765:8765"` ou `"0.0.0.0:8765:8765"`) **conscientemente**: a API não tem
login próprio e passa a ficar acessível para qualquer um na mesma rede. Use só em rede confiável
e volte ao `127.0.0.1` depois. (Esta rodada não alterou o `docker-compose.yml`.)

O botão **Abrir rascunho / Abrir e-mail** abre `/<rota>` do servidor no navegador do aparelho,
então vale a mesma regra de alcance.

## Verificações

```bash
npx tsc --noEmit        # typecheck
npx expo-doctor         # dependências e config
npx expo export --platform ios --platform android --output-dir /tmp/copiloto-export   # garante que o bundle compila
```

## Fora do escopo da v1

- Publicação na App Store / Play Store (dá para seguir depois com `npx eas-cli@latest build`).
- Notificação push do digest (o servidor ainda só monta o resumo).
- Envio de e-mail pelo app (proposital: o envio continua na tela de e-mail).
