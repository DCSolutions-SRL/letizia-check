const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
require('dotenv').config();

let mainWindow;
let botController;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  const BotController = require('../bot/controller');
  botController = new BotController({ sendToRenderer: sendToRenderer });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function sendToRenderer(channel, payload) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send(channel, payload);
  }
}

// IPC handlers
ipcMain.handle('select-capture-dir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled) return null;
  const dir = res.filePaths[0];
  botController.setCaptureDir(dir);
  return dir;
});

ipcMain.handle('bot-init', async (_e, { headless }) => {
  await botController.init({ headless });
  return true;
});

ipcMain.handle('bot-start-schedule', async () => {
  botController.startSchedule();
  return true;
});

ipcMain.handle('bot-stop-schedule', async () => {
  botController.stopSchedule();
  return true;
});

ipcMain.handle('bot-run-once', async () => {
  await botController.runScenarioOnce();
  return true;
});
