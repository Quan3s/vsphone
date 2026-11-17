'use strict';

/**
 * Pool tai khoan VSPhone tren PostgreSQL.
 *
 * - Producer luu tai khoan vao day sau khi tao xong (created_at = luc luu).
 * - API lay 1 tai khoan co tuoi [minAgeMinutes, maxAgeMinutes] va XOA NO LUON.
 * - Tai khoan qua han (> maxAgeMinutes) bi xoá dinh ky / moi lan goi API.
 */

function loadPg() {
  try {
    return require('pg');
  } catch (_) {
    throw new Error('Thieu module "pg". Chay: npm install pg');
  }
}

class AccountDB {
  constructor({ connectionString, table = 'vsphone_accounts', log = console.log } = {}) {
    this.connectionString = connectionString || process.env.DATABASE_URL || '';
    this.table = table;
    // Quote ten bang de tranh loi voi ten co ky tu dac biet / SQL injection tu config.
    this.qTable = `"${String(table).replace(/"/g, '""')}"`;
    this.log = log;
    this.pool = null;
  }

  get enabled() {
    return !!this.connectionString;
  }

  async connect() {
    if (!this.enabled) throw new Error('Chua cau hinh DATABASE_URL / database.connectionString');
    const { Pool } = loadPg();
    this.pool = new Pool({
      connectionString: this.connectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });
    await this.pool.query(`SELECT 1`);
    await this.createTable();
    this.log(`[db] da ket noi PostgreSQL, bang "${this.table}" san sang`);
    return this;
  }

  async createTable() {
    const sql = `
      CREATE TABLE IF NOT EXISTS ${this.qTable} (
        id          BIGSERIAL PRIMARY KEY,
        email       TEXT NOT NULL UNIQUE,
        password    TEXT,
        token       TEXT,
        user_id     BIGINT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await this.pool.query(sql);
    const idx = `"${String(this.table).replace(/"/g, '""')}_created_at_idx"`;
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${idx} ON ${this.qTable} (created_at)`);
  }

  /** Luu 1 tai khoan moi vao pool. created_at = thoi diem tao xong. */
  async save(account) {
    if (!this.pool) return false;
    const q = `
      INSERT INTO ${this.qTable} (email, password, token, user_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (email) DO UPDATE SET
        password   = EXCLUDED.password,
        token      = EXCLUDED.token,
        user_id    = EXCLUDED.user_id,
        created_at = NOW(),
        updated_at = NOW()
      RETURNING id`;
    const uid = account.userId === null || account.userId === undefined ? null : Number(account.userId);
    const { rows } = await this.pool.query(q, [
      account.email,
      account.password || null,
      account.token || null,
      uid !== null && Number.isFinite(uid) ? uid : null,
    ]);
    this.log(`[db] da them ${account.email} vao pool (id=${rows[0] ? rows[0].id : '?'})`);
    return true;
  }

  /** Xoá cac tai khoan duoc tao qua lu (>= maxAgeMinutes p). */
  async cleanupStale(maxAgeMinutes = 60) {
    if (!this.pool) return 0;
    const { rowCount } = await this.pool.query(
      `DELETE FROM ${this.qTable} WHERE created_at < NOW() - (($1::int) || ' minutes')::interval`,
      [maxAgeMinutes],
    );
    if (rowCount > 0) this.log(`[db] da xoá ${rowCount} tai khoan qua lu (>${maxAgeMinutes}p)`);
    return rowCount;
  }

  /**
   * Lay 1 tai khoan da tao >= minAgeMinutes va chua qua maxAgeMinutes,
   * ROI XOA NGAY KHOI DB (ngan 2 API call lay cung 1 account).
   * Tra ve null neu pool chua co account nao đu dieu kien.
   */
  async takeOne({ minAgeMinutes = 10, maxAgeMinutes = 60 } = {}) {
    if (!this.pool) return null;
    await this.cleanupStale(maxAgeMinutes);
    const q = `
      WITH picked AS (
        SELECT id, email, password, token, user_id, created_at
        FROM ${this.qTable}
        WHERE created_at <= NOW() - (($1::int) || ' minutes')::interval
          AND created_at >= NOW() - (($2::int) || ' minutes')::interval
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      DELETE FROM ${this.qTable} AS t
      USING picked AS p
      WHERE t.id = p.id
      RETURNING p.email AS email, p.password AS password, p.token AS token,
                p.user_id AS user_id, p.created_at AS created_at`;
    const { rows } = await this.pool.query(q, [minAgeMinutes, maxAgeMinutes]);
    if (!rows.length) return null;
    const row = rows[0];
    this.log(`[db] da lay va xoa ${row.email} khoi pool (createdAt=${row.created_at})`);
    return {
      email: row.email,
      password: row.password || '',
      token: row.token || null,
      userId: row.user_id === null ? null : String(row.user_id),
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  }

  /** Thong ke pool: tong so, so san sang, so qua lu, so con qua moi. */
  async stats({ minAgeMinutes = 10, maxAgeMinutes = 60 } = {}) {
    if (!this.pool) return { total: 0, ready: 0, fresh: 0, stale: 0 };
    const { rows } = await this.pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (
           WHERE created_at <= NOW() - (($1::int) || ' minutes')::interval
             AND created_at >= NOW() - (($2::int) || ' minutes')::interval
         )::int AS ready,
         COUNT(*) FILTER (
           WHERE created_at > NOW() - (($1::int) || ' minutes')::interval
         )::int AS fresh,
         COUNT(*) FILTER (
           WHERE created_at < NOW() - (($2::int) || ' minutes')::interval
         )::int AS stale
       FROM ${this.qTable}`,
      [minAgeMinutes, maxAgeMinutes],
    );
    const r = rows[0] || {};
    return {
      total: r.total || 0,
      ready: r.ready || 0,
      fresh: r.fresh || 0,
      stale: r.stale || 0,
    };
  }

  async count() {
    if (!this.pool) return 0;
    const { rows } = await this.pool.query(`SELECT COUNT(*)::int AS n FROM ${this.qTable}`);
    return rows[0] ? rows[0].n : 0;
  }

  async close() {
    try {
      if (this.pool) await this.pool.end();
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = { AccountDB };
