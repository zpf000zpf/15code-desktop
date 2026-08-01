// 15code Desktop — Electron main process
const { app, BrowserWindow, Menu, shell, dialog, ipcMain, safeStorage } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const https = require('https');
const { autoUpdater } = require('electron-updater');
const PptxGenJS = require('pptxgenjs');
const JSZip = require('jszip');
const { DatabaseSync } = require('node:sqlite');

let chatLogPath = null;
let updateReady = false;
let catalogUpdateUrl = null;
let volatileSessionToken = null;
let volatileApiKey = null;
let chatDatabase = null;

function getSessionFilePath() {
  return path.join(app.getPath('userData'), 'session-token.bin');
}

function getApiKeyFilePath() {
  return path.join(app.getPath('userData'), 'api-key.bin');
}

function saveApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 16384) {
    throw new Error('API Key 格式无效');
  }
  volatileApiKey = apiKey;
  if (!safeStorage.isEncryptionAvailable()) return { ok: true, persisted: false };
  const encrypted = safeStorage.encryptString(apiKey);
  const target = getApiKeyFilePath();
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
  return { ok: true, persisted: true };
}

function loadApiKey() {
  if (volatileApiKey) return volatileApiKey;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    volatileApiKey = safeStorage.decryptString(fs.readFileSync(getApiKeyFilePath()));
    return volatileApiKey;
  } catch {
    return null;
  }
}

function clearApiKey() {
  volatileApiKey = null;
  try { fs.rmSync(getApiKeyFilePath(), { force: true }); } catch {}
}

function saveSessionToken(token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 16384) {
    throw new Error('登录凭证格式无效');
  }
  volatileSessionToken = token;
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: true, persisted: false };
  }
  const encrypted = safeStorage.encryptString(token);
  const sessionFile = getSessionFilePath();
  const temporaryFile = sessionFile + '.tmp';
  fs.writeFileSync(temporaryFile, encrypted, { mode: 0o600 });
  fs.renameSync(temporaryFile, sessionFile);
  fs.chmodSync(sessionFile, 0o600);
  return { ok: true, persisted: true };
}

function loadSessionToken() {
  if (volatileSessionToken) return volatileSessionToken;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const encrypted = fs.readFileSync(getSessionFilePath());
    volatileSessionToken = safeStorage.decryptString(encrypted);
    return volatileSessionToken;
  } catch {
    return null;
  }
}

function clearSessionToken() {
  volatileSessionToken = null;
  try {
    fs.rmSync(getSessionFilePath(), { force: true });
  } catch {}
  clearApiKey();
  return { ok: true };
}

