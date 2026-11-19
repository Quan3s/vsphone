import { chromium } from '/app/vsphone/node_modules/playwright/index.mjs';
import fs from 'fs';
import crypto from 'crypto';

function aesEncryptECB(plaintext, keyStr) {
  const key = Buffer.from(keyStr, 'utf8');
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

async function solveSlider(originalB64, jigsawB64) {
  const { execSync } = await import('child_process');
  fs.writeFileSync('/tmp/qt-orig-i.png', Buffer.from(originalB64, 'base64'));
  fs.writeFileSync('/tmp/qt-jig-i.png', Buffer.from(jigsawB64, 'base64'));
  const out = execSync(`python3 - <<'PY'
from PIL import Image, ImageFilter
import numpy as np
orig = Image.open('/tmp/qt-orig-i.png').convert('RGBA')
jig = Image.open('/tmp/qt-jig-i.png').convert('RGBA')
Og = np.array(orig.convert('L').filter(ImageFilter.FIND_EDGES)).astype(np.float32)
Jg = np.array(jig.convert('L').filter(ImageFilter.FIND_EDGES)).astype(np.float32)
mask = np.array(jig)[:,:,3] > 50
ys,xs = np.where(mask)
y0,y1,x0,x1 = ys.min(),ys.max()+1,xs.min(),xs.max()+1
tpl = Jg[y0:y1,x0:x1]; tmask=mask[y0:y1,x0:x1]
ph,pw = tpl.shape; H,W = Og.shape
best=(1e18,0,y0)
for y in range(max(0,y0-4), min(H-ph, y0+5)):
  for x in range(0, W-pw):
    reg = Og[y:y+ph,x:x+pw]
    d = (np.abs(reg-tpl)*tmask).sum()/(tmask.sum()+1)
    if d < best[0]: best=(d,x,y)
print(best[1])
PY
`, { encoding: 'utf8' }).trim();
  return parseInt(out, 10);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const base = 'https://inboxkitten.com/api/v1/mail';

async function getOtp(local, seenKeys = new Set()) {
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const r = await fetch(`${base}/list?recipient=${encodeURIComponent(local)}`);
    const msgs = await r.json();
    if (Array.isArray(msgs) && msgs.length > 0) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        const region = msg.storage?.region, key = msg.storage?.key;
        if (!region || !key) continue;
        const uniq = `${region}:${key}`;
        if (seenKeys.has(uniq)) continue;
        seenKeys.add(uniq);
        const hr = await fetch(`${base}/getHtml?region=${encodeURIComponent(region)}&key=${encodeURIComponent(key)}`);
        const html = await hr.text();
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        const m = text.match(/Verification Code:\s*(\d{4,8})/i) || text.match(/verification code[^\d]*(\d{4,8})/i) || text.match(/\b(\d{6})\b/);
        if (m) return m[1];
      }
    }
    await sleep(5000);
  }
  throw new Error('otp timeout');
}

const events = [];
const netlog = '/tmp/qt-trial-net.jsonl';
function log(obj) {
  events.push(obj);
  try { fs.appendFileSync(netlog, JSON.stringify(obj) + '\n'); } catch {}
  const s = JSON.stringify(obj);
  if (s.length < 1200) console.log(s); else console.log(s.slice(0, 1200) + '...');
}

async function api(page, method, path, body, extraHeaders = {}) {
  return await page.evaluate(async ({ method, path, body, extraHeaders }) => {
    const r = await fetch('https://web.qtphone.com' + path, {
      method,
      headers: { 'content-type': 'application/json', 'lang': 'en-US', ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text: text.slice(0, 4000) };
  }, { method, path, body, extraHeaders });
}

try { fs.unlinkSync(netlog); } catch {}

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
});
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 430, height: 932 } });
const page = await context.newPage();

page.on('request', req => {
  const url = req.url();
  if (url.includes('/h5-api/')) {
    log({ type: 'req', method: req.method(), url, postData: req.postData(), headers: req.headers() });
  }
});
page.on('response', async res => {
  const url = res.url();
  if (url.includes('/h5-api/')) {
    let body = null;
    try { body = await res.text(); if (body.length > 12000) body = body.slice(0, 12000) + '...'; } catch (e) { body = String(e); }
    log({ type: 'res', status: res.status(), url, body });
  }
});

