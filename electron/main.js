'use strict';
const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const path = require('path');
const { createServer, listen } = require('../server');

let win = null;

async function pickFolder(prompt, defaultPath) {
  const r = await dialog.showOpenDialog(win, {
    title: prompt,
    message: prompt,
    defaultPath: defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
}

async function createWindow(port) {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0c0c0c',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(`http://127.0.0.1:${port}/?shell=electron`);
}

app.whenReady().then(async () => {
  const server = createServer({ shell: 'electron', pickFolder });
  serverRef = server;
  const port = await listen(server, 0);

  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'togglefullscreen' }, { role: 'reload' }, { role: 'toggleDevTools' }],
      },
      { role: 'windowMenu' },
    ])
  );

  await createWindow(port);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

let serverRef = null;
app.on('will-quit', () => serverRef && serverRef.purgeDeletes());
app.on('window-all-closed', () => app.quit());
