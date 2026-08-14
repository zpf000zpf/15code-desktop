// 15code Desktop — preload bridge (最小权限暴露给 renderer)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  saveFile: (data) => ipcRenderer.invoke('save-file', data),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getSessionToken: () => ipcRenderer.invoke('auth:get-session'),
  setSessionToken: (token) => ipcRenderer.invoke('auth:set-session', token),
  clearSessionToken: () => ipcRenderer.invoke('auth:clear-session'),
  bootstrapAccount: () => ipcRenderer.invoke('account:bootstrap'),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  chatCompletion: (data) => ipcRenderer.invoke('chat-completion', data),
  chatTextCompletion: (data) => ipcRenderer.invoke('chat-text-completion', data),
  imageCapabilities: () => ipcRenderer.invoke('image:capabilities'),
  generateImage: (data) => ipcRenderer.invoke('image:generate', data),
  selectImageForEdit: () => ipcRenderer.invoke('image:select-edit'),
  editImage: (data) => ipcRenderer.invoke('image:edit', data),
  saveGeneratedImage: (data) => ipcRenderer.invoke('image:save', data),
  selectChatImage: (data) => ipcRenderer.invoke('chat-image:select', data),
  generateChatImage: (data) => ipcRenderer.invoke('chat-image:generate', data),
  editChatImage: (data) => ipcRenderer.invoke('chat-image:edit', data),
  saveChatImage: (data) => ipcRenderer.invoke('chat-image:save', data),
  generatePptx: (data) => ipcRenderer.invoke('generate-pptx', data),
  openPptxForAnalysis: () => ipcRenderer.invoke('open-pptx-for-analysis'),
  saveConversation: (data) => ipcRenderer.invoke('conversations:save', data),
  loadConversation: (id) => ipcRenderer.invoke('conversations:load', id),
  listConversations: (options) => ipcRenderer.invoke('conversations:list', options),
  updateConversation: (data) => ipcRenderer.invoke('conversations:update', data),
  onPrepareToQuit: (handler) => {
    const listener = () => { void handler(); };
    ipcRenderer.on('app:prepare-to-quit', listener);
    return () => ipcRenderer.removeListener('app:prepare-to-quit', listener);
  },
  acknowledgeQuitFlush: () => ipcRenderer.invoke('app:quit-flush-ack'),
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
