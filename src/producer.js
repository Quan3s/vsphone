'use strict';

/**
 * Producer DON LUONG: tao tai khoan -> luu PostgreSQL -> nghi 15s -> tao tiep.
 * Mac dinh dung inboxkitten de lay ma xac thuc.
 */

const { createMailbox } = require('./mailbox');
const { genPassword, sleep } = require('./util');

class AccountProducer {
  constructor({
    registrar,
    db,
    mailboxCfg = {},
    delayMs = 15000,
    jitterMs = 0,
    passwordLength = 12,
    maxAccounts = 50,
    log = console.log,
  } = {}) {
    this.registrar = registrar;
    this.db = db;
    this.mailboxCfg = {
      ...mailboxCfg,
      provider: mailboxCfg.provider || 'inboxkitten',
    };
    this.delayMs = Math.max(0, Number(delayMs) || 0);
    this.jitterMs = Math.max(0, Number(jitterMs) || 0);
    this.passwordLength = passwordLength;
    this.maxAccounts = Math.max(1, Number(maxAccounts) || 50);
    this.log = log;
    this.running = false;
    this.created = 0;
    this.failed = 0;
    this.skipped = 0;
    this.lastSkipAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.lastErrorAt = null;
    this.onAccount = null;
  }

  /** Tao 1 tai khoan va luu vao DB. Tra ve account hoac null neu that bai. */
  async step(index = 0) {
    const mailbox = createMailbox({ ...this.mailboxCfg }, this.log);
    let email = mailbox.address || '(chua co email)';
    try {
      // Chromium co the crash (OOM / /dev/shm nho) trong luc server chay lien tuc.
      // Kiem tra va launch lai truoc moi lan tao tai khoan de khong fail hang loat.
      if (this.registrar && typeof this.registrar.ensureAlive === 'function') {
        await this.registrar.ensureAlive(this.log);
      }
      const created = await mailbox.create();
      email = created.address || email;
      const password = genPassword(this.passwordLength);
      const account = await this.registrar.registerOne({ email, password, mailbox });
      await this.db.save(account);
      this.created++;
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = null;
      this.lastErrorAt = null;
      this.log(`[producer] #${index + 1} xong ${email} | tong thanh cong: ${this.created}`);
      if (this.onAccount) {
        try {
          await this.onAccount(account);
        } catch (_) {
          /* callback khong duoc lam producer dung lai */
        }
      }
      return account;
    } catch (err) {
      this.failed++;
      this.lastError = err.message;
      this.lastErrorAt = new Date().toISOString();
      this.log(`[producer] #${index + 1} that bai (${email}): ${err.message}`);
      return null;
    } finally {
      // OOM defense: dong context/page cu, mo context moi sau MOI account.
      // Browser duoc giu lai nen warmup worker khong bi anh huong.
      if (this.registrar && typeof this.registrar.recyclePage === 'function') {
        try {
          await this.registrar.recyclePage();
        } catch (err) {
          this.log(`[producer] khong recycle duoc page: ${err.message}`);
        }
      }
    }
  }

  /** So account hien co trong pool (khong tinh account dang duoc tao). */
  async poolSize() {
    if (!this.db || typeof this.db.count !== 'function') return 0;
    try {
      return Number(await this.db.count()) || 0;
    } catch (err) {
      this.log(`[producer] khong doc duoc so luong pool: ${err.message}`);
      return 0;
    }
  }

  /** Chay vo han cho den khi goi stop(). Pool chi duoc co toi da maxAccounts. */
  async runForever() {
    this.running = true;
    let index = 0;
    this.log(`[producer] bat dau (provider=${this.mailboxCfg.provider}, delay=${this.delayMs}ms, jitter=${this.jitterMs}ms, gioi han pool=${this.maxAccounts})`);
    while (this.running) {
      const total = await this.poolSize();
      if (total >= this.maxAccounts) {
        this.skipped++;
        this.lastSkipAt = new Date().toISOString();
        this.log(`[producer] pool day ${total}/${this.maxAccounts} - tam dung, doi API lay mat account roi tao tiep`);
        // Khong tao khi da day; kiem tra lai nhanh de phan ung ngay khi pool giam.
        await sleep(Math.min(5000, Math.max(1000, this.delayMs)));
        continue;
      }
      await this.step(index++);
      if (!this.running) break;
      const wait = this.delayMs + Math.floor(Math.random() * this.jitterMs);
      if (wait > 0) {
        this.log(`[producer] nghi ${Math.round(wait / 1000)}s truoc tai khoan tiep theo...`);
        await sleep(wait);
      }
    }
    this.log('[producer] da dung');
  }

  stop() {
    this.running = false;
  }
}

module.exports = { AccountProducer };
