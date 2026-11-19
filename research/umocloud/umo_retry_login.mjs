import crypto from 'node:crypto';

const CONFIG = {
  baseApi: 'https://oem-api.willclouds.com',
  baseCore: 'https://oem-core.willclouds.com',
  tenantId: '242',
  clientBrandId: '108',
  signatureSalt: '4d9cbb6b585448419578a95954a2b886',
  chnl: 'h5_cphone',
  cid: '50000',
  cver: '1001021',
  locale: 'en-US',
  clientType: 'h5',
  clientCode: 'ae02b',
};
const NEED_CAPTCHA = 1009000004;

function javaURLEncode(s) {
  const bytes = Buffer.from(String(s), 'utf8');
  let out = '';
  for (const b of bytes) {
    if (b === 32) out += '+';
    else if ((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b === 45 || b === 46 || b === 95 || b === 42) out += String.fromCharCode(b);
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}
function objectToQueryString(obj) {
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  return keys.map((k) => `${javaURLEncode(k)}=${javaURLEncode(obj[k])}`).join('&');
}
function signParams(params) {
  const b = objectToQueryString(params);
  const w = crypto.createHash('md5').update(b + CONFIG.signatureSalt, 'utf8').digest('hex');
  return w.slice(4, 20);
}
function commonParams(userId = '') {
  const ts = Date.now().toString();
  const cuid = ts + Math.floor(1000000 + Math.random() * 9000000).toString() + CONFIG.clientCode;
  return { cuid, ts, userId: String(userId || ''), cid: CONFIG.cid, chnl: CONFIG.chnl, cver: CONFIG.cver, locale: CONFIG.locale, clientType: CONFIG.clientType };
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
    'user-agent': 'Mozilla/5.0',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const body = objectToQueryString(params);
  const res = await fetch(base + path, { method: 'POST', headers, body });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const email = process.argv[2];
const otp = process.argv[3];
if (!email || !otp) { console.error('usage: node umo_retry_login.mjs <email> <otp>'); process.exit(1); }

console.log('[email]', email, '[otp]', otp);
let login = await saasRequest('/saas-api/cloud-client/auth/login', { loginType:'MAIL_CODE', account:email, captcha:'', authContent:otp }, { core:true });
console.log('[login]', login.status, JSON.stringify(login.json));
if (login.json?.code !== 0) process.exit(2);
const data = login.json.data || {};
const token = data.token; const userId = String(data.userId||'');
console.log('[token]', !!token, 'userId', userId, 'isNewUser', data.isNewUser, 'tokenExpiresIn', data.tokenExpiresIn);

const profile = await saasRequest('/saas-api/cloud-client/user/get-user-profile', {}, { token, userId });
console.log('[profile]', JSON.stringify(profile.json));
const qual = await saasRequest('/saas-api/cloud-client/user/get-experience-qual', {}, { core:true, token, userId });
console.log('[experience-qual]', JSON.stringify(qual.json));
const recv = await saasRequest('/saas-api/cloud-client/user/receive-instance', {}, { token, userId });
console.log('[receive-instance]', JSON.stringify(recv.json));
