// 15code Desktop — Electron main process
const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
