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
    this.log = log;
    this.running = false;
    this.created = 0;
    this.failed = 0;
    this.onAccount = null;
  }

  /** Tao 1 tai khoan va luu vao DB. Tra ve account hoac null neu that bai. */
  async step(index = 0) {
    const mailbox = createMailbox({ ...this.mailboxCfg }, this.log);
    let email = mailbox.address || '(chua co email)';
    try {
      const created = await mailbox.create();
      email = created.address || email;
      const password = genPassword(this.passwordLength);
      const account = await this.registrar.registerOne({ email, password, mailbox });
      await this.db.save(account);
      this.created++;
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
      this.log(`[producer] #${index + 1} that bai (${email}): ${err.message}`);
      return null;
    }
  }

  /** Chay vo han cho den khi goi stop(). */
  async runForever() {
    this.running = true;
    let index = 0;
    this.log(`[producer] bat dau (provider=${this.mailboxCfg.provider}, delay=${this.delayMs}ms, jitter=${this.jitterMs}ms)`);
    while (this.running) {
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
