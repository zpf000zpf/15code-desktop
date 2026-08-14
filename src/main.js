// 15code Desktop — Electron main process
const { app, BrowserWindow, Menu, shell, dialog, ipcMain, safeStorage, protocol } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const { spawnSync } = require('child_process');
const https = require('https');
const { randomUUID } = require('crypto');
const { autoUpdater } = require('electron-updater');
const PptxGenJS = require('pptxgenjs');
const JSZip = require('jszip');
const { DatabaseSync } = require('node:sqlite');

// Chat images are deliberately served through a private protocol instead of file:// or
// data: URLs.  That keeps the renderer from persisting an unbounded base64 payload in
// its message state, localStorage, debug logs, or generated markup.
protocol.registerSchemesAsPrivileged([{
  scheme: '15code-chat-image',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

let chatLogPath = null;
let updateReady = false;
let catalogUpdateUrl = null;
let volatileSessionToken = null;
let volatileApiKey = null;
let chatDatabase = null;

const CHAT_IMAGE_ASSET_DIR = 'chat-image-assets';
const CHAT_IMAGE_PROTOCOL = '15code-chat-image';
const MAX_CHAT_IMAGE_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_CHAT_IMAGE_CACHE_BYTES = 512 * 1024 * 1024;
const CHAT_IMAGE_DELETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CHAT_IMAGE_ORPHAN_FILE_RETENTION_MS = 24 * 60 * 60 * 1000;
const SHUTDOWN_FLUSH_TIMEOUT_MS = 2000;
const MAX_MESSAGE_METADATA_BYTES = 12 * 1024;
const MAX_CHAT_MESSAGE_CHARS = 500000;
const MAX_IMAGE_CARD_PROMPT_CHARS = 2000;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const IMAGE_ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_STORAGE_KEY_RE = /^[0-9a-f-]{36}\.(?:png|jpg|webp)$/i;
const IMAGE_MIME_TO_EXTENSION = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const IMAGE_OPERATION_VALUES = new Set(['generate', 'edit', 'import']);
const IMAGE_STATUS_VALUES = new Set(['pending', 'complete', 'error']);
const IMAGE_SIZE_VALUES = new Set(['1024x1024', '1536x1024', '1024x1536']);
const IMAGE_QUALITY_VALUES = new Set(['low', 'medium', 'high']);
const IMAGE_FORMAT_VALUES = new Set(['png', 'jpeg', 'webp']);
const EMBEDDED_IMAGE_DATA_URL_RE = /data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+/gi;
const LINUX_SECRET_SERVICE = 'com.15code.desktop';
const LINUX_SECRET_TIMEOUT_MS = 5000;

// Keep quit coordination independent from Electron globals so the bounded close path can
// be exercised with VM mocks.  Only renderers that received prepare-to-quit may perform
// the final conversation save; all other new chat/image IPC is rejected once closing begins.
function createShutdownCoordinator({ getWindows, closeDatabase, cleanupUnattachedAssetsNow, exitApp,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, timeoutMs = SHUTDOWN_FLUSH_TIMEOUT_MS }) {
  let inProgress = false;
  let finalizing = false;
  let timer = null;
  let finishPromise = null;
  const pendingRendererIds = new Set();

  const finish = ({ timedOut }) => {
    if (finishPromise) return finishPromise;
    finalizing = true;
    if (timer) clearTimeoutFn(timer);
    timer = null;
    finishPromise = (async () => {
      // The timeout path has no renderer confirmation. Remove database rows for assets
      // that cannot be reconstructed from messages before the database is closed.
      if (timedOut) {
        try { await cleanupUnattachedAssetsNow(); } catch (error) { console.warn('Timed-out chat image cleanup failed:', error.message); }
      }
      try { await closeDatabase(); } catch (error) { console.warn('Chat database close failed:', error.message); }
      exitApp(0);
    })();
    return finishPromise;
  };

  return {
    begin(event) {
      if (finalizing) return;
      event?.preventDefault?.();
      if (inProgress) return;
      inProgress = true;
      for (const win of getWindows()) {
        if (!win || win.isDestroyed?.()) continue;
        const sender = win.webContents;
        if (!sender || sender.isDestroyed?.()) continue;
        try {
          pendingRendererIds.add(sender.id);
          sender.send('app:prepare-to-quit');
        } catch {
          pendingRendererIds.delete(sender.id);
        }
      }
      if (!pendingRendererIds.size) {
        void finish({ timedOut: false });
        return;
      }
      timer = setTimeoutFn(() => { void finish({ timedOut: true }); }, timeoutMs);
    },
    acknowledge(senderId) {
      if (!inProgress || finalizing || !pendingRendererIds.has(senderId)) return { ok: false };
      pendingRendererIds.delete(senderId);
      if (!pendingRendererIds.size) void finish({ timedOut: false });
      return { ok: true };
    },
    isIpcAllowed(senderId, channel) {
      if (!inProgress) return true;
      return !finalizing && channel === 'conversations:save' && pendingRendererIds.has(senderId);
    },
    getState() {
      return { inProgress, finalizing, pendingRendererIds: [...pendingRendererIds] };
    },
  };
}

function closeChatDatabase() {
  try { chatDatabase?.close(); } finally { chatDatabase = null; }
}

function getSessionFilePath() {
  return path.join(app.getPath('userData'), 'session-token.bin');
}

function getApiKeyFilePath() {
  return path.join(app.getPath('userData'), 'api-key.bin');
}

function getCredentialFilePath(credential) {
  if (credential === 'session-token') return getSessionFilePath();
  if (credential === 'api-key') return getApiKeyFilePath();
  throw new Error('未知安全凭证类型');
}

// Electron reports basic_text as "available" on Linux, but it is deliberately not
// encryption. Never write an account credential through that backend. Windows keeps
// its normal DPAPI implementation and macOS keeps Keychain through safeStorage.
function hasSecureSafeStorage(storage = safeStorage, platform = process.platform) {
  try {
    if (!storage.isEncryptionAvailable()) return false;
    if (platform !== 'linux') return true;
    const backend = typeof storage.getSelectedStorageBackend === 'function'
      ? storage.getSelectedStorageBackend()
      : null;
    return Boolean(backend && backend !== 'basic_text');
  } catch {
    return false;
  }
}

function linuxSecretAttributes(credential) {
  return ['service', LINUX_SECRET_SERVICE, 'credential', credential];
}

// secret-tool talks to the desktop's Secret Service (normally GNOME Keyring). Input is
// passed on stdin, never a command line or log. This is intentionally Linux-only: it is
// a fallback for Electron's unavailable/unsafe Linux backend, not a replacement for
// Windows DPAPI or macOS Keychain.
function runLinuxSecretTool(args, input) {
  try {
    return spawnSync('secret-tool', args, {
      input,
      encoding: 'utf8',
      timeout: LINUX_SECRET_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (error) {
    return { error };
  }
}

function storeLinuxSecret(credential, value, runTool = runLinuxSecretTool) {
  const result = runTool([
    'store', '--label=15code Desktop', ...linuxSecretAttributes(credential),
  ], value);
  return !result?.error && result.status === 0;
}

function loadLinuxSecret(credential, runTool = runLinuxSecretTool) {
  const result = runTool(['lookup', ...linuxSecretAttributes(credential)]);
  if (result?.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  // secret-tool terminates its textual output with a single newline. Bearer JWTs and
  // API keys never contain newlines, so removing only that transport delimiter is safe.
  return result.stdout.replace(/\r?\n$/, '') || null;
}

function clearLinuxSecret(credential, runTool = runLinuxSecretTool) {
  const result = runTool(['clear', ...linuxSecretAttributes(credential)]);
  return !result?.error && result.status === 0;
}

function removeCredentialFile(credential) {
  try { fs.rmSync(getCredentialFilePath(credential), { force: true }); } catch {}
}

function saveCredential(credential, value, storage = safeStorage, platform = process.platform, runTool = runLinuxSecretTool) {
  const target = getCredentialFilePath(credential);
  if (hasSecureSafeStorage(storage, platform)) {
    const encrypted = storage.encryptString(value);
    const temporary = target + '.tmp';
    fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
    return { persisted: true, storage: 'safeStorage' };
  }
  if (platform === 'linux') {
    // Versions that used basic_text may have left a plaintext file behind. Remove it
    // before storing in Secret Service, and never attempt to recover from it.
    removeCredentialFile(credential);
    if (storeLinuxSecret(credential, value, runTool)) {
      return { persisted: true, storage: 'secret-service' };
    }
  }
  return { persisted: false, storage: 'memory' };
}

function loadCredential(credential, storage = safeStorage, platform = process.platform, runTool = runLinuxSecretTool) {
  if (hasSecureSafeStorage(storage, platform)) {
    try { return storage.decryptString(fs.readFileSync(getCredentialFilePath(credential))); } catch { return null; }
  }
  if (platform === 'linux') {
    // Do not read a legacy basic_text file even if it exists.
    removeCredentialFile(credential);
    return loadLinuxSecret(credential, runTool);
  }
  return null;
}

function clearCredential(credential, platform = process.platform, runTool = runLinuxSecretTool) {
  removeCredentialFile(credential);
  if (platform === 'linux') clearLinuxSecret(credential, runTool);
}

function getChatImageAssetDir() {
  return path.join(app.getPath('userData'), CHAT_IMAGE_ASSET_DIR);
}

function getChatImageAssetPath(storageKey) {
  if (!IMAGE_STORAGE_KEY_RE.test(String(storageKey || ''))) throw new Error('图片资源标识无效');
  return path.join(getChatImageAssetDir(), storageKey);
}

function imageMimeFromStorageKey(storageKey) {
  const extension = path.extname(storageKey).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return null;
}

function chatImageUrl(assetId) {
  if (!IMAGE_ASSET_ID_RE.test(String(assetId || ''))) throw new Error('图片资源标识无效');
  return `${CHAT_IMAGE_PROTOCOL}://asset/${assetId}`;
}

function validateConversationId(id) {
  if (!SAFE_ID_RE.test(String(id || ''))) throw new Error('会话标识无效');
  return String(id);
}

function sanitizeImageMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const assetId = String(value.assetId || '');
  const operation = String(value.operation || '');
  const status = String(value.status || 'complete');
  const format = String(value.format || 'png');
  const mime = String(value.mime || (format === 'jpeg' ? 'image/jpeg' : `image/${format}`));
  const size = String(value.size || '1024x1024');
  const quality = String(value.quality || 'low');
  const prompt = String(value.prompt || '').trim();
  const sourceAssetId = value.sourceAssetId ? String(value.sourceAssetId) : null;
  const error = value.error ? String(value.error).slice(0, 500) : null;
  const expectedExtension = format === 'jpeg' ? 'jpg' : format;
  if (!IMAGE_ASSET_ID_RE.test(assetId) || !IMAGE_OPERATION_VALUES.has(operation)
    || !IMAGE_STATUS_VALUES.has(status) || !IMAGE_FORMAT_VALUES.has(format)
    || IMAGE_MIME_TO_EXTENSION[mime] !== expectedExtension || !IMAGE_SIZE_VALUES.has(size) || !IMAGE_QUALITY_VALUES.has(quality)
    || prompt.length > MAX_IMAGE_CARD_PROMPT_CHARS
    || (sourceAssetId && !IMAGE_ASSET_ID_RE.test(sourceAssetId))) return null;
  const metadata = { assetId, operation, status, format, mime, size, quality, prompt, sourceAssetId, error };
  return Buffer.byteLength(JSON.stringify(metadata), 'utf8') <= MAX_MESSAGE_METADATA_BYTES ? metadata : null;
}

function sanitizeStoredMessage(message) {
  if (!message || !['user', 'assistant'].includes(message.role)) return null;
  const content = String(message.content || '').replace(EMBEDDED_IMAGE_DATA_URL_RE, '[嵌入式图片数据未保存]').slice(0, MAX_CHAT_MESSAGE_CHARS);
  const image = sanitizeImageMetadata(message.image);
  const type = image ? 'image' : 'text';
  return { role: message.role, content, type, image };
}

function parseStoredImageMetadata(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_MESSAGE_METADATA_BYTES) return null;
  try { return sanitizeImageMetadata(JSON.parse(raw)); } catch { return null; }
}

function hasExpectedImageSignature(mime, bytes) {
  if (!Buffer.isBuffer(bytes)) return false;
  if (mime === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/jpeg') return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/webp') return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function saveApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 16384) {
    throw new Error('API Key 格式无效');
  }
  volatileApiKey = apiKey;
  return { ok: true, ...saveCredential('api-key', apiKey) };
}

function loadApiKey() {
  if (volatileApiKey) return volatileApiKey;
  volatileApiKey = loadCredential('api-key');
  return volatileApiKey;
}

function clearApiKey() {
  volatileApiKey = null;
  clearCredential('api-key');
}

function saveSessionToken(token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 16384) {
    throw new Error('登录凭证格式无效');
  }
  volatileSessionToken = token;
  return { ok: true, ...saveCredential('session-token', token) };
}

function loadSessionToken() {
  if (volatileSessionToken) return volatileSessionToken;
  volatileSessionToken = loadCredential('session-token');
  return volatileSessionToken;
}

function clearSessionToken() {
  volatileSessionToken = null;
  clearCredential('session-token');
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
  // v1.0.17 stored only role/content.  Additive columns preserve old histories and
  // let image cards refer to a bounded local asset without changing text semantics.
  const messageColumns = new Set(chatDatabase.prepare('PRAGMA table_info(messages)').all().map(column => column.name));
  if (!messageColumns.has('client_id')) chatDatabase.exec('ALTER TABLE messages ADD COLUMN client_id TEXT');
  if (!messageColumns.has('type')) chatDatabase.exec("ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'");
  if (!messageColumns.has('metadata')) chatDatabase.exec('ALTER TABLE messages ADD COLUMN metadata TEXT');
  chatDatabase.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(conversation_id, client_id);
    CREATE TABLE IF NOT EXISTS image_assets (
      asset_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      message_key TEXT,
      storage_key TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      format TEXT NOT NULL,
      operation TEXT NOT NULL,
      source_asset_id TEXT,
      prompt TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_image_assets_conversation ON image_assets(conversation_id, message_key, updated_at);
  `);
  void cleanupChatImageAssets().catch(() => {});
  return chatDatabase;
}

function saveConversation({ id, title, model, draft = '', messages = [] }) {
  id = validateConversationId(id);
  if (!Array.isArray(messages)) throw new Error('会话数据无效');
  const db = getChatDatabase();
  const now = Date.now();
  const existing = db.prepare('SELECT created_at, pinned, deleted FROM conversations WHERE id = ?').get(id);
  const normalizedMessages = messages.slice(-200).map((message, index) => {
    const clean = sanitizeStoredMessage(message);
    if (!clean) return null;
    const clientId = SAFE_ID_RE.test(String(message.id || '')) ? String(message.id) : randomUUID();
    return { ...clean, clientId, createdAt: Number(message.createdAt) || now + index };
  }).filter(Boolean);
  const imageMessages = normalizedMessages.filter(message => message.image);
  // An evicted asset from a deleted/recovered conversation remains a harmless
  // unavailable card.  Only complete assets must still exist and be owned here.
  const attachedImageMessages = imageMessages.filter(message => message.image.status === 'complete');
  const assetIds = attachedImageMessages.map(message => message.image.assetId);
  const sourceAssetIds = attachedImageMessages.map(message => message.image.sourceAssetId).filter(Boolean);
  if (new Set(assetIds).size !== assetIds.length) throw new Error('同一图片不能重复作为消息结果');
  db.exec('BEGIN IMMEDIATE');
  let removedAssets = [];
  try {
    db.prepare(`INSERT INTO conversations (id,title,model,draft,pinned,deleted,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, model=excluded.model, draft=excluded.draft, updated_at=excluded.updated_at`)
      .run(id, String(title || '新对话').slice(0, 120), String(model || ''), String(draft || '').slice(0, MAX_CHAT_MESSAGE_CHARS),
        existing?.pinned || 0, existing?.deleted || 0, existing?.created_at || now, now);
    if (assetIds.length) {
      const placeholders = assetIds.map(() => '?').join(',');
      const owned = db.prepare(`SELECT asset_id FROM image_assets WHERE conversation_id = ? AND asset_id IN (${placeholders})`)
        .all(id, ...assetIds);
      if (owned.length !== assetIds.length) throw new Error('图片资源不属于当前会话或已被清理');
      if (sourceAssetIds.length) {
        const sourcePlaceholders = sourceAssetIds.map(() => '?').join(',');
        const sources = db.prepare(`SELECT asset_id FROM image_assets WHERE conversation_id = ? AND asset_id IN (${sourcePlaceholders})`)
          .all(id, ...sourceAssetIds);
        if (new Set(sources.map(source => source.asset_id)).size !== new Set(sourceAssetIds).size) {
          throw new Error('图片源不属于当前会话或已被清理');
        }
      }
    }
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    const insert = db.prepare('INSERT INTO messages(conversation_id,client_id,role,content,type,metadata,created_at) VALUES (?,?,?,?,?,?,?)');
    normalizedMessages.forEach(message => {
      insert.run(id, message.clientId, message.role, message.content, message.type,
        message.image ? JSON.stringify(message.image) : null, message.createdAt);
    });
    if (assetIds.length) {
      const placeholders = assetIds.map(() => '?').join(',');
      removedAssets = db.prepare(`SELECT asset_id, storage_key FROM image_assets
        WHERE conversation_id = ? AND asset_id NOT IN (${placeholders})`).all(id, ...assetIds);
      db.prepare(`DELETE FROM image_assets WHERE conversation_id = ? AND asset_id NOT IN (${placeholders})`).run(id, ...assetIds);
      const attach = db.prepare('UPDATE image_assets SET updated_at = ? WHERE asset_id = ? AND conversation_id = ? AND message_key = ?');
      attachedImageMessages.forEach(message => {
        if (attach.run(now, message.image.assetId, id, message.clientId).changes !== 1) {
          throw new Error('图片消息关联不匹配');
        }
      });
    } else {
      removedAssets = db.prepare('SELECT asset_id, storage_key FROM image_assets WHERE conversation_id = ?').all(id);
      db.prepare('DELETE FROM image_assets WHERE conversation_id = ?').run(id);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  removedAssets.forEach(asset => void removeChatImageFile(asset.storage_key));
  return { ok: true };
}

function loadConversation(id) {
  const db = getChatDatabase();
  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!conversation) return null;
  const messages = db.prepare('SELECT client_id, role, content, type, metadata, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(id)
    .map(message => {
      let image = parseStoredImageMetadata(message.metadata);
      // Asset ownership is verified at save time. A cache-evicted deleted-conversation
      // asset stays as an explicitly unavailable card rather than resolving to a path.
      if (image && !db.prepare('SELECT 1 FROM image_assets WHERE asset_id = ? AND conversation_id = ?').get(image.assetId, id)) {
        image = { ...image, status: 'error', error: '图片文件已被清理或不可用' };
      }
      return { id: message.client_id || randomUUID(), role: message.role, content: message.content,
        createdAt: message.created_at, ...(image ? { type: 'image', image: { ...image, url: chatImageUrl(image.assetId) } } : {}) };
    });
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
  id = validateConversationId(id);
  const db = getChatDatabase();
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!row) throw new Error('会话不存在');
  db.prepare(`UPDATE conversations SET title=?, pinned=?, deleted=?, draft=?, updated_at=? WHERE id=?`)
    .run(title === undefined ? row.title : String(title).slice(0, 120),
      pinned === undefined ? row.pinned : (pinned ? 1 : 0),
      deleted === undefined ? row.deleted : (deleted ? 1 : 0),
      draft === undefined ? row.draft : String(draft).slice(0, MAX_CHAT_MESSAGE_CHARS), Date.now(), id);
  if (deleted) void cleanupChatImageAssets().catch(() => {});
  return { ok: true };
}

function parseImageDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('图片数据无效');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_CHAT_IMAGE_ASSET_BYTES) throw new Error('图片数据为空或超过 20 MB');
  if (Buffer.from(bytes.toString('base64'), 'base64').length !== bytes.length) throw new Error('图片编码无效');
  if (!hasExpectedImageSignature(match[1], bytes)) throw new Error('图片格式无效');
  return { mime: match[1], bytes };
}

async function removeChatImageFile(storageKey) {
  try { await fs.promises.rm(getChatImageAssetPath(storageKey), { force: true }); } catch {}
}

async function writeChatImageAsset({ conversationId, messageId, bytes, mime, format, operation, prompt = '', sourceAssetId = null }) {
  conversationId = validateConversationId(conversationId);
  if (!SAFE_ID_RE.test(String(messageId || ''))) throw new Error('图片消息标识无效');
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_CHAT_IMAGE_ASSET_BYTES) {
    throw new Error('图片数据为空或超过 20 MB');
  }
  const expectedExtension = format === 'jpeg' ? 'jpg' : format;
  if (!IMAGE_MIME_TO_EXTENSION[mime] || IMAGE_MIME_TO_EXTENSION[mime] !== expectedExtension
    || !IMAGE_FORMAT_VALUES.has(format) || !IMAGE_OPERATION_VALUES.has(operation)
    || String(prompt).length > MAX_IMAGE_CARD_PROMPT_CHARS
    || (sourceAssetId && !IMAGE_ASSET_ID_RE.test(String(sourceAssetId))) || !hasExpectedImageSignature(mime, bytes)) {
    throw new Error('图片资源参数无效');
  }
  if (shutdownCoordinator?.getState().inProgress) throw new Error('应用正在关闭，图片结果未保存');
  const db = getChatDatabase();
  const conversation = db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId);
  if (!conversation) throw new Error('请先保存会话后再生成图片');
  if (sourceAssetId && !db.prepare('SELECT 1 FROM image_assets WHERE asset_id = ? AND conversation_id = ?').get(sourceAssetId, conversationId)) {
    throw new Error('源图片不属于当前会话或已被清理');
  }
  await cleanupChatImageAssets();
  // The generation/edit request may have been accepted before quit started. Do not
  // create a new asset after the bounded shutdown coordinator has begun closing.
  if (shutdownCoordinator?.getState().inProgress) throw new Error('应用正在关闭，图片结果未保存');
  const cacheBytes = Number(db.prepare('SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM image_assets').get().bytes || 0);
  if (cacheBytes + bytes.length > MAX_CHAT_IMAGE_CACHE_BYTES) {
    throw new Error('聊天图片本地缓存已达 512 MB 上限；请保存需要保留的图片并删除旧会话后重试');
  }
  const assetId = randomUUID();
  const extension = IMAGE_MIME_TO_EXTENSION[mime];
  const storageKey = `${assetId}.${extension}`;
  const target = getChatImageAssetPath(storageKey);
  await fs.promises.mkdir(getChatImageAssetDir(), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.promises.writeFile(temporary, bytes, { mode: 0o600 });
    await fs.promises.rename(temporary, target);
    await fs.promises.chmod(target, 0o600);
    if (shutdownCoordinator?.getState().inProgress) throw new Error('应用正在关闭，图片结果未保存');
    const now = Date.now();
    db.prepare(`INSERT INTO image_assets
      (asset_id,conversation_id,message_key,storage_key,mime,byte_size,format,operation,source_asset_id,prompt,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      assetId, conversationId, String(messageId), storageKey, mime, bytes.length, format, operation,
      sourceAssetId || null, String(prompt).trim(), now, now
    );
    return { assetId, mime, format, operation, sourceAssetId: sourceAssetId || null, url: chatImageUrl(assetId) };
  } catch (error) {
    try { await fs.promises.rm(temporary, { force: true }); } catch {}
    try { await fs.promises.rm(target, { force: true }); } catch {}
    throw error;
  }
}

async function selectChatImageForEdit(_event, payload = {}) {
  const conversationId = validateConversationId(payload.conversationId);
  const messageId = String(payload.messageId || '');
  const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (canceled || !filePaths[0]) return { ok: false };
  const filePath = path.resolve(filePaths[0]);
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CHAT_IMAGE_ASSET_BYTES) throw new Error('输入图片无效或超过 20 MB');
  const extension = path.extname(filePath).toLowerCase();
  const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : `image/${extension.slice(1)}`;
  const format = mime === 'image/jpeg' ? 'jpeg' : extension.slice(1);
  if (!IMAGE_MIME_TO_EXTENSION[mime] || !IMAGE_FORMAT_VALUES.has(format)) throw new Error('不支持的图片格式');
  const asset = await writeChatImageAsset({
    conversationId, messageId, bytes: await fs.promises.readFile(filePath), mime, format, operation: 'import', prompt: '',
  });
  return { ok: true, name: path.basename(filePath).slice(0, 180), ...asset };
}

async function generateChatImage(_event, payload = {}) {
  const conversationId = validateConversationId(payload.conversationId);
  const messageId = String(payload.messageId || '');
  if (!SAFE_ID_RE.test(messageId)) throw new Error('图片消息标识无效');
  const prompt = String(payload.prompt || '').trim();
  const size = IMAGE_SIZE_VALUES.has(String(payload.size)) ? String(payload.size) : '1024x1024';
  const quality = IMAGE_QUALITY_VALUES.has(String(payload.quality)) ? String(payload.quality) : 'low';
  const format = IMAGE_FORMAT_VALUES.has(String(payload.format)) ? String(payload.format) : 'png';
  if (!prompt || prompt.length > MAX_IMAGE_CARD_PROMPT_CHARS) throw new Error('图片提示词无效或过长');
  const result = await generateDesktopImage(null, {
    model: 'gpt-image-2', prompt, size, quality, format, clientRequestId: payload.clientRequestId,
  });
  const parsed = parseImageDataUrl(result.dataUrl);
  const asset = await writeChatImageAsset({ conversationId, messageId, ...parsed, format, operation: 'generate', prompt });
  return { ...asset, size, quality, prompt, usage: result.usage || null };
}

async function editChatImage(_event, payload = {}) {
  const conversationId = validateConversationId(payload.conversationId);
  const messageId = String(payload.messageId || '');
  if (!SAFE_ID_RE.test(messageId)) throw new Error('图片消息标识无效');
  const sourceAssetId = String(payload.sourceAssetId || '');
  const prompt = String(payload.prompt || '').trim();
  const size = IMAGE_SIZE_VALUES.has(String(payload.size)) ? String(payload.size) : '1024x1024';
  const quality = IMAGE_QUALITY_VALUES.has(String(payload.quality)) ? String(payload.quality) : 'low';
  const format = IMAGE_FORMAT_VALUES.has(String(payload.format)) ? String(payload.format) : 'png';
  if (!IMAGE_ASSET_ID_RE.test(sourceAssetId) || !prompt || prompt.length > MAX_IMAGE_CARD_PROMPT_CHARS) {
    throw new Error('图片修改参数无效或过长');
  }
  const db = getChatDatabase();
  const source = db.prepare('SELECT storage_key FROM image_assets WHERE asset_id = ? AND conversation_id = ?').get(sourceAssetId, conversationId);
  if (!source) throw new Error('源图片不属于当前会话或已被清理');
  const sourcePath = getChatImageAssetPath(source.storage_key);
  const stat = await fs.promises.stat(sourcePath).catch(() => null);
  if (!stat?.isFile() || stat.size <= 0 || stat.size > MAX_CHAT_IMAGE_ASSET_BYTES) throw new Error('源图片已不可用，请重新选择');
  const result = await editDesktopImage(null, {
    path: sourcePath, prompt, size, quality, format, clientRequestId: payload.clientRequestId,
  });
  const parsed = parseImageDataUrl(result.dataUrl);
  const asset = await writeChatImageAsset({ conversationId, messageId, ...parsed, format, operation: 'edit', prompt, sourceAssetId });
  return { ...asset, size, quality, prompt, usage: result.usage || null };
}

async function saveChatImageAsset(_event, payload = {}) {
  const conversationId = validateConversationId(payload.conversationId);
  const assetId = String(payload.assetId || '');
  if (!IMAGE_ASSET_ID_RE.test(assetId)) throw new Error('图片资源标识无效');
  const db = getChatDatabase();
  const asset = db.prepare('SELECT storage_key, format FROM image_assets WHERE asset_id = ? AND conversation_id = ?').get(assetId, conversationId);
  if (!asset) throw new Error('图片已被清理');
  const source = getChatImageAssetPath(asset.storage_key);
  const stat = await fs.promises.stat(source).catch(() => null);
  if (!stat?.isFile() || stat.size <= 0 || stat.size > MAX_CHAT_IMAGE_ASSET_BYTES) throw new Error('图片文件已不可用');
  const extension = asset.format === 'jpeg' ? 'jpg' : asset.format;
  const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
    defaultPath: `15code-image-${Date.now()}.${extension}`,
    filters: [{ name: '图片', extensions: [extension] }],
  });
  if (canceled || !filePath) return { ok: false };
  await fs.promises.copyFile(source, filePath);
  return { ok: true, path: filePath };
}

async function cleanupChatImageAssets() {
  if (!chatDatabase) return;
  const db = chatDatabase;
  const now = Date.now();
  // Active conversation assets are never evicted by cache pressure.  Deleted conversations
  // get a 30-day recovery window; only their assets and unreferenced files in this dedicated
  // directory are eligible for cleanup, so PPT files and other user files are untouched.
  const expired = db.prepare(`SELECT a.asset_id, a.storage_key FROM image_assets a
    JOIN conversations c ON c.id = a.conversation_id
    WHERE c.deleted = 1 AND c.updated_at < ?`).all(now - CHAT_IMAGE_DELETED_RETENTION_MS);
  if (expired.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const remove = db.prepare('DELETE FROM image_assets WHERE asset_id = ?');
      expired.forEach(asset => remove.run(asset.asset_id));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    await Promise.all(expired.map(asset => removeChatImageFile(asset.storage_key)));
  }
  const unattached = db.prepare(`SELECT a.asset_id, a.storage_key FROM image_assets a
    LEFT JOIN messages m ON m.conversation_id = a.conversation_id AND m.client_id = a.message_key
    WHERE (a.message_key IS NULL OR m.id IS NULL) AND a.created_at < ?`)
    .all(now - CHAT_IMAGE_ORPHAN_FILE_RETENTION_MS);
  if (unattached.length) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const remove = db.prepare(`DELETE FROM image_assets WHERE asset_id = ? AND NOT EXISTS (
        SELECT 1 FROM messages m WHERE m.conversation_id = image_assets.conversation_id AND m.client_id = image_assets.message_key
      )`);
      unattached.forEach(asset => remove.run(asset.asset_id));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    await Promise.all(unattached.map(asset => removeChatImageFile(asset.storage_key)));
  }
  let total = db.prepare('SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM image_assets').get().bytes || 0;
  if (total > MAX_CHAT_IMAGE_CACHE_BYTES) {
    const removable = db.prepare(`SELECT a.asset_id, a.storage_key, a.byte_size FROM image_assets a
      JOIN conversations c ON c.id = a.conversation_id WHERE c.deleted = 1 ORDER BY a.updated_at ASC`).all();
    const toRemove = [];
    for (const asset of removable) {
      if (total <= MAX_CHAT_IMAGE_CACHE_BYTES) break;
      total -= asset.byte_size;
      toRemove.push(asset);
    }
    if (toRemove.length) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const remove = db.prepare('DELETE FROM image_assets WHERE asset_id = ?');
        toRemove.forEach(asset => remove.run(asset.asset_id));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      await Promise.all(toRemove.map(asset => removeChatImageFile(asset.storage_key)));
    }
  }
  let filenames = [];
  try { filenames = await fs.promises.readdir(getChatImageAssetDir()); } catch { return; }
  const known = new Set(db.prepare('SELECT storage_key FROM image_assets').all().map(asset => asset.storage_key));
  const staleNames = filenames.filter(name => (IMAGE_STORAGE_KEY_RE.test(name) && !known.has(name))
    || /^[0-9a-f-]{36}\.(?:png|jpg|webp)\.tmp-\d+-\d+$/i.test(name));
  await Promise.all(staleNames.map(async name => {
    const target = getChatImageAssetPath(name);
    const stat = await fs.promises.stat(target).catch(() => null);
    if (stat?.isFile() && now - stat.mtimeMs > CHAT_IMAGE_ORPHAN_FILE_RETENTION_MS) await fs.promises.rm(target, { force: true });
  }));
}

