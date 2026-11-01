import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveExecutable } from '@wots/core';
import { ensureRunner, type RunnerClient } from '@wots/runner/client';

// The renderer can reach only these runner methods. Lifecycle and settings changes that
// could alter billing paths are deliberately absent (they go through `wots` or Settings → explicit confirm).
const ALLOWED_METHODS = new Set([
  'runner.status',
  'connections.list',
  'models.list',
  'projects.list',
  'projects.register',
  'sessions.create',
  'sessions.list',
  'sessions.get',
  'messages.send',
  'runs.interrupt',
  'runs.resume',
  'approvals.decide',
  'events.list',
  'events.subscribe',
  'events.unsubscribe',
  'fallback.get',
  'settings.setChatConsent',
  'export',
]);

let win: BrowserWindow | null = null;
let runner: RunnerClient | null = null;
let connecting: Promise<RunnerClient> | null = null;

function send(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

declare const __RUNNER_MAIN__: string;

// Apps launched from Finder get a minimal PATH; use the login shell's so the official
// `claude` and `codex` executables resolve exactly as they do in Terminal.
function loginShellEnv(): NodeJS.ProcessEnv {
  try {
    const shellPath = process.env.SHELL ?? '/bin/zsh';
    const out = execFileSync(shellPath, ['-ilc', 'printf "%s" "$PATH"'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return { ...process.env, PATH: out.trim() || process.env.PATH };
  } catch {
    return process.env;
  }
}

async function connectRunner(): Promise<RunnerClient> {
  if (runner) return runner;
  const env = loginShellEnv();
  const node = resolveExecutable('node', env);
  if (!node) throw new Error('Node.js 26+ is required to run the WotsRelay runner (not found on PATH).');
  connecting ??= ensureRunner({ start: true, command: { exec: node, args: [__RUNNER_MAIN__], env } })
    .then((cl) => {
      runner = cl;
      cl.onEvent((e) => send('wots:event', e));
      cl.onClose(() => {
        runner = null;
        send('wots:runner', { online: false });
      });
      send('wots:runner', { online: true });
      return cl;
    })
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 760,
    minHeight: 560,
    title: 'WotsRelay',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141C2C' : '#EDF0F3',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  win.once('ready-to-show', () => win?.show());
  // No in-app navigation away from the bundled UI; https links open in the browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  void win.loadFile(join(__dirname, 'renderer', 'index.html'));
  // Development aid: WOTS_CAPTURE=/path.png saves a screenshot of the rendered window and quits.
  const capture = process.env.WOTS_CAPTURE;
  if (capture) {
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        if (process.env.WOTS_CAPTURE_THEME) {
          await win!.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(process.env.WOTS_CAPTURE_THEME)})`);
          await new Promise((r) => setTimeout(r, 400));
        }
        const img = await win!.webContents.capturePage();
        writeFileSync(capture, img.toPNG());
        app.quit();
      }, Number(process.env.WOTS_CAPTURE_DELAY ?? 3000)),
    );
  }
  // Closing the window never stops work: the runner is a separate process.
  win.on('closed', () => (win = null));
}

ipcMain.handle('wots:call', async (event, method: unknown, params: unknown) => {
  if (event.senderFrame?.url && !event.senderFrame.url.startsWith('file://')) throw new Error('Untrusted sender');
  if (typeof method !== 'string' || !ALLOWED_METHODS.has(method)) throw new Error(`Method not allowed: ${String(method)}`);
  const cl = await connectRunner();
  try {
    return { ok: true, result: await cl.call(method, params ?? {}) };
  } catch (e) {
    return { ok: false, error: { code: (e as { code?: string }).code ?? 'error', message: (e as Error).message } };
  }
});

ipcMain.handle('wots:pickProject', async () => {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], message: 'Choose a project folder to trust for coding tasks' });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});

ipcMain.handle('wots:reconnect', async () => {
  try {
    await connectRunner();
    return true;
  } catch {
    return false;
  }
});

app.whenReady().then(async () => {
  // Strict CSP for everything the renderer loads; no remote content.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"] } });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]),
  );
  createWindow();
  connectRunner().catch((e: Error) => send('wots:runner', { online: false, error: e.message }));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quitting the app leaves the runner and any live task running (it is independent).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (ev) => ev.preventDefault());
});
