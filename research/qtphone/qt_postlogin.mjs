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
  const {execSync} = await import('child_process');
  fs.writeFileSync('/tmp/qt-orig2.png', Buffer.from(originalB64,'base64'));
  fs.writeFileSync('/tmp/qt-jig2.png', Buffer.from(jigsawB64,'base64'));
  const py = `
from PIL import Image
import numpy as np
orig = Image.open('/tmp/qt-orig2.png').convert('RGBA')
jig = Image.open('/tmp/qt-jig2.png').convert('RGBA')
Og = np.array(orig.convert('L').filter(ImageFilter.FIND_EDGES)).astype(np.float32) if False else None
`;
  // simple inline
  const out = execSync(`python3 - <<'PY'
from PIL import Image, ImageFilter
import numpy as np
orig = Image.open('/tmp/qt-orig2.png').convert('RGBA')
jig = Image.open('/tmp/qt-jig2.png').convert('RGBA')
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
`, {encoding:'utf8'}).trim();
  return parseInt(out,10);
}

const base = 'https://inboxkitten.com/api/v1/mail';
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function getOtp(local) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const r = await fetch(`${base}/list?recipient=${encodeURIComponent(local)}`);
    const msgs = await r.json();
    if (Array.isArray(msgs) && msgs.length > 0) {
      const msg = msgs[msgs.length-1];
      const region = msg.storage?.region, key = msg.storage?.key;
      if (region && key) {
        const hr = await fetch(`${base}/getHtml?region=${encodeURIComponent(region)}&key=${encodeURIComponent(key)}`);
        const html = await hr.text();
        const text = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
        const m = text.match(/Verification Code:\s*(\d{4,8})/i) || text.match(/\b(\d{6})\b/);
        if (m) return m[1];
      }
    }
    await sleep(5000);
  }
  throw new Error('otp timeout');
}

const events = [];
function log(obj){ events.push(obj); console.log(JSON.stringify(obj)); }

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
});
const context = await browser.newContext({ locale: 'en-US', viewport: {width: 430, height: 932} });
const page = await context.newPage();

page.on('request', req => {
  const url = req.url();
  if (url.includes('/h5-api/')) log({type:'req', method:req.method(), url, headers:req.headers(), postData:req.postData()});
});
page.on('response', async res => {
  const url = res.url();
  if (url.includes('/h5-api/')) {
    let body=null; try{ body=await res.text(); if(body.length>8000) body=body.slice(0,8000)+'...'; }catch(e){body=String(e)}
    log({type:'res', status:res.status(), url, body});
  }
});

const local = `qt${crypto.randomUUID().replace(/-/g,'').slice(0,10)}`;
const email = `${local}@inboxkitten.com`;
log({type:'info', email, local});

try {
  await page.goto('https://m.qtphone.com', {waitUntil:'networkidle', timeout:60000});
  await page.waitForTimeout(2500);

  // do full flow via API in page context (so we learn nothing extra from headers except what we pass, but we get token)
  // 1. checkEmail
  const ce = await page.evaluate(async (email) => (await fetch('https://web.qtphone.com/h5-api/auth/checkEmail',{method:'POST',headers:{'content-type':'application/json','lang':'en-US'},body:JSON.stringify({email})})).json(), email);
  log({type:'checkEmail', ce});

  // 2. captcha get + solve + check
  const cap = await page.evaluate(async () => (await fetch('https://web.qtphone.com/h5-api/zw/captcha/get',{method:'POST',headers:{'content-type':'application/json','lang':'en-US'},body:JSON.stringify({captchaType:'blockPuzzle'})})).json());
  const x = await solveSlider(cap.data.originalImageBase64, cap.data.jigsawImageBase64);
  const pointJson = aesEncryptECB(JSON.stringify({x,y:5}), cap.data.secretKey);
  const check = await page.evaluate(async (p) => (await fetch('https://web.qtphone.com/h5-api/zw/captcha/check',{method:'POST',headers:{'content-type':'application/json','lang':'en-US'},body:JSON.stringify(p)})).json(), {captchaType:'blockPuzzle', pointJson, token:cap.data.token});
  const cv = check.captchaVerification || check.data?.captchaVerification;
  log({type:'captcha', x, checkCode:check.code, cv});

  // 3. send email
  const send = await page.evaluate(async (p) => (await fetch('https://web.qtphone.com/h5-api/auth/sendEmail',{method:'POST',headers:{'content-type':'application/json','lang':'en-US'},body:JSON.stringify(p)})).json(), {email, type:3, captchaVerification: cv});
  log({type:'send', send});

  // 4. otp
  const otp = await getOtp(local);
  log({type:'otp', otp});

  // 5. login
  const login = await page.evaluate(async (p) => (await fetch('https://web.qtphone.com/h5-api/auth/emailSmsLogin',{method:'POST',headers:{'content-type':'application/json','lang':'en-US'},body:JSON.stringify(p)})).json(), {email, code: otp});
  log({type:'login', login});

  const token = login?.data?.access_token;
  if (token) {
    // try to discover storage and inject
    const storageInfo = await page.evaluate((token) => {
      const keys = [];
      for (let i=0;i<localStorage.length;i++) keys.push(localStorage.key(i));
      const sKeys = [];
      for (let i=0;i<sessionStorage.length;i++) sKeys.push(sessionStorage.key(i));
      // try common token keys
      const tryKeys = ['token','access_token','accessToken','h5_token','Authorization','satoken','user_token','qt_token'];
      for (const k of tryKeys) { try { localStorage.setItem(k, token); } catch(e){} }
      // also try to find if nuxt/pinia stored
      return {localKeys: keys, sessionKeys: sKeys, cookies: document.cookie};
    }, token);
    log({type:'storage', storageInfo});

    // reload to see if app picks up token and makes authed requests
    await page.reload({waitUntil:'networkidle', timeout:60000});
    await page.waitForTimeout(6000);
    await page.screenshot({path:'/tmp/qt-postlogin.png', fullPage:true});
    const dom = await page.evaluate(()=>document.body.innerText.slice(0,5000));
    log({type:'dom', step:'after-reload', dom});

    // try navigate around
    await page.evaluate(()=>location.hash='#/'); // maybe
    await page.waitForTimeout(3000);
  }

} catch(e) {
  log({type:'error', error:String(e), stack:(e.stack||'').slice(0,1500)});
}
fs.writeFileSync('/tmp/qt-postlogin-net.jsonl', events.map(x=>JSON.stringify(x)).join('\n')+'\n');
await browser.close();