// Unlike the periodic retention cleanup, quit timeout must not leave an image written by
// a completed generation without a persisted message for another 24 hours.  This is kept
// separate so the normal recovery window remains unchanged for ordinary transient saves.
async function cleanupUnattachedChatImageAssetsNow({ db = chatDatabase, removeFile = removeChatImageFile } = {}) {
  if (!db) return [];
  const unattached = db.prepare(`SELECT a.asset_id, a.storage_key FROM image_assets a
    LEFT JOIN messages m ON m.conversation_id = a.conversation_id AND m.client_id = a.message_key
    WHERE a.message_key IS NULL OR m.id IS NULL`).all();
  if (!unattached.length) return [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const remove = db.prepare(`DELETE FROM image_assets WHERE asset_id = ? AND NOT EXISTS (
      SELECT 1 FROM messages m WHERE m.conversation_id = image_assets.conversation_id AND m.client_id = image_assets.message_key
    )`);
    unattached.forEach(asset => remove.run(asset.asset_id));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  await Promise.all(unattached.map(asset => removeFile(asset.storage_key)));
  return unattached.map(asset => asset.asset_id);
}

async function serveChatImageAsset(request) {
  try {
    const url = new URL(request.url);
    const assetId = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (url.hostname !== 'asset' || !IMAGE_ASSET_ID_RE.test(assetId)) return new Response('Not found', { status: 404 });
    const db = getChatDatabase();
    const asset = db.prepare('SELECT storage_key, mime, byte_size FROM image_assets WHERE asset_id = ?').get(assetId);
    if (!asset || asset.byte_size <= 0 || asset.byte_size > MAX_CHAT_IMAGE_ASSET_BYTES) return new Response('Not found', { status: 404 });
    const filePath = getChatImageAssetPath(asset.storage_key);
    const bytes = await fs.promises.readFile(filePath);
    if (bytes.length !== asset.byte_size || bytes.length > MAX_CHAT_IMAGE_ASSET_BYTES
      || imageMimeFromStorageKey(asset.storage_key) !== asset.mime
      || !hasExpectedImageSignature(asset.mime, bytes)) {
      return new Response('Not found', { status: 404 });
    }
    return new Response(bytes, { headers: { 'Content-Type': asset.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
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
const IMAGE_MODELS = new Set(['gpt-image-2']);
const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
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

async function imageApiJson(route, options = {}) {
  const apiKey = loadApiKey();
  if (!apiKey) throw new Error('图片参数不完整，请重新登录后再试');
  const response = await fetch(`https://${LLM_HOST}${route}`, {
    ...options,
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'User-Agent': `15code-desktop/${app.getVersion()} Electron/${process.versions.electron}`,
      ...(options.headers || {}),
    },
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { error: raw.slice(0, 500) }; }
  if (!response.ok) {
    const message = response.status === 403
      ? '当前账号尚未开通图片权限'
      : (data.error?.message || data.error || `图片服务 HTTP ${response.status}`);
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

function normalizeImageResult(data, format) {
  const first = data?.data?.[0];
  if (!first?.b64_json) throw new Error('图片服务没有返回图片数据');
  const mime = format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
  return { dataUrl: `data:${mime};base64,${first.b64_json}`, usage: data.usage || null, format };
}

async function getImageCapabilities() {
  const data = await imageApiJson('/v1/models');
  const ids = new Set((data.data || []).map(model => model.id));
  return { generation: ids.has('gpt-image-2'), editing: ids.has('gpt-image-2') };
}

async function generateDesktopImage(_event, payload = {}) {
  const prompt = String(payload.prompt || '').trim();
  const model = String(payload.model || 'gpt-image-2');
  const format = ['png', 'jpeg', 'webp'].includes(payload.format) ? payload.format : 'png';
  const clientRequestId = String(payload.clientRequestId || '').trim();
  if (!prompt || prompt.length > 8000 || !IMAGE_MODELS.has(model)) throw new Error('图片生成参数无效');
  if (clientRequestId && !/^[A-Za-z0-9._:-]{1,128}$/.test(clientRequestId)) throw new Error('图片请求标识无效');
  const data = await imageApiJson('/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(clientRequestId ? { 'X-Client-Request-Id': clientRequestId } : {}) },
    body: JSON.stringify({ model, prompt, size: payload.size || '1024x1024', quality: payload.quality || 'low', output_format: format }),
  });
  return normalizeImageResult(data, format);
}

async function selectImageForEdit() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (canceled || !filePaths[0]) return { ok: false };
  const filePath = path.resolve(filePaths[0]);
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_IMAGE_INPUT_BYTES) throw new Error('输入图片无效或超过 20 MB');
  const extension = path.extname(filePath).toLowerCase();
  const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : `image/${extension.slice(1)}`;
  return { ok: true, path: filePath, name: path.basename(filePath), previewUrl: `data:${mime};base64,${(await fs.promises.readFile(filePath)).toString('base64')}` };
}

async function editDesktopImage(_event, payload = {}) {
  const prompt = String(payload.prompt || '').trim();
  const filePath = path.resolve(String(payload.path || ''));
  const format = ['png', 'jpeg', 'webp'].includes(payload.format) ? payload.format : 'png';
  const clientRequestId = String(payload.clientRequestId || '').trim();
  if (!prompt || prompt.length > 8000 || !filePath) throw new Error('图片编辑参数无效');
  if (clientRequestId && !/^[A-Za-z0-9._:-]{1,128}$/.test(clientRequestId)) throw new Error('图片请求标识无效');
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size > MAX_IMAGE_INPUT_BYTES) throw new Error('输入图片无效或超过 20 MB');
  const bytes = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('prompt', prompt);
  form.append('size', payload.size || '1024x1024');
  form.append('quality', payload.quality || 'low');
  form.append('output_format', format);
  form.append('image', new Blob([bytes]), path.basename(filePath));
  const data = await imageApiJson('/v1/images/edits', {
    method: 'POST',
    headers: clientRequestId ? { 'X-Client-Request-Id': clientRequestId } : {},
    body: form,
  });
  return normalizeImageResult(data, format);
}

async function saveGeneratedImage(_event, payload = {}) {
  const match = String(payload.dataUrl || '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('图片数据无效');
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: `15code-image-${Date.now()}.${extension}`,
    filters: [{ name: '图片', extensions: [extension] }],
  });
  if (canceled || !filePath) return { ok: false };
  await fs.promises.writeFile(filePath, Buffer.from(match[2], 'base64'));
  return { ok: true, path: filePath };
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

const shutdownCoordinator = createShutdownCoordinator({
  getWindows: () => BrowserWindow.getAllWindows(),
  closeDatabase: closeChatDatabase,
  cleanupUnattachedAssetsNow: cleanupUnattachedChatImageAssetsNow,
  exitApp: (code) => app.exit(code),
});

function rejectIpcWhileShuttingDown(event, channel) {
  if (shutdownCoordinator.isIpcAllowed(event.sender?.id, channel)) return;
  throw new Error('应用正在关闭，请稍后重试');
}

function guardedIpcHandler(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    rejectIpcWhileShuttingDown(event, channel);
    return handler(event, ...args);
  });
}

// 导出文件（IPC）
guardedIpcHandler('save-file', async (_e, { content, defaultName }) => {
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
guardedIpcHandler('open-external', (_e, url) => openExternalUrl(url));

guardedIpcHandler('auth:get-session', () => loadSessionToken());
guardedIpcHandler('auth:set-session', (_e, token) => saveSessionToken(token));
guardedIpcHandler('auth:clear-session', () => clearSessionToken());
guardedIpcHandler('account:bootstrap', () => bootstrapAccount());

guardedIpcHandler('get-app-info', () => {
  if (!chatLogPath) chatLogPath = path.join(app.getPath('userData'), 'chat-debug.log');
  return { version: app.getVersion(), chatLogPath, hasApiCredential: Boolean(loadApiKey()) };
});

guardedIpcHandler('check-for-updates', () => checkForUpdates(true));

guardedIpcHandler('install-update', () => {
  if (catalogUpdateUrl) return openExternalUrl(catalogUpdateUrl).then(() => ({ ok: true, external: true }));
  if (!updateReady) return { ok: false, message: '更新包尚未下载完成' };
  autoUpdater.quitAndInstall(false, true);
  return { ok: true };
});

guardedIpcHandler('chat-completion', sendChatCompletion);
guardedIpcHandler('chat-text-completion', sendChatTextCompletion);
guardedIpcHandler('image:capabilities', getImageCapabilities);
guardedIpcHandler('image:generate', generateDesktopImage);
guardedIpcHandler('image:select-edit', selectImageForEdit);
guardedIpcHandler('image:edit', editDesktopImage);
guardedIpcHandler('image:save', saveGeneratedImage);
guardedIpcHandler('chat-image:select', selectChatImageForEdit);
guardedIpcHandler('chat-image:generate', generateChatImage);
guardedIpcHandler('chat-image:edit', editChatImage);
guardedIpcHandler('chat-image:save', saveChatImageAsset);
guardedIpcHandler('generate-pptx', generatePptx);
guardedIpcHandler('open-pptx-for-analysis', openPptxForAnalysis);
guardedIpcHandler('conversations:save', (_e, data) => saveConversation(data));
guardedIpcHandler('conversations:load', (_e, id) => loadConversation(id));
guardedIpcHandler('conversations:list', (_e, options) => listConversations(options));
guardedIpcHandler('conversations:update', (_e, data) => updateConversation(data));
ipcMain.handle('app:quit-flush-ack', (event) => shutdownCoordinator.acknowledge(event.sender?.id));

app.whenReady().then(() => {
  protocol.handle(CHAT_IMAGE_PROTOCOL, serveChatImageAsset);
  setupAutoUpdater();
  createWindow();
  setTimeout(() => checkForUpdates(false), 3000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => shutdownCoordinator.begin(event));

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Deliberately narrow test seam: no credentials, filesystem paths, or Electron handles.
if (process.env.FIFTEENCODE_DESKTOP_TEST === '1') {
  module.exports = {
    createShutdownCoordinator,
    cleanupUnattachedChatImageAssetsNow,
    // Credential helpers are exported only to verify backend selection. Production code
    // never exposes them across IPC and no test helper exposes a real credential.
    hasSecureSafeStorage,
    saveCredential,
    loadCredential,
    clearCredential,
    // Test-only injection for an in-memory node:sqlite database.  It exposes neither
    // userData locations nor credentials and is never exported in production.
    setChatDatabaseForTest: (database) => { chatDatabase = database || null; },
  };
}
