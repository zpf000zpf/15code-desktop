#!/usr/bin/env node
'use strict';

// Exercises only the main-process storage seam. It intentionally never starts Electron
// or invokes a real keyring, so no real account credential can enter the test process.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), '15code-session-storage-'));
const electronMock = {
  app: {
    getPath: () => userData,
    getVersion: () => 'test',
    whenReady: () => ({ then: () => {} }),
    on: () => {}, exit: () => {}, quit: () => {},
  },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
  shell: { openExternal: async () => {} }, dialog: {},
  ipcMain: { handle: () => {} },
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

function createSecretTool() {
  const secrets = new Map();
  const calls = [];
  const keyFor = args => args.slice(-4).join(':');
  return {
    calls,
    run(args, input) {
      calls.push({ args, input });
      const operation = args[0];
      const key = keyFor(args);
      if (operation === 'store') { secrets.set(key, input); return { status: 0, stdout: '' }; }
      if (operation === 'lookup') {
        return secrets.has(key) ? { status: 0, stdout: secrets.get(key) + '\n' } : { status: 1, stdout: '' };
      }
      if (operation === 'clear') { secrets.delete(key); return { status: 0, stdout: '' }; }
      throw new Error(`unexpected secret-tool operation: ${operation}`);
    },
  };
}

try {
  const { hasSecureSafeStorage, saveCredential, loadCredential, clearCredential } = loadTestExports();
  const session = 'linux-session-token-0123456789';
  const sessionPath = path.join(userData, 'session-token.bin');
  const basicText = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'basic_text',
  };
  const secretTool = createSecretTool();

  assert.equal(hasSecureSafeStorage(basicText, 'linux'), false, 'basic_text must never be treated as encrypted');
  assert.deepEqual(saveCredential('session-token', session, basicText, 'linux', secretTool.run), {
    persisted: true, storage: 'secret-service',
  });
  assert.equal(fs.existsSync(sessionPath), false, 'Linux fallback must not create a session-token file');
  assert.equal(loadCredential('session-token', basicText, 'linux', secretTool.run), session);
  assert.ok(secretTool.calls.every(call => !call.args.includes(session)), 'secret must not be passed as a command-line argument');
  clearCredential('session-token', 'linux', secretTool.run);
  assert.equal(loadCredential('session-token', basicText, 'linux', secretTool.run), null);
  assert.deepEqual(saveCredential('session-token', session, basicText, 'linux', () => ({
    error: new Error('Secret Service unavailable'), status: null,
  })), { persisted: false, storage: 'memory' });
  assert.equal(fs.existsSync(sessionPath), false, 'unavailable keyring must not fall back to a file');

  const windowsSession = 'windows-session-token-0123456789';
  const dpapi = {
    isEncryptionAvailable: () => true,
    encryptString: () => Buffer.from('opaque-dpapi-ciphertext'),
    decryptString: value => {
      assert.equal(value.toString(), 'opaque-dpapi-ciphertext');
      return windowsSession;
    },
  };
  assert.equal(hasSecureSafeStorage(dpapi, 'win32'), true, 'Windows must retain safeStorage/DPAPI');
  assert.deepEqual(saveCredential('session-token', windowsSession, dpapi, 'win32', () => {
    throw new Error('Windows must not invoke secret-tool');
  }), { persisted: true, storage: 'safeStorage' });
  assert.equal(fs.readFileSync(sessionPath).toString(), 'opaque-dpapi-ciphertext');
  assert.equal(loadCredential('session-token', dpapi, 'win32'), windowsSession);
  clearCredential('session-token', 'win32');
  assert.equal(fs.existsSync(sessionPath), false);

  console.log('Secure session storage tests passed');
} finally {
  fs.rmSync(userData, { recursive: true, force: true });
}
