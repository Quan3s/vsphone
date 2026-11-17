'use strict';

/**
 * vsphone-register — Pool API server
 *
 * 1) Producer DON LUONG (bat dau cung server):
 *    tao tai khoan bang inboxkitten -> luu PostgreSQL -> nghi 25s -> lap lai.
 *
 * 2) API:
 *    GET/POST /register  (hoac /account, /pool/account)
 *      Header: x-api-key: <key>   hoac   ?apikey=<key>
 *      ?format=raw  -> tra thang chuoi "email|password"
 *
 *    Lay 1 tai khoan DA TAO >= 10p va chua qua 60p, tra ve dang `email|password`,
 *    XOA NGAY account do khoi DB. Account tao > 60p tu dong bi xoa.
 *
 *    GET /health -> trang thai producer + so luong pool.
 *
 * 3) Flag --multi-login (mac dinh tat):
 *    moi account vua duoc API lay se dua vao hang doi; cac browser headless
 *    nhe (it context, chan image/font) login -> logout -> login lai trong
 *    vong 3p de sinh multi-progress.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { VSPhoneRegistrar } = require('./registrar');
const { AccountDB } = require('./db');
const { AccountProducer } = require('./producer');
const { parseArgs, sleep } = require('./util');

const ROOT = path.resolve(__dirname, '..');
const args = parseArgs(process.argv);

function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function parseQuery(url) {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  return Object.fromEntries(new URLSearchParams(url.slice(idx + 1)));
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function isFalse(value) {
  return value === false || value === 'false' || value === '0' || value === 'no';
}

async function main() {
  const cfg = loadConfig();
  const serverCfg = cfg.server || {};

  const port = Number(args.port ?? serverCfg.port ?? process.env.PORT ?? 3000);
  const apiKeys = new Set(
    (serverCfg.apiKeys || [])
      .concat(process.env.API_KEYS ? process.env.API_KEYS.split(',').map((k) => k.trim()) : [])
      .filter(Boolean),
  );
  if (apiKeys.size === 0) {
    console.error('[server] CANH BAO: chua co apiKey — moi request deu bi tu choi');
  }

  // ---- pool: tuoi toi thieu / toi da (phut) ----
  const minAge = Math.max(0, Number(args['pool-min'] ?? serverCfg.pool?.minAgeMinutes ?? 10));
  const maxAge = Math.max(minAge, Number(args['pool-max'] ?? serverCfg.pool?.maxAgeMinutes ?? 60));

  // ---- producer (1 luong) ----
  const producerEnabled =
    args['no-producer'] !== undefined && !isFalse(args['no-producer'])
      ? false
      : args.producer !== undefined
        ? !isFalse(args.producer)
        : (serverCfg.producer?.enabled ?? true);
  const producerDelay = Number(args['producer-delay'] ?? serverCfg.producer?.delayMs ?? cfg.delayMs ?? 25000);
  const producerJitter = Number(args['producer-jitter'] ?? serverCfg.producer?.jitterMs ?? 0);
  const mailboxProvider = args.provider || serverCfg.producer?.mailbox?.provider || 'inboxkitten';

  // ---- multi-login warmup (flag, mac dinh tat) ----
  const multiLogin = args['multi-login'] !== undefined
    ? !isFalse(args['multi-login'])
    : !!(serverCfg.multiLogin?.enabled ?? false);
  const loginWorkers = Math.max(1, Number(args['login-workers'] ?? serverCfg.multiLogin?.workers ?? 2));
  const loginWindowMs = Number(args['login-window'] ?? serverCfg.multiLogin?.windowMs ?? 180000);
  let shuttingDown = false;

  // ---- PostgreSQL ----
  const dbCfg = {
    ...(cfg.database || {}),
    connectionString:
      args['db-url'] || cfg.database?.connectionString || process.env.DATABASE_URL || '',
    table: args['db-table'] || cfg.database?.table || 'vsphone_accounts',
  };
  const db = new AccountDB(dbCfg, console.log);
  await db.connect();

  // ---- browser cho producer (headless bat buoc) ----
  const regCfg = {
    ...cfg,
    headless: true,
    autoCaptcha: cfg.autoCaptcha ?? true,
    mailbox: { ...(cfg.mailbox || {}), provider: mailboxProvider },
  };
  const registrar = new VSPhoneRegistrar(regCfg, console.log);
  await registrar.launch();

  const producer = new AccountProducer({
    registrar,
    db,
    mailboxCfg: { ...regCfg.mailbox, provider: 'inboxkitten' },
    delayMs: producerDelay,
    jitterMs: producerJitter,
    passwordLength: cfg.passwordLength || 12,
    log: console.log,
  });
  // ---- hang doi warmup: login -> logout -> login lai trong vong 3p ----
  const warmupQueue = [];
  function enqueueWarmup(account) {
    if (!multiLogin) return;
    warmupQueue.push({
      account: { email: account.email, password: account.password },
      expiresAt: Date.now() + loginWindowMs,
    });
    console.log(`[warmup] xep hang ${account.email} (han ${Math.round(loginWindowMs / 1000)}s, hang doi: ${warmupQueue.length})`);
  }

  async function loginWorker(id) {
    console.log(`[warmup] worker ${id} san sang`);
    while (!shuttingDown) {
      const job = warmupQueue.shift();
      if (!job) {
        await sleep(1000);
        continue;
      }
      if (Date.now() > job.expiresAt) {
        console.log(`[warmup] worker ${id}: bo qua ${job.account.email} (qua han 3p)`);
        continue;
      }
      let session = null;
      try {
        session = await registrar.newLightSession(console.log);
        const first = await session.loginExisting(job.account, {
          timeoutMs: Math.min(120000, Math.max(1000, job.expiresAt - Date.now())),
        });
        console.log(`[warmup] worker ${id}: login 1 ${job.account.email} ok (code=${first.apiCode})`);
        await session.logout();
        const second = await session.loginExisting(job.account, {
          timeoutMs: Math.min(120000, Math.max(1000, job.expiresAt - Date.now())),
        });
        console.log(`[warmup] worker ${id}: login 2 ${job.account.email} ok (code=${second.apiCode}) — multi-progress`);
      } catch (err) {
        console.error(`[warmup] worker ${id} loi (${job.account.email}): ${err.message}`);
      } finally {
        if (session) await session.closeContext();
      }
    }
    console.log(`[warmup] worker ${id} da dung`);
  }

  // ---- HTTP server ----
  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    const query = parseQuery(url);
    const pathname = url.split('?')[0];

    try {
      if (pathname === '/health' || pathname === '/ping') {
        return send(res, 200, {
          ok: true,
          producer: producerEnabled
            ? { running: producer.running, created: producer.created, failed: producer.failed }
            : 'off',
          warmup: { enabled: multiLogin, queued: warmupQueue.length },
          pool: await db.stats({ minAgeMinutes: minAge, maxAgeMinutes: maxAge }),
        });
      }

      if (!['/register', '/account', '/pool/account'].includes(pathname)) {
        return send(res, 404, { ok: false, error: 'not found' });
      }

      const key = req.headers['x-api-key'] || query.apikey || query.apiKey || '';
      if (apiKeys.size > 0 && !apiKeys.has(key)) {
        return send(res, 401, { ok: false, error: 'invalid api key' });
      }

      const account = await db.takeOne({ minAgeMinutes: minAge, maxAgeMinutes: maxAge });
      if (!account) {
        return send(res, 503, {
          ok: false,
          error: `chua co tai khoan tuoi ${minAge}-${maxAge}p trong pool`,
          pool: await db.stats({ minAgeMinutes: minAge, maxAgeMinutes: maxAge }),
        });
      }

      enqueueWarmup(account);
      const pair = `${account.email}|${account.password}`;
      if (query.format === 'raw' || query.raw === '1') {
        return sendText(res, 200, pair + '\n');
      }
      return send(res, 200, {
        ok: true,
        account: pair,
        email: account.email,
        password: account.password,
        token: account.token,
        userId: account.userId,
        createdAt: account.createdAt,
      });
    } catch (err) {
      console.error('[server] loi:', err.message);
      return send(res, 500, { ok: false, error: err.message });
    }
  });

  server.listen(port, () => {
    console.log(`[server] lang nghe port ${port}`);
    console.log(`[server] GET/POST /register | ?apikey=<key> | x-api-key header | ?format=raw`);
    console.log(`[server] pool: lay account tuoi ${minAge}-${maxAge}p, xoa >${maxAge}p, xoa ngay sau khi lay`);
    console.log(`[server] producer: ${producerEnabled ? `bat (inboxkitten, nghi ${producerDelay}ms)` : 'tat (--no-producer)'}`);
    console.log(`[server] multi-login: ${multiLogin ? `bat (${loginWorkers} worker, han ${loginWindowMs}ms)` : 'tat (them --multi-login de bat)'}`);
  });

  // Dinh ky don dep account qua lu ngay ca khi khong co request nao.
  const cleanupTimer = setInterval(() => {
    db.cleanupStale(maxAge).catch((err) => console.error('[db] cleanup loi:', err.message));
  }, 60000);
  cleanupTimer.unref();

  if (producerEnabled) {
    producer.runForever().catch((err) => console.error('[producer] fatal:', err.message));
  }
  const workers = multiLogin ? Array.from({ length: loginWorkers }, (_, i) => loginWorker(i + 1)) : [];

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[server] dang tat...');
    producer.stop();
    clearInterval(cleanupTimer);
    server.close();
    registrar.close()
      .then(() => db.close())
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
