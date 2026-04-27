// 15code Desktop — preload bridge (最小权限暴露给 renderer)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  saveFile: (data) => ipcRenderer.invoke('save-file', data),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  chatCompletion: (data) => ipcRenderer.invoke('chat-completion', data),
  onUpdateStatus: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },
  onChatStream: (requestId, handler) => {
    const channel = 'chat-stream:' + requestId;
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onMenu: (event, handler) => {
    ipcRenderer.on('menu:' + event, (_e, payload) => handler(payload));
  },
});
