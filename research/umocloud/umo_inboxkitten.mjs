#!/usr/bin/env node
/**
 * UMOCloud (willclouds OEM, clientCode=ae02b) register/login via email OTP
 * using inboxkitten.com as tempmail (instead of mail.tm to avoid rate limits).
 *
 * Usage:
 *   node /tmp/umo_inboxkitten.mjs
 *
 * Notes:
 * - InboxKitten inboxes are public and auto-delete after some hours.
 * - If server returns NEED_CAPTCHA (1009000004) or UI requires captcha,
 *   implement solveCaptcha() / fetch captcha via get-captcha and pass `captcha`.
 */
import crypto from 'node:crypto';

const CONFIG = {
  clientCode: 'ae02b',
  baseApi: 'https://oem-api.willclouds.com',
  baseCore: 'https://oem-core.willclouds.com', // isCore endpoints (login, get-experience-qual)
  tenantId: '242',
  clientBrandId: '108',
  signatureSalt: '4d9cbb6b585448419578a95954a2b886',
  chnl: 'h5_cphone',
  cid: '50000',
  cver: '1001021',
  locale: 'en-US',
  clientType: 'h5',
  inboxDomain: 'inboxkitten.com',
  inboxApi: 'https://inboxkitten.com/api/v1/mail',
};

const NEED_CAPTCHA = 1009000004;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomLocalPart(prefix = 'umo') {
  return `${prefix}${crypto.randomBytes(5).toString('hex')}${Date.now().toString(36).slice(-4)}`;
}

