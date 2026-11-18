'use strict';

const assert = require('assert');
const { VSPhoneRegistrar } = require('../src/registrar');
const { AccountProducer } = require('../src/producer');

(async () => {
  // --- registrar: browser bi crash -> tu launch lai ---
  let launches = 0;
  let contexts = 0;
  const makeContext = () => ({
    addInitScript: async () => {},
    newPage: async () => ({ isClosed: () => false, on: () => {}, off: () => {} }),
    close: async () => {},
  });
  const makeBrowser = (connected) => ({
    isConnected: () => connected,
    close: async () => {},
    newContext: async () => { contexts++; return makeContext(); },
  });
  const reg = Object.create(VSPhoneRegistrar.prototype);
  reg.log = () => {};
  reg.cfg = {};
  reg.browser = makeBrowser(false);
  reg.page = { isClosed: () => true };
  reg.launch = async () => {
    launches++;
    reg.browser = makeBrowser(true);
    return reg._newMainContext();
  };
  assert.strictEqual(reg.isHealthy(), false);
  assert.strictEqual(await reg.ensureAlive(), true);
  assert.strictEqual(launches, 1);
  assert.strictEqual(reg.isHealthy(), true);
  assert.strictEqual(await reg.ensureAlive(), false);
  assert.strictEqual(launches, 1);

  // --- recycle page: mo context moi, khong dong browser ---
  const oldPage = reg.page;
  await reg.recyclePage();
  assert.notStrictEqual(reg.page, oldPage);
  assert.strictEqual(reg.recycleCount, 1);
  assert.strictEqual(contexts, 2);
  assert.strictEqual(launches, 1);

  // --- producer: goi ensureAlive truoc moi step va luu lastError ---
  let checked = 0;
  const producer = new AccountProducer({
    registrar: {
      ensureAlive: async () => { checked++; },
      registerOne: async () => { throw new Error('browser died'); },
    },
    db: { save: async () => true },
    mailboxCfg: { provider: 'inboxkitten' },
    log: () => {},
  });
  const result = await producer.step(0);
  assert.strictEqual(result, null);
  assert.strictEqual(checked, 1);
  assert.strictEqual(producer.failed, 1);
  assert.match(producer.lastError, /browser died/);
  assert.ok(producer.lastErrorAt);

  console.log('self-heal: OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
