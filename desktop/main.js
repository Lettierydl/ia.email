// App de mesa (Electron) pro IA.Email -- não reimplementa nada: só sobe o
// mesmo docker-compose.yml do projeto (backend FastAPI + Gmail) e mostra a
// mesma tela numa janela nativa, em vez de precisar abrir o navegador.
// Fechar a janela NÃO derruba o servidor -- o container já tem
// restart:unless-stopped e continua rodando pro caso do Leo acessar via
// browser também; "Parar servidor" no menu faz isso explicitamente.

const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const PROJECT_ROOT = path.join(__dirname, "..");
const APP_URL = "http://127.0.0.1:8765";
const HEALTH_URL = `${APP_URL}/api/status`;

let mainWindow = null;

function runDockerCompose(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", ...args], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker compose ${args.join(" ")} saiu com código ${code}`));
    });
  });
}

function waitForServer(timeoutMs = 90000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(HEALTH_URL, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve();
        } else {
          retry();
        }
      });
      req.on("error", retry);
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error("Servidor não respondeu a tempo (docker demorou demais pra subir)."));
        return;
      }
      setTimeout(tick, 1000);
    };
    tick();
  });
}

function loadingHtml(message) {
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html>
      <html><head><meta charset="utf-8"><style>
        body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
               background:#f6f8fb; font:14px -apple-system,system-ui,sans-serif; color:#444; }
        .box { text-align:center; }
        .spinner { width:28px; height:28px; margin:0 auto 12px; border:3px solid #dde3ee;
                   border-top-color:#1a73e8; border-radius:50%; animation:spin .8s linear infinite; }
        @keyframes spin { to { transform:rotate(360deg); } }
      </style></head>
      <body><div class="box"><div class="spinner"></div><div>${message}</div></div></body></html>`)
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: "IA.Email",
    show: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  return mainWindow;
}

async function boot() {
  const win = createWindow();
  win.loadURL(loadingHtml("Subindo o IA.Email (docker compose)…"));

  try {
    await runDockerCompose(["up", "-d", "--build"]);
    win.loadURL(loadingHtml("Aguardando o servidor responder…"));
    await waitForServer();
    if (win.isDestroyed()) return;
    win.loadURL(APP_URL);
  } catch (err) {
    if (win.isDestroyed()) return;
    win.loadURL(loadingHtml(`Falha ao subir o servidor: ${String(err.message || err)}`));
    dialog.showErrorBox(
      "IA.Email não conseguiu subir",
      `${err.message || err}\n\nVerifique se o Docker Desktop está aberto e tente "Recarregar" no menu.`
    );
  }
}

function buildMenu() {
  const template = [
    {
      label: "IA.Email",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Recarregar",
          accelerator: "CmdOrCtrl+R",
          click: () => boot(),
        },
        {
          label: "Parar servidor",
          click: async () => {
            try {
              await runDockerCompose(["down"]);
              dialog.showMessageBox({ message: "Servidor parado (docker compose down)." });
            } catch (err) {
              dialog.showErrorBox("Falha ao parar", String(err.message || err));
            }
          },
        },
        {
          label: "Abrir no navegador",
          click: () => shell.openExternal(APP_URL),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  boot();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) boot();
  });
});

app.on("window-all-closed", () => {
  // Fechar a janela não derruba o backend (docker fica com
  // restart:unless-stopped) -- só sai do app de mesa mesmo.
  if (process.platform !== "darwin") app.quit();
});
