// 15code Desktop — Electron main process
const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { autoUpdater } = require('electron-updater');

let chatLogPath = null;
let updateReady = false;

function writeChatLog(message) {
  try {
    if (!chatLogPath) chatLogPath = path.join(app.getPath('userData'), 'chat-debug.log');
    fs.appendFileSync(chatLogPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {}
}

const LLM_HOST = 'cli.15code.com';

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function sendUpdateStatus(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('update-status', payload);
  }
}

function setupAutoUpdater() {
  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus({ type: 'checking', message: '正在检查更新...' });
  });
  autoUpdater.on('update-available', (info) => {
    updateReady = false;
    sendUpdateStatus({ type: 'available', version: info.version, message: `发现新版本 v${info.version}，正在下载...` });
  });
  autoUpdater.on('update-not-available', (info) => {
    sendUpdateStatus({ type: 'none', version: info.version, message: '当前已是最新版本' });
  });
  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus({
      type: 'downloading',
      percent: Math.round(progress.percent || 0),
      message: `正在下载更新 ${Math.round(progress.percent || 0)}%`,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    sendUpdateStatus({ type: 'downloaded', version: info.version, message: `v${info.version} 已下载，点击安装重启` });
  });
  autoUpdater.on('error', (err) => {
    sendUpdateStatus({ type: 'error', message: err.message || '检查更新失败' });
  });
}

async function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    const message = '开发模式不检查更新';
    if (manual) sendUpdateStatus({ type: 'none', message });
    return { ok: false, message };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, updateInfo: result?.updateInfo || null };
  } catch (err) {
    sendUpdateStatus({ type: 'error', message: err.message || '检查更新失败' });
    return { ok: false, message: err.message };
  }
}

function sendChatCompletion(event, { requestId, apiKey, model, messages }) {
  return new Promise((resolve, reject) => {
    if (!requestId || !apiKey || !model || !Array.isArray(messages)) {
      reject(new Error('聊天参数不完整，请重新登录后再试'));
      return;
    }

    writeChatLog(`start requestId=${requestId} model=${model} messages=${messages.length} apiKey=${apiKey ? 'set' : 'missing'} mode=stream`);
    const body = JSON.stringify({ model, messages, stream: true });
    let completed = false;
    let contentLength = 0;

    const req = https.request({
      hostname: LLM_HOST,
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + apiKey,
        'User-Agent': `15code-desktop/${app.getVersion()} Electron/${process.versions.electron}`,
      },
    }, (res) => {
      writeChatLog(`response requestId=${requestId} status=${res.statusCode}`);
      let raw = '';
      let buffer = '';

      const processStreamLine = (line) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.message?.content || '';
          // Deliberately ignore reasoning/thinking fields; the app only displays final answer content.
          if (delta) {
            contentLength += delta.length;
            event.sender.send('chat-stream:' + requestId, { type: 'delta', delta });
          }
        } catch (err) {
          writeChatLog(`stream-parse-skip requestId=${requestId} ${err.message}`);
        }
      };

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        lines.forEach(processStreamLine);
      });

      res.on('end', () => {
        completed = true;
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = 'HTTP ' + res.statusCode + ': ' + raw.slice(0, 500);
          writeChatLog(`end-error requestId=${requestId} ${msg}`);
          reject(new Error(msg));
          return;
        }

        if (buffer.trim()) processStreamLine(buffer);

        if (!contentLength) {
          const msg = '服务端返回为空，请换一个模型重试';
          writeChatLog(`empty requestId=${requestId} bytes=${raw.length}`);
          reject(new Error(msg));
          return;
        }

        event.sender.send('chat-stream:' + requestId, { type: 'done' });
        writeChatLog(`end requestId=${requestId} status=${res.statusCode} bytes=${raw.length} content=${contentLength}`);
        resolve({ ok: true, streamed: true, contentLength });
      });
    });

    req.setTimeout(600000, () => {
      if (!completed) writeChatLog(`timeout requestId=${requestId}`);
      req.destroy(new Error('请求超过 10 分钟无响应，请换一个模型或稍后重试'));
    });

    req.on('error', (err) => {
      writeChatLog(`error requestId=${requestId} ${err.message}`);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: '15code',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0a0a0f',
    show: false,
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.show());

  // 外部链接统一用浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 开发模式打开 DevTools
  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools();
  }

  // 菜单
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建对话',
          accelerator: 'CmdOrCtrl+N',
          click: () => win.webContents.send('menu:new-chat'),
        },
        {
          label: '导入文件',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const { canceled, filePaths } = await dialog.showOpenDialog(win, {
              properties: ['openFile'],
              filters: [
                { name: '支持的文件', extensions: ['txt', 'md', 'json', 'csv', 'py', 'js', 'ts', 'go', 'rs', 'java', 'html', 'css', 'log', 'xml', 'yml', 'yaml'] },
              ],
            });
            if (!canceled && filePaths[0]) {
              const content = fs.readFileSync(filePaths[0], 'utf-8');
              const name = path.basename(filePaths[0]);
              win.webContents.send('menu:file-loaded', { name, content });
            }
          },
        },
        {
          label: '导出对话',
          accelerator: 'CmdOrCtrl+S',
          click: () => win.webContents.send('menu:export'),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '15code 主站', click: () => shell.openExternal('https://15code.com') },
        { label: '使用文档', click: () => shell.openExternal('https://15code.com/guide') },
        { label: 'GitHub', click: () => shell.openExternal('https://github.com/zpf000zpf/15code-desktop') },
        { type: 'separator' },
        {
          label: '检查更新',
          click: () => checkForUpdates(true),
        },
        { type: 'separator' },
        {
          label: '关于 15code',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于 15code',
              message: '15code Desktop v' + app.getVersion(),
              detail: '统一接入 Claude / GPT / GLM 的桌面客户端。\n\n官网: https://15code.com',
              buttons: ['确定'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 导出文件（IPC）
ipcMain.handle('save-file', async (_e, { content, defaultName }) => {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: defaultName,
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: '文本', extensions: ['txt'] },
    ],
  });
  if (canceled) return { ok: false };
  fs.writeFileSync(filePath, content, 'utf-8');
  return { ok: true, path: filePath };
});

// 打开外部链接
ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));

ipcMain.handle('get-app-info', () => {
  if (!chatLogPath) chatLogPath = path.join(app.getPath('userData'), 'chat-debug.log');
  return { version: app.getVersion(), chatLogPath };
});

ipcMain.handle('check-for-updates', () => checkForUpdates(true));

ipcMain.handle('install-update', () => {
  if (!updateReady) return { ok: false, message: '更新包尚未下载完成' };
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
});

ipcMain.handle('chat-completion', sendChatCompletion);

app.whenReady().then(() => {
  setupAutoUpdater();
  createWindow();
  setTimeout(() => checkForUpdates(false), 3000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
