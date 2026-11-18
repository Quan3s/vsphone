'use strict';

const assert = require('assert');
const { AccountDB } = require('../src/db');
const { AccountProducer } = require('../src/producer');

(async () => {
  // --- db: lay cu nhat, tuoi >= 5p, con han >= 5p (tuoi <= 25p) ---
  const calls = [];
  const db = new AccountDB({ connectionString: 'postgres://fake', table: 'vsphone_pool' }, () => {});
  db.pool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^DELETE FROM/i.test(sql.trim())) return { rowCount: 0 };
      return {
        rows: [{
          email: 'old@inboxkitten.com',
          password: 'pw',
          token: 't',
          user_id: '1',
          created_at: new Date().toISOString(),
        }],
      };
    },
  };

  const acc = await db.takeOne({ minAgeSeconds: 300, maxAgeSeconds: 1800, minRemainingSeconds: 300 });
  assert.strictEqual(acc.email, 'old@inboxkitten.com');
  const takeQuery = calls.find((c) => /WITH picked AS/i.test(c.sql));
  assert.ok(takeQuery, 'phai co query lay account');
  assert.match(takeQuery.sql, /ORDER BY created_at ASC/);
  assert.deepStrictEqual(takeQuery.params, [300, 1500]);

  // --- stats: them nhom expiring (con han < 5p, chua qua 30p) ---
  const statsDb = new AccountDB({ connectionString: 'postgres://fake' }, () => {});
  statsDb.pool = {
    query: async (sql, params) => {
      assert.deepStrictEqual(params, [300, 1500, 1800]);
      return { rows: [{ total: 10, ready: 5, fresh: 2, expiring: 2, stale: 1 }] };
    },
  };
  const stats = await statsDb.stats({ minAgeSeconds: 300, maxAgeSeconds: 1800, minRemainingSeconds: 300 });
  assert.deepStrictEqual(stats, { total: 10, ready: 5, fresh: 2, expiring: 2, stale: 1 });

  // --- producer: pool day (50) thi khong tao tiep ---
  let producer;
  let countCalls = 0;
  producer = new AccountProducer({
    registrar: {
      ensureAlive: async () => {},
      registerOne: async () => { throw new Error('khong duoc goi khi pool day'); },
    },
    db: {
      count: async () => {
        countCalls++;
        if (countCalls === 2) producer.stop();
        return 50;
      },
    },
    maxAccounts: 50,
    delayMs: 1,
    log: () => {},
  });
  await producer.runForever();
  assert.strictEqual(producer.created, 0);
  assert.strictEqual(producer.skipped, 2);
  assert.ok(producer.lastSkipAt);

  console.log('pool-policy: OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