const local = `qt${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
const email = `${local}@inboxkitten.com`;
log({ type: 'info', email, local });

async function dump(step) {
  try {
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `/tmp/qt-trial-${step}.png`, fullPage: true });
    const info = await page.evaluate(() => ({
      url: location.href,
      text: document.body.innerText.slice(0, 8000),
      buttons: [...document.querySelectorAll('button,[role="button"],a,div,span')].filter(e => {
        const r = e.getBoundingClientRect(), s = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      }).map(e => ({ tag: e.tagName, text: (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80), cls: (e.className || '').toString().slice(0, 80) }))
        .filter(e => e.text && e.text.length < 80).slice(0, 120)
    }));
    fs.writeFileSync(`/tmp/qt-trial-${step}.json`, JSON.stringify(info, null, 2));
    log({ type: 'dom', step, url: info.url, text: info.text.slice(0, 3000) });
  } catch (e) { log({ type: 'dump-error', step, error: String(e) }); }
}

try {
  await page.goto('https://m.qtphone.com', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2500);

  // 1. checkEmail
  const ce = await api(page, 'POST', '/h5-api/auth/checkEmail', { email });
  log({ type: 'checkEmail', ce });

  // 2. captcha get/solve/check (retry)
  let cv = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const cap = await api(page, 'POST', '/h5-api/zw/captcha/get', { captchaType: 'blockPuzzle' });
    if (!cap.json?.data?.originalImageBase64) { log({ type: 'captcha-fail', attempt, cap }); continue; }
    const d = cap.json.data;
    const x = await solveSlider(d.originalImageBase64, d.jigsawImageBase64);
    const pointJson = aesEncryptECB(JSON.stringify({ x, y: 5 }), d.secretKey);
    const check = await api(page, 'POST', '/h5-api/zw/captcha/check', { captchaType: 'blockPuzzle', pointJson, token: d.token });
    log({ type: 'captcha', attempt, x, check });
    cv = check.json?.data?.captchaVerification || check.json?.captchaVerification;
    if (check.json?.code === 0 && cv) break;
    cv = null;
  }
  if (!cv) throw new Error('captcha solve failed');

  // 3. send
  const send = await api(page, 'POST', '/h5-api/auth/sendEmail', { email, type: 3, captchaVerification: cv });
  log({ type: 'send', send });
  if (send.json?.code !== 0) throw new Error('sendEmail failed: ' + send.text);

  // 4. otp
  const otp = await getOtp(local);
  log({ type: 'otp', otp });

  // 5. login
  const login = await api(page, 'POST', '/h5-api/auth/emailSmsLogin', { email, code: otp });
  log({ type: 'login', login });
  const token = login.json?.data?.access_token;
  if (!token) throw new Error('no access_token');
  log({ type: 'token', token });

  // inject token and reload
  await page.evaluate((token) => {
    const keys = ['token','access_token','accessToken','h5_token','Authorization','satoken','user_token','qt_token','x-token','userToken','loginToken','auth_token'];
    for (const k of keys) { try { localStorage.setItem(k, token); } catch(e){} try { sessionStorage.setItem(k, token); } catch(e){} }
    try { localStorage.setItem('userInfo', JSON.stringify({ access_token: token })); } catch(e){}
    try { document.cookie = `token=${token}; path=/`; } catch(e){}
  }, token);
  await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(5000);
  await dump('home-loggedin');

  // click bottom nav items by text
  const navTexts = ['Cloud phones', 'Buy', 'Me', 'My team', 'Cloud phone', 'Home'];
  for (const t of navTexts) {
    try {
      const el = page.getByText(t, { exact: true }).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.click({ force: true, timeout: 3000 });
        await page.waitForTimeout(3500);
        await dump(`nav-${t.replace(/\s+/g,'_').toLowerCase()}`);
      }
    } catch (e) { log({ type: 'nav-error', t, error: String(e) }); }
  }

  // look for interesting keywords and click them
  const keywords = ['trial', 'Trial', 'free', 'Free', 'experience', 'Experience', 'claim', 'Claim', 'receive', 'Receive', 'gift', 'Gift', 'New user', 'new user', 'Get', 'Try', 'Activate', 'Start'];
  for (const kw of keywords) {
    try {
      const els = page.getByText(kw, { exact: false });
      const count = await els.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 3); i++) {
        const el = els.nth(i);
        if (await el.isVisible({ timeout: 500 }).catch(() => false)) {
          const txt = (await el.innerText().catch(() => '')).replace(/\s+/g,' ').trim().slice(0,60);
          log({ type: 'click-kw', kw, i, txt });
          await el.click({ force: true, timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(3500);
          await dump(`kw-${kw.replace(/\s+/g,'_')}-${i}`);
          // go back to not lose place? just continue
        }
      }
    } catch (e) { log({ type: 'kw-error', kw, error: String(e) }); }
  }

  // try common SPA routes
  const routes = ['/#/buy', '/#/me', '/#/user', '/#/activity', '/#/promo', '/#/trial', '/#/experience', '/#/cloud', '/#/device', '/#/home'];
  for (const r of routes) {
    try {
      await page.goto('https://m.qtphone.com' + r, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);
      await dump(`route-${r.replace(/[^a-zA-Z0-9]+/g,'_')}`);
    } catch (e) { log({ type: 'route-error', r, error: String(e) }); }
  }

  // final dump of all net h5-api urls seen
  const urls = [...new Set(events.filter(e=>e.type==='req'||e.type==='res').map(e=>e.method ? `${e.method} ${e.url}` : `${e.status} ${e.url}`))];
  fs.writeFileSync('/tmp/qt-trial-urls.txt', urls.join('\n'));

} catch (e) {
  log({ type: 'error', error: String(e), stack: (e.stack || '').slice(0, 2000) });
  try { await dump('error'); } catch {}
}

fs.writeFileSync('/tmp/qt-trial-summary.json', JSON.stringify({ email, events: events.length }, null, 2));
await browser.close();
console.log('DONE');
