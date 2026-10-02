# IA.Email — app de mesa (Electron)

Não reimplementa nada: só sobe o `docker-compose.yml` da raiz do projeto (o
mesmo backend FastAPI + Gmail) e abre a mesma tela numa janela nativa, em
vez de precisar abrir o navegador em `http://127.0.0.1:8765`.

## Rodar (modo dev)

```bash
cd desktop
npm install   # só na primeira vez
npm start
```

Na primeira execução (ou depois de mudar `app/`/`static/`) ele builda a
imagem Docker, o que demora um pouco mais — as próximas aberturas são
rápidas (`docker compose up -d` sem `--build` reaproveita a imagem).

Fechar a janela **não derruba o servidor** — o container já tem
`restart: unless-stopped` e continua no ar (dá pra acessar pelo navegador
normalmente também). Use **IA.Email → Parar servidor** no menu se quiser
derrubar de verdade.

## Empacotar um app instalável (.dmg)

```bash
cd desktop
npm install
npm run dist
```

Gera o `.dmg`/`.zip` em `desktop/dist/` (testado e confirmado: saem os dois
arquivos de verdade, ~95MB cada). Como o app só faz `docker compose`
apontando pro `..` (a raiz do projeto), o `.dmg` gerado só funciona numa
máquina que já tenha este repositório clonado e o Docker Desktop instalado
— não é um app 100% autocontido, é um atalho nativo pro fluxo Docker que já
existe.

O build não é assinado (sem certificado "Developer ID Application" da
Apple) -- na primeira abertura o macOS vai avisar que o app "não pode ser
aberto" ou "é de um desenvolvedor não identificado". Pra abrir mesmo assim:
clique com o botão direito no app → **Abrir** → **Abrir** de novo na
confirmação (só precisa fazer isso uma vez).