function javaURLEncode(s) {
  const bytes = Buffer.from(String(s), 'utf8');
  let out = '';
  for (const b of bytes) {
    if (b === 32) out += '+';
    else if ((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 45 || b === 46 || b === 95 || b === 42) {
      out += String.fromCharCode(b);
    } else {
      out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

function objectToQueryString(obj) {
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  return keys.map((k) => `${javaURLEncode(k)}=${javaURLEncode(obj[k])}`).join('&');
}

function signParams(params, salt = CONFIG.signatureSalt) {
  const b = objectToQueryString(params);
  const w = crypto.createHash('md5').update(b + salt, 'utf8').digest('hex');
  return w.slice(4, 20);
}

function commonParams(userId = '', cuidExtra = '') {
  const ts = Date.now().toString();
  const cuid = ts + Math.floor(1000000 + Math.random() * 9000000).toString() + CONFIG.clientCode;
  return {
    cuid,
    ts,
    userId: String(userId || ''),
    cid: CONFIG.cid,
    chnl: CONFIG.chnl,
    cver: CONFIG.cver,
    locale: CONFIG.locale,
    clientType: CONFIG.clientType,
  };
}

async function saasRequest(path, data, { core = false, token = null, userId = '' } = {}) {
  const base = core ? CONFIG.baseCore : CONFIG.baseApi;
  const params = { ...commonParams(userId), ...data };
  const xSignature = signParams(params);
  const headers = {
    'x-signature': xSignature,
    'content-type': 'application/x-www-form-urlencoded',
    'tenant-id': CONFIG.tenantId,
    'client-brand-id': CONFIG.clientBrandId,
    timezone: 'Asia/Saigon',
    'accept-language': CONFIG.locale,
    origin: 'https://h5.willclouds.com',
    referer: 'https://h5.willclouds.com/',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const body = objectToQueryString(params);
  const res = await fetch(base + path, { method: 'POST', headers, body });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json, headers: Object.fromEntries(res.headers.entries()) };
}

// ---- inboxkitten ----
function makeInboxKittenEmail(localPart) {
  return `${localPart}@${CONFIG.inboxDomain}`;
}

async function inboxList(localPart) {
  const url = `${CONFIG.inboxApi}/list?recipient=${encodeURIComponent(localPart)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`inboxkitten list ${res.status}`);
  return res.json();
}

async function inboxGetHtml(storage) {
  const url = `${CONFIG.inboxApi}/getHtml?region=${encodeURIComponent(storage.region)}&key=${encodeURIComponent(storage.key)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`inboxkitten getHtml ${res.status}`);
  return res.text();
}

function extractOtpFromText(text) {
  if (!text) return null;
  const m = String(text).match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}

async function waitForOtp(localPart, { timeoutMs = 180000, pollMs = 4000, knownIds = new Set() } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let msgs = [];
    try { msgs = await inboxList(localPart); } catch (e) { /* retry */ }
    for (const msg of msgs) {
      const id = msg?.storage?.key || msg?.id;
      if (id && knownIds.has(id)) continue;
      const storage = msg?.storage;
      if (!storage?.region || !storage?.key) continue;
      try {
        const html = await inboxGetHtml(storage);
        const subject = msg?.message?.headers?.subject || '';
        const otp = extractOtpFromText(subject + '\n' + html.replace(/<[^>]+>/g, ' '));
        if (otp) return { otp, msg, html };
      } catch {}
      if (id) knownIds.add(id);
    }
    await sleep(pollMs);
  }
  throw new Error('OTP timeout (inboxkitten)');
}

// ---- captcha hook ----
async function solveCaptcha(/* context */) {
  // TODO: implement custom solver. When you get image/challenge from
  // POST /saas-api/cloud-client/auth/get-captcha, solve and return string.
  // Return '' if not required.
  return '';
}

async function sendVerificationCode(email, captcha = '') {
  return saasRequest('/saas-api/cloud-client/auth/send-verification-code', {
    account: email,
    accountType: 'mail',
    scene: '1',
    captcha,
  });
}

async function loginMailCode(email, otp, captcha = '') {
  return saasRequest('/saas-api/cloud-client/auth/login', {
    loginType: 'MAIL_CODE',
    account: email,
    captcha,
    authContent: otp,
  }, { core: true });
}

async function getUserProfile(token, userId) {
  return saasRequest('/saas-api/cloud-client/user/get-user-profile', {}, { token, userId });
}

async function getExperienceQual(token, userId) {
  return saasRequest('/saas-api/cloud-client/user/get-experience-qual', {}, { core: true, token, userId });
}

async function receiveInstance(token, userId) {
  return saasRequest('/saas-api/cloud-client/user/receive-instance', {}, { token, userId });
}

async function main() {
  const localPart = randomLocalPart();
  const email = makeInboxKittenEmail(localPart);
  console.log('[inboxkitten]', email);

  const before = new Set((await inboxList(localPart).catch(() => [])).map(m => m?.storage?.key).filter(Boolean));

  let send = await sendVerificationCode(email, '');
  console.log('[send-code]', send.status, send.json);
  if (send.json?.code === NEED_CAPTCHA) {
    const cap = await solveCaptcha({ stage: 'send-code', response: send });
    send = await sendVerificationCode(email, cap);
    console.log('[send-code retry]', send.status, send.json);
  }
  if (send.json?.code !== 0) throw new Error('send-code failed: ' + JSON.stringify(send.json));

  const { otp } = await waitForOtp(localPart, { knownIds: before });
  console.log('[otp]', otp);

  let login = await loginMailCode(email, otp, '');
  console.log('[login]', login.status, login.json);
  if (login.json?.code === NEED_CAPTCHA) {
    const cap = await solveCaptcha({ stage: 'login', response: login });
    login = await loginMailCode(email, otp, cap);
    console.log('[login retry]', login.status, login.json);
  }
  if (login.json?.code !== 0) throw new Error('login failed: ' + JSON.stringify(login.json));

  const data = login.json.data || {};
  const token = data.token;
  const userId = String(data.userId || '');
  console.log('[token]', !!token, 'userId', userId, 'isNewUser', data.isNewUser);

  const profile = await getUserProfile(token, userId);
  console.log('[profile]', profile.json);

  const qual = await getExperienceQual(token, userId);
  console.log('[experience-qual]', qual.json);

  const recv = await receiveInstance(token, userId);
  console.log('[receive-instance]', recv.json);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
