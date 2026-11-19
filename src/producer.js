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
    restartEveryMs = 0,
    restartAfterFailures = 0,
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
    this.restartEveryMs = Math.max(0, Number(restartEveryMs) || 0);
    this.restartAfterFailures = Math.max(0, Number(restartAfterFailures) || 0);
    this.log = log;
    this.running = false;
    this.created = 0;
    this.failed = 0;
    this.skipped = 0;
    this.consecutiveFailures = 0;
    this.lastSkipAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.lastErrorAt = null;
    this.lastBrowserRestartAt = null;
    this.browserRestarts = 0;
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
      this.consecutiveFailures = 0;
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
      this.consecutiveFailures++;
      this.lastError = err.message;
      this.lastErrorAt = new Date().toISOString();
      this.log(`[producer] #${index + 1} that bai (${email}): ${err.message} (lien tiep: ${this.consecutiveFailures})`);
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

  /**
   * Khoi dong lai browser dinh ky hoac sau chuoi loi lien tiep (VD captcha fail lien tuc).
   * Chi thuc hien khi registrar ho tro relaunch va dang o diem an toan giua cac step.
   */
  async maybeRestartBrowser() {
    if (!this.registrar || typeof this.registrar.relaunch !== 'function') return false;
    let reason = null;
    if (this.restartEveryMs > 0 && this.lastBrowserRestartAt) {
      const age = Date.now() - this.lastBrowserRestartAt;
      if (age >= this.restartEveryMs) {
        reason = `dinh ky ${Math.round(age / 60000)}p >= ${Math.round(this.restartEveryMs / 60000)}p`;
      }
    }
    if (!reason && this.restartAfterFailures > 0 && this.consecutiveFailures >= this.restartAfterFailures) {
      reason = `${this.consecutiveFailures} loi lien tiep`;
      // Cho 1 lan thu lai sau restart thay vi restart lien tuc.
      this.consecutiveFailures = 0;
    }
    if (!reason) return false;
    this.log(`[producer] restart browser: ${reason}`);
    await this.registrar.relaunch(this.log, reason);
    this.lastBrowserRestartAt = Date.now();
    this.browserRestarts++;
    return true;
  }

  /** Chay vo han cho den khi goi stop(). Pool chi duoc co toi da maxAccounts. */
  async runForever() {
    this.running = true;
    this.lastBrowserRestartAt = Date.now();
    let index = 0;
    const restartInfo = [];
    if (this.restartEveryMs > 0) restartInfo.push(`moi ${Math.round(this.restartEveryMs / 60000)}p`);
    if (this.restartAfterFailures > 0) restartInfo.push(`sau ${this.restartAfterFailures} loi lien tiep`);
    this.log(`[producer] bat dau (provider=${this.mailboxCfg.provider}, delay=${this.delayMs}ms, jitter=${this.jitterMs}ms, gioi han pool=${this.maxAccounts}, restart browser: ${restartInfo.join(', ') || 'tat'})`);
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
      try {
        await this.maybeRestartBrowser();
      } catch (err) {
        this.log(`[producer] khong restart duoc browser: ${err.message}`);
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