async function platformJson(route, options = {}) {
  const token = loadSessionToken();
  if (!token) throw new Error('登录已失效，请重新登录');
  const response = await fetch('https://15code.com' + route, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!response.ok) {
    const error = new Error(data.error || data.detail || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function bootstrapAccount() {
  const me = await platformJson('/api/me');
  const tokenResult = await platformJson('/api/tokens');
  let active = (tokenResult.tokens || []).find(token => token.status === 'active' && token.go_key);
  let apiKey = active?.go_key || '';
  if (!apiKey) {
    const created = await platformJson('/api/tokens', {
      method: 'POST',
      body: JSON.stringify({ name: '15code Desktop', withGoKey: true }),
    });
    apiKey = created.goKey || '';
  }
  if (!apiKey) throw new Error('未找到可用 API Key');
  saveApiKey(apiKey);
  return { user: me.user || null };
}

function getChatDatabase() {
  if (chatDatabase) return chatDatabase;
  chatDatabase = new DatabaseSync(path.join(app.getPath('userData'), 'chat-history.sqlite'));
  chatDatabase.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT, draft TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_active ON conversations(deleted, pinned, updated_at);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
  `);
  return chatDatabase;
}

function saveConversation({ id, title, model, draft = '', messages = [] }) {
  if (!id || !Array.isArray(messages)) throw new Error('会话数据无效');
  const db = getChatDatabase();
  const now = Date.now();
  const existing = db.prepare('SELECT created_at, pinned, deleted FROM conversations WHERE id = ?').get(id);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT OR REPLACE INTO conversations
      (id,title,model,draft,pinned,deleted,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, String(title || '新对话').slice(0, 120), String(model || ''), String(draft || ''),
        existing?.pinned || 0, existing?.deleted || 0, existing?.created_at || now, now);
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    const insert = db.prepare('INSERT INTO messages(conversation_id,role,content,created_at) VALUES (?,?,?,?)');
    messages.slice(-200).forEach((message, index) => {
      if (message && ['user', 'assistant'].includes(message.role)) {
        insert.run(id, message.role, String(message.content || ''), now + index);
      }
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok: true };
}

function loadConversation(id) {
  const db = getChatDatabase();
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!conversation) return null;
  const messages = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id').all(id);
  return { ...conversation, messages };
}

function listConversations({ query = '', deleted = false } = {}) {
  const db = getChatDatabase();
  const like = `%${String(query).slice(0, 100)}%`;
  return db.prepare(`SELECT id,title,model,draft,pinned,deleted,created_at,updated_at
    FROM conversations WHERE deleted = ? AND title LIKE ? ORDER BY pinned DESC, updated_at DESC LIMIT 200`)
    .all(deleted ? 1 : 0, like);
}

function updateConversation({ id, title, pinned, deleted, draft }) {
  const db = getChatDatabase();
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!row) throw new Error('会话不存在');
  db.prepare(`UPDATE conversations SET title=?, pinned=?, deleted=?, draft=?, updated_at=? WHERE id=?`)
    .run(title === undefined ? row.title : String(title).slice(0, 120),
      pinned === undefined ? row.pinned : (pinned ? 1 : 0),
      deleted === undefined ? row.deleted : (deleted ? 1 : 0),
      draft === undefined ? row.draft : String(draft), Date.now(), id);
  return { ok: true };
}

function normalizeExternalUrl(rawUrl) {
  const parsed = new URL(String(rawUrl || ''));
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('只允许打开安全的 HTTPS 链接');
  }
  return parsed.toString();
}

async function openExternalUrl(rawUrl) {
  return shell.openExternal(normalizeExternalUrl(rawUrl));
}

function writeChatLog(message) {
  try {
    if (!chatLogPath) chatLogPath = path.join(app.getPath('userData'), 'chat-debug.log');
    fs.appendFileSync(chatLogPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {}
}

const LLM_HOST = 'cli.15code.com';
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_PPTX_ANALYZE_BYTES = 30 * 1024 * 1024;
const SUPPORTED_IMPORT_FILTER = {
  name: '支持的文件',
  extensions: ['txt', 'md', 'json', 'csv', 'py', 'js', 'ts', 'go', 'rs', 'java', 'html', 'css', 'log', 'xml', 'yml', 'yaml', 'sh', 'sql', 'c', 'cpp', 'h'],
};
const PPTX_FILTER = { name: 'PowerPoint', extensions: ['pptx'] };

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
    const catalogResponse = await fetch('https://15code.com/api/catalog', { headers: { Accept: 'application/json' } });
    if (catalogResponse.ok) {
      const catalog = await catalogResponse.json();
      const desktop = catalog.releases?.desktop || {};
      const release = desktop.beta || desktop.stable;
      if (release?.version) {
        const newer = compareVersions(release.version, app.getVersion()) > 0;
        const mandatory = (release.forceUpgradeBelow && compareVersions(app.getVersion(), release.forceUpgradeBelow) < 0)
          || (release.minimumSupportedVersion && compareVersions(app.getVersion(), release.minimumSupportedVersion) < 0);
        if (newer || mandatory) {
          catalogUpdateUrl = new URL(release.downloadUrl, 'https://15code.com').toString();
          sendUpdateStatus({ type: 'catalog-available', version: release.version, mandatory,
            message: mandatory ? '当前版本已停止支持，请立即升级' : `发现 Catalog 新版 v${release.version}` });
          return { ok: true, catalog: true, release, mandatory };
        }
      }
    }
    const result = await autoUpdater.checkForUpdates();
    return { ok: true, updateInfo: result?.updateInfo || null };
  } catch (err) {
    sendUpdateStatus({ type: 'error', message: err.message || '检查更新失败' });
    return { ok: false, message: err.message };
  }
}

function compareVersions(left, right) {
  const a = String(left || '').replace(/^v/i, '').split('.').map(x => parseInt(x, 10) || 0);
  const b = String(right || '').replace(/^v/i, '').split('.').map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1;
  }
  return 0;
}

function sendChatCompletion(event, { requestId, model, messages }) {
  return new Promise((resolve, reject) => {
    const apiKey = loadApiKey();
    if (!requestId || !apiKey || !model || !Array.isArray(messages)) {
      reject(new Error('聊天参数不完整，请重新登录后再试'));
      return;
    }

    writeChatLog(`start requestId=${requestId} model=${model} messages=${messages.length} credential=secure-storage mode=stream`);
    const body = JSON.stringify({ model, messages, stream: true, max_tokens: 4096 });
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

function sendChatTextCompletion(_event, { model, messages, maxTokens = 3000 }) {
  return new Promise((resolve, reject) => {
    const apiKey = loadApiKey();
    if (!apiKey || !model || !Array.isArray(messages)) {
      reject(new Error('AI 参数不完整，请重新登录后再试'));
      return;
    }

    const body = JSON.stringify({ model, messages, stream: false, max_tokens: maxTokens });
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
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('HTTP ' + res.statusCode + ': ' + raw.slice(0, 500)));
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          const content = parsed.choices?.[0]?.message?.content || '';
          resolve({ ok: true, content, usage: parsed.usage || null });
        } catch (err) {
          reject(new Error('AI 响应解析失败: ' + err.message));
        }
      });
    });

    req.setTimeout(600000, () => req.destroy(new Error('请求超过 10 分钟无响应')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function normalizeSlides(slides, topic) {
  const list = Array.isArray(slides) ? slides : [];
  const clean = list.map((slide, index) => ({
    title: String(slide.title || `第 ${index + 1} 页`).trim(),
    subtitle: String(slide.subtitle || '').trim(),
    bullets: Array.isArray(slide.bullets) ? slide.bullets.map(x => String(x).trim()).filter(Boolean).slice(0, 5) : [],
    notes: String(slide.notes || '').trim(),
    visualType: String(slide.visualType || 'content').trim(),
  })).filter(s => s.title || s.bullets.length);

  if (clean.length) return clean;
  return [
    { title: topic || '15code PPT Studio', subtitle: 'AI 生成演示文稿', bullets: [], notes: '', visualType: 'cover' },
    { title: '核心观点', subtitle: '', bullets: ['明确演示目标', '组织关键信息', '形成可交付 PPTX'], notes: '', visualType: 'content' },
    { title: '下一步行动', subtitle: '', bullets: ['补充资料', '确认风格', '导出并人工校对'], notes: '', visualType: 'closing' },
  ];
}

function normalizeSlideImages(images) {
  if (!images || typeof images !== 'object') return {};
  const out = {};
  Object.entries(images).forEach(([key, value]) => {
    const index = Number(key);
    const dataUrl = typeof value === 'string' ? value : value?.dataUrl;
    if (!Number.isInteger(index) || index < 0 || typeof dataUrl !== 'string') return;
    if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(dataUrl)) return;
    out[index] = dataUrl;
  });
  return out;
}

function addSlideNumber(slide, pageNo, total) {
  slide.addText(`${pageNo}/${total}`, {
    x: 12.0, y: 7.05, w: 0.8, h: 0.18,
    fontSize: 8, color: '8A91A7', align: 'right',
  });
}

function addTopRule(slide, color) {
  slide.addShape('rect', { x: 0, y: 0, w: 13.333, h: 0.08, color });
}

function addDeckHeader(slide, item, palette, style) {
  slide.addText(item.title, { x: 0.62, y: 0.46, w: 8.4, h: 0.42, fontSize: 21, bold: true, color: palette.text, fit: 'shrink' });
  if (item.subtitle) {
    slide.addText(item.subtitle, { x: 0.65, y: 0.93, w: 8.8, h: 0.24, fontSize: 10, color: palette.muted, fit: 'shrink' });
  }
  slide.addShape('rect', { x: 0.62, y: 1.22, w: 0.66, h: 0.06, color: palette.primary });
  slide.addShape('rect', { x: 1.34, y: 1.22, w: 0.28, h: 0.06, color: palette.accent });
  if (style !== 'tech') {
    slide.addShape('rect', { x: 10.7, y: 0.48, w: 1.95, h: 0.26, color: 'EEF2FF', line: { color: 'DBEAFE', transparency: 20 }, radius: 0.08 });
    slide.addText('15code PPT Studio', { x: 10.82, y: 0.535, w: 1.7, h: 0.12, fontSize: 7.5, bold: true, color: palette.primary, align: 'center' });
  }
}

function addBulletCards(slide, bullets, palette, style, x = 0.72, y = 1.55, w = 7.75) {
  const list = bullets.length ? bullets : ['补充关键论据', '完善页面细节'];
  list.slice(0, 5).forEach((bullet, i) => {
    const top = y + i * 0.78;
    slide.addShape('rect', {
      x, y: top, w, h: 0.52,
      color: style === 'tech' ? '10243A' : 'FFFFFF',
      line: { color: style === 'tech' ? '1E3A5F' : 'E5E7EB', transparency: 12 },
      radius: 0.08,
    });
    slide.addShape('rect', { x: x + 0.16, y: top + 0.13, w: 0.08, h: 0.26, color: i % 2 ? palette.accent : palette.primary, radius: 0.03 });
    slide.addText(bullet, { x: x + 0.36, y: top + 0.08, w: w - 0.6, h: 0.32, fontSize: 13.2, color: palette.text, fit: 'shrink' });
  });
}

function addImageOrVisual(slide, imageData, item, palette, style) {
  slide.addShape('rect', { x: 9.08, y: 1.36, w: 3.55, h: 5.24, color: style === 'tech' ? '0B253F' : 'F1F5F9', line: { color: style === 'tech' ? '155E75' : 'DCE7F7' }, radius: 0.12 });
  if (imageData) {
    slide.addImage({ data: imageData, x: 9.28, y: 1.62, w: 3.15, h: 3.15 });
    slide.addText(item.visualType === 'chart' ? 'DATA VISUAL' : item.visualType === 'timeline' ? 'ROADMAP' : 'AI VISUAL', {
      x: 9.42, y: 5.08, w: 2.86, h: 0.22, fontSize: 9.5, bold: true, color: palette.primary, align: 'center',
    });
    slide.addShape('rect', { x: 9.72, y: 5.47, w: 2.24, h: 0.08, color: palette.accent, transparency: 10 });
    return;
  }

  const label = item.visualType === 'chart' ? '数据关系' : item.visualType === 'timeline' ? '推进节奏' : item.visualType === 'matrix' ? '能力矩阵' : '关键视觉';
  slide.addText(label, { x: 9.52, y: 1.76, w: 2.64, h: 0.28, fontSize: 12.5, bold: true, color: palette.primary, align: 'center' });
  slide.addShape('ellipse', { x: 10.12, y: 2.45, w: 1.55, h: 1.55, color: palette.primary, transparency: 28, line: { color: palette.primary, transparency: 60 } });
  slide.addShape('ellipse', { x: 10.58, y: 2.92, w: 1.08, h: 1.08, color: palette.accent, transparency: 18, line: { color: palette.accent, transparency: 55 } });
  slide.addShape('rect', { x: 9.78, y: 4.55, w: 2.1, h: 0.08, color: palette.primary });
  slide.addShape('rect', { x: 10.18, y: 4.88, w: 1.35, h: 0.08, color: palette.accent });
  slide.addText('可替换为 AI 生成配图', { x: 9.45, y: 5.32, w: 2.82, h: 0.24, fontSize: 9.5, color: palette.muted, align: 'center' });
}

function addProcessVisual(slide, bullets, palette, style) {
  const list = (bullets.length ? bullets : ['输入资料', '生成结构', '导出 PPT']).slice(0, 4);
  const startX = 0.82;
  list.forEach((text, i) => {
    const x = startX + i * 1.92;
    slide.addShape('chevron', { x, y: 4.95, w: 1.55, h: 0.52, color: i % 2 ? palette.accent : palette.primary, transparency: 8 });
    slide.addText(String(i + 1).padStart(2, '0'), { x: x + 0.15, y: 5.08, w: 0.35, h: 0.16, fontSize: 8, bold: true, color: style === 'tech' ? '07111F' : 'FFFFFF' });
    slide.addText(text, { x: x + 0.52, y: 5.03, w: 0.82, h: 0.22, fontSize: 8.5, bold: true, color: style === 'tech' ? '07111F' : 'FFFFFF', fit: 'shrink' });
  });
}

function addTimelineVisual(slide, bullets, palette) {
  const list = (bullets.length ? bullets : ['第一阶段', '第二阶段', '第三阶段']).slice(0, 4);
  slide.addShape('rect', { x: 1.02, y: 5.06, w: 6.6, h: 0.04, color: palette.primary, transparency: 20 });
  list.forEach((text, i) => {
    const x = 1.0 + i * 1.78;
    slide.addShape('ellipse', { x, y: 4.9, w: 0.36, h: 0.36, color: i % 2 ? palette.accent : palette.primary });
    slide.addText(text, { x: x - 0.38, y: 5.38, w: 1.15, h: 0.36, fontSize: 8.5, color: palette.muted, align: 'center', fit: 'shrink' });
  });
}

function addMatrixVisual(slide, bullets, palette, style) {
  const list = (bullets.length ? bullets : ['能力一', '能力二', '能力三', '能力四']).slice(0, 4);
  list.forEach((text, i) => {
    const x = 0.95 + (i % 2) * 3.55;
    const y = 4.48 + Math.floor(i / 2) * 0.72;
    slide.addShape('rect', { x, y, w: 3.04, h: 0.46, color: style === 'tech' ? '10243A' : 'F8FAFC', line: { color: i % 2 ? palette.accent : palette.primary, transparency: 40 }, radius: 0.08 });
    slide.addText(text, { x: x + 0.2, y: y + 0.11, w: 2.64, h: 0.17, fontSize: 8.8, color: palette.text, fit: 'shrink' });
  });
}

function addChartVisual(slide, palette) {
  const bars = [0.92, 1.34, 1.72, 2.2];
  bars.forEach((h, i) => {
    const x = 1.2 + i * 0.78;
    slide.addShape('rect', { x, y: 5.82 - h, w: 0.42, h, color: i % 2 ? palette.accent : palette.primary, transparency: 8, radius: 0.06 });
  });
  slide.addShape('rect', { x: 0.95, y: 5.86, w: 3.5, h: 0.04, color: palette.muted, transparency: 45 });
  slide.addText('趋势提升', { x: 4.8, y: 4.72, w: 2.2, h: 0.28, fontSize: 11, bold: true, color: palette.primary });
  slide.addText('+ 效率 / 质量 / 一致性', { x: 4.8, y: 5.14, w: 2.4, h: 0.24, fontSize: 9, color: palette.muted });
}

async function generatePptx(_event, payload = {}) {
  const topic = String(payload.topic || '15code PPT Studio').trim();
  const scenario = String(payload.scenario || 'business').trim();
  const style = String(payload.style || 'consulting').trim();
  const slides = normalizeSlides(payload.slides, topic);
  const slideImages = normalizeSlideImages(payload.slideImages);
  const defaultName = `15code-ppt-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.pptx`;
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: defaultName,
    filters: [PPTX_FILTER],
  });
  if (canceled || !filePath) return { ok: false };

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = '15code PPT Studio';
  pptx.subject = scenario;
  pptx.title = topic;
  pptx.company = '15code';
  pptx.lang = 'zh-CN';
  pptx.theme = {
    headFontFace: 'Microsoft YaHei',
    bodyFontFace: 'Microsoft YaHei',
    lang: 'zh-CN',
  };

  const palette = style === 'gov'
    ? { bg: 'F7F8FA', panel: 'FFFFFF', primary: 'B91C1C', accent: '0F766E', text: '111827', muted: '6B7280', soft: 'FEE2E2' }
    : style === 'tech'
      ? { bg: '07111F', panel: '0E1B2F', primary: '22D3EE', accent: 'A3E635', text: 'F8FAFC', muted: '94A3B8', soft: '10243A' }
      : { bg: 'F8FAFC', panel: 'FFFFFF', primary: '2563EB', accent: '10B981', text: '111827', muted: '64748B', soft: 'EEF2FF' };

  slides.forEach((item, index) => {
    const slide = pptx.addSlide();
    const isCover = index === 0 || item.visualType === 'cover';
    const imageData = slideImages[index];
    slide.background = { color: palette.bg };
    addTopRule(slide, palette.primary);

    if (isCover) {
      slide.addShape('rect', { x: 0.52, y: 0.54, w: 12.28, h: 6.18, color: palette.panel, transparency: style === 'tech' ? 10 : 0, radius: 0.14 });
      slide.addShape('rect', { x: 0.52, y: 0.54, w: 0.18, h: 6.18, color: palette.primary, transparency: 4 });
      if (imageData) {
        slide.addShape('rect', { x: 8.1, y: 0.92, w: 4.16, h: 4.96, color: style === 'tech' ? '10243A' : 'F1F5F9', line: { color: style === 'tech' ? '155E75' : 'DCE7F7' }, radius: 0.12 });
        slide.addImage({ data: imageData, x: 8.32, y: 1.16, w: 3.72, h: 3.72 });
      } else {
        slide.addShape('ellipse', { x: 8.5, y: 1.1, w: 3.15, h: 3.15, color: palette.primary, transparency: 72, line: { color: palette.primary, transparency: 18, width: 1.4 } });
        slide.addShape('ellipse', { x: 9.22, y: 1.82, w: 1.72, h: 1.72, color: palette.accent, transparency: 42, line: { color: palette.accent, transparency: 25, width: 1.1 } });
        slide.addShape('rect', { x: 8.82, y: 4.72, w: 2.58, h: 0.08, color: palette.primary });
        slide.addShape('rect', { x: 9.3, y: 5.06, w: 1.58, h: 0.08, color: palette.accent });
      }
      slide.addText('15code PPT Studio', { x: 1.06, y: 1.1, w: 2.35, h: 0.2, fontSize: 10, bold: true, color: palette.primary });
      slide.addText(topic, { x: 1.03, y: 1.84, w: 6.92, h: 1.04, fontSize: 32, bold: true, color: palette.text, breakLine: false, fit: 'shrink' });
      slide.addText(item.subtitle || 'AI 生成与优化演示文稿', { x: 1.08, y: 3.08, w: 6.88, h: 0.35, fontSize: 14, color: palette.muted, fit: 'shrink' });
      slide.addShape('rect', { x: 1.08, y: 4.15, w: 1.32, h: 0.08, color: palette.primary });
      slide.addShape('rect', { x: 2.58, y: 4.15, w: 0.58, h: 0.08, color: palette.accent });
      slide.addText(`${scenario.toUpperCase()} · ${new Date().toLocaleDateString('zh-CN')}`, { x: 1.1, y: 5.72, w: 7.2, h: 0.22, fontSize: 9.5, color: palette.muted });
      return;
    }

    addDeckHeader(slide, item, palette, style);
    const bullets = item.bullets.length ? item.bullets : ['补充关键论据', '完善页面细节'];
    slide.addShape('rect', { x: 0.62, y: 1.38, w: 8.08, h: 5.22, color: style === 'tech' ? '0D1B2E' : 'FFFFFF', line: { color: style === 'tech' ? '1E3A5F' : 'E5E7EB', transparency: 15 }, radius: 0.12 });
    addBulletCards(slide, bullets, palette, style);

    if (item.visualType === 'process') addProcessVisual(slide, bullets, palette, style);
    if (item.visualType === 'timeline') addTimelineVisual(slide, bullets, palette);
    if (item.visualType === 'matrix') addMatrixVisual(slide, bullets, palette, style);
    if (item.visualType === 'chart') addChartVisual(slide, palette);
    if (item.visualType === 'closing') {
      slide.addShape('rect', { x: 1.0, y: 4.78, w: 6.62, h: 0.62, color: palette.soft, line: { color: palette.primary, transparency: 55 }, radius: 0.12 });
      slide.addText('下一步行动', { x: 1.25, y: 4.98, w: 1.7, h: 0.18, fontSize: 10.5, bold: true, color: palette.primary });
    }

    addImageOrVisual(slide, imageData, item, palette, style);

    if (item.notes) slide.addNotes(item.notes);
    addSlideNumber(slide, index + 1, slides.length);
  });

  await pptx.writeFile({ fileName: filePath });
  return { ok: true, path: filePath, slides: slides.length };
}

async function openPptxForAnalysis() {
  const win = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [PPTX_FILTER],
  });
  if (canceled || !filePaths[0]) return { ok: false };

  const filePath = filePaths[0];
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_PPTX_ANALYZE_BYTES) throw new Error('PPTX 超过 30MB，请压缩后再分析');

  const zip = await JSZip.loadAsync(await fs.promises.readFile(filePath));
  const slideFiles = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)?.[1] || 0) - Number(b.match(/slide(\d+)/)?.[1] || 0));

  const slides = [];
  for (const name of slideFiles) {
    const xml = await zip.files[name].async('string');
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map(m => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim())
      .filter(Boolean);
    slides.push({ index: slides.length + 1, text: texts.join(' | '), textCount: texts.length });
  }

  return {
    ok: true,
    name: path.basename(filePath),
    path: filePath,
    size: stat.size,
    slideCount: slides.length,
    slides,
  };
}

async function readTextFileForImport(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > MAX_IMPORT_BYTES) {
    throw new Error('文件超过 2MB，请拆分后再导入');
  }

  const buffer = await fs.promises.readFile(filePath);
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.includes(0)) {
    throw new Error('不支持导入二进制文件');
  }

  return {
    name: path.basename(filePath),
    content: buffer.toString('utf8'),
    size: stat.size,
  };
}

function createWindow() {
  const appPagePath = path.join(__dirname, 'index.html');
  const appPageUrl = pathToFileURL(appPagePath).href;
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
      sandbox: true,
      webSecurity: true,
    },
    backgroundColor: '#0a0a0f',
    show: false,
  });

  win.loadFile(appPagePath);
  win.once('ready-to-show', () => win.show());

  // 外部链接统一用浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url).catch(err => writeChatLog(`blocked-external-url ${err.message}`));
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.split('#')[0] !== appPageUrl) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', event => event.preventDefault());

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
              properties: ['openFile', 'multiSelections'],
              filters: [SUPPORTED_IMPORT_FILTER],
            });
            if (!canceled && filePaths.length) {
              for (const filePath of filePaths) {
                try {
                  win.webContents.send('menu:file-loaded', await readTextFileForImport(filePath));
                } catch (err) {
                  dialog.showErrorBox('导入失败', `${path.basename(filePath)}: ${err.message}`);
                }
              }
            }
          },
        },
        {
          label: '导出对话',
          accelerator: 'CmdOrCtrl+S',
          click: () => win.webContents.send('menu:export'),
        },
        {
          label: 'PPT Studio',
          accelerator: 'CmdOrCtrl+P',
          click: () => win.webContents.send('menu:ppt-studio'),
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
        { label: '15code 主站', click: () => openExternalUrl('https://15code.com') },
        { label: '使用文档', click: () => openExternalUrl('https://15code.com/guide') },
        { label: 'GitHub', click: () => openExternalUrl('https://github.com/zpf000zpf/15code-desktop') },
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
  await fs.promises.writeFile(filePath, content, 'utf-8');
  return { ok: true, path: filePath };
});

// 打开外部链接
ipcMain.handle('open-external', (_e, url) => openExternalUrl(url));

ipcMain.handle('auth:get-session', () => loadSessionToken());
ipcMain.handle('auth:set-session', (_e, token) => saveSessionToken(token));
ipcMain.handle('auth:clear-session', () => clearSessionToken());
ipcMain.handle('account:bootstrap', () => bootstrapAccount());

ipcMain.handle('get-app-info', () => {
  if (!chatLogPath) chatLogPath = path.join(app.getPath('userData'), 'chat-debug.log');
  return { version: app.getVersion(), chatLogPath, hasApiCredential: Boolean(loadApiKey()) };
});

ipcMain.handle('check-for-updates', () => checkForUpdates(true));

ipcMain.handle('install-update', () => {
  if (catalogUpdateUrl) return openExternalUrl(catalogUpdateUrl).then(() => ({ ok: true, external: true }));
  if (!updateReady) return { ok: false, message: '更新包尚未下载完成' };
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
});

ipcMain.handle('chat-completion', sendChatCompletion);
ipcMain.handle('chat-text-completion', sendChatTextCompletion);
ipcMain.handle('generate-pptx', generatePptx);
ipcMain.handle('open-pptx-for-analysis', openPptxForAnalysis);
ipcMain.handle('conversations:save', (_e, data) => saveConversation(data));
ipcMain.handle('conversations:load', (_e, id) => loadConversation(id));
ipcMain.handle('conversations:list', (_e, options) => listConversations(options));
ipcMain.handle('conversations:update', (_e, data) => updateConversation(data));

app.whenReady().then(() => {
  setupAutoUpdater();
  createWindow();
  setTimeout(() => checkForUpdates(false), 3000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try { chatDatabase?.close(); } catch {}
  chatDatabase = null;
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
