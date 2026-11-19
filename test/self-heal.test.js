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
  assert.strictEqual(producer.consecutiveFailures, 1);
  assert.match(producer.lastError, /browser died/);
  assert.ok(producer.lastErrorAt);

  // --- producer: restart browser sau N loi lien tiep ---
  let relaunched = 0;
  const flaky = new AccountProducer({
    registrar: {
      ensureAlive: async () => {},
      relaunch: async () => { relaunched++; },
      registerOne: async () => { throw new Error('captcha fail'); },
      recyclePage: async () => {},
    },
    db: { save: async () => true },
    mailboxCfg: { provider: 'inboxkitten' },
    restartAfterFailures: 2,
    log: () => {},
  });
  await flaky.step(0);
  await flaky.step(1);
  assert.strictEqual(flaky.consecutiveFailures, 2);
  assert.strictEqual(relaunched, 0);
  await flaky.maybeRestartBrowser();
  assert.strictEqual(relaunched, 1);
  assert.strictEqual(flaky.consecutiveFailures, 0);
  assert.strictEqual(flaky.browserRestarts, 1);

  // --- producer: restart browser dinh ky theo thoi gian ---
  let timed = 0;
  const timedP = new AccountProducer({
    registrar: {
      relaunch: async () => { timed++; },
    },
    db: { save: async () => true },
    mailboxCfg: { provider: 'inboxkitten' },
    restartEveryMs: 1000,
    log: () => {},
  });
  timedP.lastBrowserRestartAt = Date.now() - 5000;
  await timedP.maybeRestartBrowser();
  assert.strictEqual(timed, 1);
  assert.strictEqual(timedP.browserRestarts, 1);
  timedP.lastBrowserRestartAt = Date.now();
  await timedP.maybeRestartBrowser();
  assert.strictEqual(timed, 1);

  console.log('self-heal: OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
