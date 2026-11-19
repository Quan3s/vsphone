'use strict';

/**
 * Chay rieng producer 1 luong (khong can API server):
 *   node src/producer-cli.js --delay 15000
 * Tai khoan duoc luu vao PostgreSQL de server /register lay dan.
 */

const fs = require('fs');
const path = require('path');
const { VSPhoneRegistrar } = require('./registrar');
const { AccountDB } = require('./db');
const { AccountProducer } = require('./producer');
const { parseArgs } = require('./util');

const ROOT = path.resolve(__dirname, '..');
const args = parseArgs(process.argv);

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

async function main() {
  const cfg = loadConfig();
  const producerCfg = cfg.server?.producer || {};
  const poolCfg = cfg.server?.pool || {};
  const dbCfg = {
    ...(cfg.database || {}),
    connectionString:
      args['db-url'] || cfg.database?.connectionString || process.env.DATABASE_URL || '',
    table: args['db-table'] || cfg.database?.table || 'vsphone_accounts',
  };
  const db = new AccountDB(dbCfg, console.log);
  await db.connect();

  const registrar = new VSPhoneRegistrar(
    {
      ...cfg,
      headless: true,
      autoCaptcha: cfg.autoCaptcha ?? true,
      mailbox: { ...(cfg.mailbox || {}), provider: 'inboxkitten' },
    },
    console.log,
  );
  await registrar.launch();

  const restartEveryMs = Math.max(0, Number(
    args['restart-every-ms'] ??
    (args['restart-every-minutes'] != null ? Number(args['restart-every-minutes']) * 60000 : null) ??
    producerCfg.restartEveryMs ??
    (producerCfg.restartEveryMinutes != null ? Number(producerCfg.restartEveryMinutes) * 60000 : null) ??
    process.env.BROWSER_RESTART_EVERY_MS ??
    (process.env.BROWSER_RESTART_EVERY_MINUTES != null ? Number(process.env.BROWSER_RESTART_EVERY_MINUTES) * 60000 : null) ??
    7200000
  ) || 0);
  const restartAfterFailures = Math.max(0, Number(
    args['restart-after-failures'] ??
    producerCfg.restartAfterFailures ??
    process.env.BROWSER_RESTART_AFTER_FAILURES ??
    5
  ) || 0);

  const producer = new AccountProducer({
    registrar,
    db,
    mailboxCfg: {
      ...(cfg.mailbox || {}),
      provider: 'inboxkitten',
    },
    delayMs: Number(args.delay ?? producerCfg.delayMs ?? cfg.delayMs ?? 15000),
    jitterMs: Number(args.jitter ?? producerCfg.jitterMs ?? cfg.delayJitterMs ?? 0),
    passwordLength: cfg.passwordLength || 12,
    maxAccounts: Number(args['max-accounts'] ?? poolCfg.maxAccounts ?? 50),
    restartEveryMs,
    restartAfterFailures,
    log: console.log,
  });

  const shutdown = () => {
    console.log('[producer-cli] dang tat...');
    producer.stop();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await producer.runForever();
  } finally {
    await registrar.close();
    await db.close();
  }
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
