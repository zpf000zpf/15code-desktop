// 15code Desktop — preload bridge (最小权限暴露给 renderer)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  saveFile: (data) => ipcRenderer.invoke('save-file', data),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onMenu: (event, handler) => {
    ipcRenderer.on('menu:' + event, (_e, payload) => handler(payload));
  },
});
