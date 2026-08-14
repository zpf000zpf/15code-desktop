#!/usr/bin/env node
'use strict';

// This test intentionally loads the main process with a small Electron mock.  It covers
// the shutdown contract without launching Chromium (whose local sandbox ownership is not
// a product requirement and must never be bypassed with --no-sandbox).
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { finalizeImageOperation } = require('../src/chat-image-state.js');

const registeredHandlers = new Map();
const appHandlers = new Map();
const electronMock = {
  app: {
    getPath: () => os.tmpdir(),
    getVersion: () => 'test',
    whenReady: () => ({ then: () => {} }),
    on: (event, handler) => appHandlers.set(event, handler),
    exit: () => {},
    quit: () => {},
  },
  BrowserWindow: {
    getAllWindows: () => [],
    getFocusedWindow: () => null,
  },
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
  shell: { openExternal: async () => {} },
  dialog: {},
  ipcMain: { handle: (channel, handler) => registeredHandlers.set(channel, handler) },
  safeStorage: { isEncryptionAvailable: () => false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
};

function loadTestExports() {
  const originalLoad = Module._load;
  Module._load = function mockElectron(request, parent, isMain) {
    if (request === 'electron') return electronMock;
    if (request === 'electron-updater') return { autoUpdater: { on: () => {}, checkForUpdates: async () => {}, quitAndInstall: () => {} } };
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.FIFTEENCODE_DESKTOP_TEST = '1';
  const mainPath = path.resolve(__dirname, '../src/main.js');
  delete require.cache[mainPath];
  try { return require(mainPath); }
  finally {
    Module._load = originalLoad;
    delete process.env.FIFTEENCODE_DESKTOP_TEST;
  }
}

const waitForAsyncWork = () => new Promise(resolve => setImmediate(resolve));

async function testAcknowledgedShutdown(createShutdownCoordinator) {
  const events = [];
  const sent = [];
  let timeoutCallback;
  let timeoutCleared = false;
  const coordinator = createShutdownCoordinator({
    getWindows: () => [{ webContents: { id: 7, send: channel => sent.push(channel) } }],
    cleanupUnattachedAssetsNow: async () => events.push('cleanup'),
    closeDatabase: async () => events.push('close'),
    exitApp: code => events.push(`exit:${code}`),
    setTimeoutFn: callback => { timeoutCallback = callback; return 1; },
    clearTimeoutFn: () => { timeoutCleared = true; },
  });
  let prevented = false;
  coordinator.begin({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(sent, ['app:prepare-to-quit']);
  assert.equal(typeof timeoutCallback, 'function');
  assert.equal(coordinator.isIpcAllowed(7, 'conversations:save'), true);
  assert.equal(coordinator.isIpcAllowed(7, 'chat-image:generate'), false);
  assert.deepEqual(coordinator.acknowledge(7), { ok: true });
  await waitForAsyncWork();
  assert.deepEqual(events, ['close', 'exit:0']);
  assert.equal(timeoutCleared, true);
  assert.deepEqual(coordinator.acknowledge(7), { ok: false });
}

async function testTimedOutShutdown(createShutdownCoordinator) {
  const events = [];
  let timeoutCallback;
  const coordinator = createShutdownCoordinator({
    getWindows: () => [{ webContents: { id: 9, send: () => {} } }],
    cleanupUnattachedAssetsNow: async () => {
      events.push('cleanup:start');
      await Promise.resolve();
      events.push('cleanup:end');
    },
    closeDatabase: async () => events.push('close'),
    exitApp: code => events.push(`exit:${code}`),
    setTimeoutFn: callback => { timeoutCallback = callback; return 1; },
    clearTimeoutFn: () => {},
  });
  coordinator.begin({ preventDefault: () => {} });
  assert.equal(typeof timeoutCallback, 'function');
  timeoutCallback();
  await waitForAsyncWork();
  assert.deepEqual(events, ['cleanup:start', 'cleanup:end', 'close', 'exit:0']);
}

async function testImmediateOrphanCleanup(cleanupUnattachedChatImageAssetsNow, setChatDatabaseForTest) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, client_id TEXT);
    CREATE TABLE image_assets (
      asset_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_key TEXT,
      storage_key TEXT NOT NULL, mime TEXT NOT NULL, byte_size INTEGER NOT NULL,
      format TEXT NOT NULL, operation TEXT NOT NULL, source_asset_id TEXT, prompt TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  const attached = '11111111-1111-4111-8111-111111111111';
  const orphan = '22222222-2222-4222-8222-222222222222';
  db.prepare('INSERT INTO messages(conversation_id,client_id) VALUES (?,?)').run('conversation', 'attached-message');
  const insert = db.prepare(`INSERT INTO image_assets
    (asset_id,conversation_id,message_key,storage_key,mime,byte_size,format,operation,prompt,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run(attached, 'conversation', 'attached-message', `${attached}.png`, 'image/png', 8, 'png', 'generate', '', 1, 1);
  insert.run(orphan, 'conversation', 'orphan-message', `${orphan}.png`, 'image/png', 8, 'png', 'generate', '', 1, 1);
  setChatDatabaseForTest(db);
  try {
    assert.deepEqual(await cleanupUnattachedChatImageAssetsNow(), [orphan]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM image_assets WHERE asset_id = ?').get(attached).count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM image_assets WHERE asset_id = ?').get(orphan).count, 0);
  } finally {
    setChatDatabaseForTest(null);
    db.close();
  }
}

function image(status, error = null) {
  return { assetId: '11111111-1111-4111-8111-111111111111', operation: 'generate', status, error };
}

function testImageOperationStaysWithOriginalConversation() {
  const newConversationMessages = [{ id: 'new-text', role: 'user', content: '新会话内容' }];
  for (const finishedImage of [image('complete'), image('error', '服务不可用')]) {
    const operationMessages = [
      { id: 'prompt', role: 'user', content: '画一只猫' },
      { id: 'image-message', role: 'assistant', type: 'image', content: '', image: { ...finishedImage } },
    ];
    const finalized = finalizeImageOperation({
      operationConversationId: 'original', imageMessageId: 'image-message', operationMessages,
      operationModel: 'model-original', finishedImage, currentConversationId: 'new-conversation',
      currentMessages: newConversationMessages, currentModel: 'model-new', currentDraft: '新会话草稿',
    });
    assert.equal(finalized.stillCurrentConversation, false);
    assert.equal(finalized.snapshot.id, 'original');
    assert.equal(finalized.snapshot.model, 'model-original');
    assert.equal(finalized.snapshot.draft, '');
    assert.equal(finalized.snapshot.messages.length, operationMessages.length);
    assert.deepEqual(finalized.snapshot.messages.find(message => message.id === 'image-message').image, finishedImage);
    assert.deepEqual(newConversationMessages, [{ id: 'new-text', role: 'user', content: '新会话内容' }]);
  }
}

function testReturnedConversationMergesResultWithoutOverwritingNewState() {
  for (const finishedImage of [image('complete'), image('error', '服务不可用')]) {
    const operationMessages = [
      { id: 'prompt', role: 'user', content: '画一只猫' },
      { id: 'image-message', role: 'assistant', type: 'image', content: '', image: { ...finishedImage } },
    ];
    const reopenedMessages = [
      { id: 'prompt', role: 'user', content: '画一只猫' },
      { id: 'image-message', role: 'assistant', type: 'image', content: '', image: image('pending') },
      { id: 'later-text', role: 'user', content: '返回后新增文本' },
    ];
    const finalized = finalizeImageOperation({
      operationConversationId: 'original', imageMessageId: 'image-message', operationMessages,
      operationModel: 'model-original', finishedImage, currentConversationId: 'original',
      currentMessages: reopenedMessages, currentModel: 'model-returned', currentDraft: '返回后草稿',
    });
    assert.equal(finalized.stillCurrentConversation, true);
    assert.equal(finalized.snapshot.id, 'original');
    assert.equal(finalized.snapshot.model, 'model-returned');
    assert.equal(finalized.snapshot.draft, '返回后草稿');
    assert.equal(finalized.snapshot.messages.at(-1).content, '返回后新增文本');
    assert.deepEqual(finalized.snapshot.messages.find(message => message.id === 'image-message').image, finishedImage);
    assert.equal(reopenedMessages.find(message => message.id === 'image-message').image.status, 'pending');
  }
}

(async () => {
  const { createShutdownCoordinator, cleanupUnattachedChatImageAssetsNow, setChatDatabaseForTest } = loadTestExports();
  assert.equal(typeof createShutdownCoordinator, 'function');
  await testAcknowledgedShutdown(createShutdownCoordinator);
  await testTimedOutShutdown(createShutdownCoordinator);
  await testImmediateOrphanCleanup(cleanupUnattachedChatImageAssetsNow, setChatDatabaseForTest);
  testImageOperationStaysWithOriginalConversation();
  testReturnedConversationMergesResultWithoutOverwritingNewState();
  console.log('Chat image shutdown persistence tests passed');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
