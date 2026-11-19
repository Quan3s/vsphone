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
  fs.writeFileSync('/tmp/qt-orig-p.png', Buffer.from(originalB64, 'base64'));
  fs.writeFileSync('/tmp/qt-jig-p.png', Buffer.from(jigsawB64, 'base64'));
  const out = execSync(`python3 - <<'PY'
from PIL import Image, ImageFilter
import numpy as np
orig = Image.open('/tmp/qt-orig-p.png').convert('RGBA')
jig = Image.open('/tmp/qt-jig-p.png').convert('RGBA')
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
async function getOtp(local) {
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const r = await fetch(`${base}/list?recipient=${encodeURIComponent(local)}`);
    const msgs = await r.json();
    if (Array.isArray(msgs) && msgs.length > 0) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        const region = msg.storage?.region, key = msg.storage?.key;
        if (!region || !key) continue;
        const hr = await fetch(`${base}/getHtml?region=${encodeURIComponent(region)}&key=${encodeURIComponent(key)}`);
        const html = await hr.text();
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        const m = text.match(/Verification Code:\s*(\d{4,8})/i) || text.match(/\b(\d{6})\b/);
        if (m) return m[1];
      }
    }
    await sleep(5000);
  }
  throw new Error('otp timeout');
}
async function api(page, method, path, body) {
  return await page.evaluate(async ({ method, path, body }) => {
    const r = await fetch('https://web.qtphone.com' + path, {
      method, headers: { 'content-type': 'application/json', 'lang': 'en-US' },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text: text.slice(0, 4000) };
  }, { method, path, body });
}
const events = [];
function log(o){ events.push(o); console.log(JSON.stringify(o).slice(0,1500)); }

const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome', headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 430, height: 932 } });
const page = await context.newPage();
page.on('request', req => { if (req.url().includes('/h5-api/')) log({type:'req', method:req.method(), url:req.url(), postData:req.postData()}); });
page.on('response', async res => {
  if (res.url().includes('/h5-api/')) {
    let body=null; try{ body=await res.text(); if(body.length>12000) body=body.slice(0,12000)+'...'; }catch(e){body=String(e)}
    log({type:'res', status:res.status(), url:res.url(), body});
  }
});

const local = `qt${crypto.randomUUID().replace(/-/g,'').slice(0,10)}`;
const email = `${local}@inboxkitten.com`;
log({type:'info', email});
try {
  await page.goto('https://m.qtphone.com', {waitUntil:'networkidle', timeout:60000});
  await page.waitForTimeout(2000);
  const ce = await api(page,'POST','/h5-api/auth/checkEmail',{email});
  let cv=null;
  for(let i=0;i<5;i++){
    const cap=await api(page,'POST','/h5-api/zw/captcha/get',{captchaType:'blockPuzzle'});
    const d=cap.json?.data; if(!d?.originalImageBase64) continue;
    const x=await solveSlider(d.originalImageBase64,d.jigsawImageBase64);
    const pointJson=aesEncryptECB(JSON.stringify({x,y:5}),d.secretKey);
    const check=await api(page,'POST','/h5-api/zw/captcha/check',{captchaType:'blockPuzzle',pointJson,token:d.token});
    cv=check.json?.data?.captchaVerification||check.json?.captchaVerification;
    if(check.json?.code===0&&cv) break; cv=null;
  }
  if(!cv) throw new Error('captcha fail');
  await api(page,'POST','/h5-api/auth/sendEmail',{email,type:3,captchaVerification:cv});
  const otp = await getOtp(local);
  const login = await api(page,'POST','/h5-api/auth/emailSmsLogin',{email,code:otp});
  const token = login.json?.data?.access_token;
  log({type:'token', token, login: login.json});
  await page.evaluate((token)=>{
    for(const k of ['token','access_token','accessToken','h5_token','Authorization','satoken','user_token','qt_token','x-token','userToken','loginToken','auth_token']){
      try{localStorage.setItem(k,token)}catch(e){} try{sessionStorage.setItem(k,token)}catch(e){}
    }
    try{document.cookie=`token=${token}; path=/`}catch(e){}
  }, token);
  await page.reload({waitUntil:'networkidle', timeout:60000});
  await page.waitForTimeout(4000);

  async function dump(step){
    await page.waitForTimeout(1500);
    await page.screenshot({path:`/tmp/qt-me-${step}.png`, fullPage:true});
    const info = await page.evaluate(()=>({url:location.href, text:document.body.innerText.slice(0,6000)}));
    fs.writeFileSync(`/tmp/qt-me-${step}.json`, JSON.stringify(info,null,2));
    log({type:'dom', step, url:info.url, text:info.text.slice(0,1200)});
  }

  // go to Me
  await page.goto('https://m.qtphone.com/mine', {waitUntil:'networkidle', timeout:30000}).catch(()=>{});
  await page.waitForTimeout(3000);
  await dump('mine');

  for (const label of ['Limited offer','My orders','Redemption Center','Download app','Notifications','Help center','Feedback']) {
    try {
      // go back to mine first
      await page.goto('https://m.qtphone.com/mine', {waitUntil:'domcontentloaded', timeout:30000}).catch(()=>{});
      await page.waitForTimeout(2500);
      const el = page.getByText(label, {exact:true}).first();
      if (await el.isVisible({timeout:1500}).catch(()=>false)) {
        await el.click({force:true, timeout:3000});
        await page.waitForTimeout(4000);
        await dump(`click-${label.replace(/\s+/g,'_')}`);
      } else {
        // try home for Limited offer
        if (label==='Limited offer') {
          await page.goto('https://m.qtphone.com/', {waitUntil:'domcontentloaded', timeout:30000}).catch(()=>{});
          await page.waitForTimeout(2500);
          const el2 = page.getByText(label, {exact:false}).first();
          if (await el2.isVisible({timeout:1500}).catch(()=>false)) {
            await el2.click({force:true, timeout:3000});
            await page.waitForTimeout(4000);
            await dump(`click-${label.replace(/\s+/g,'_')}`);
          }
        }
        log({type:'not-visible', label});
      }
    } catch(e){ log({type:'click-error', label, error:String(e)}); }
  }

  // also try GET/POST on plausible endpoints with token
  const tokenCalls = [
    ['GET','/h5-api/activity/list'], ['POST','/h5-api/activity/list',{}],
    ['GET','/h5-api/user/activity'], ['POST','/h5-api/user/activity',{}],
    ['GET','/h5-api/order/list'], ['POST','/h5-api/order/list',{}],
    ['GET','/h5-api/redeem/info'], ['POST','/h5-api/redeem/info',{}],
    ['GET','/h5-api/coupon/list'], ['POST','/h5-api/coupon/list',{}],
  ];
  for (const [m,p,b] of tokenCalls) {
    const r = await page.evaluate(async ({m,p,b,token})=>{
      const res = await fetch('https://web.qtphone.com'+p,{method:m,headers:{'content-type':'application/json','lang':'en-US','x-token':token},body:b?JSON.stringify(b):undefined});
      const t = await res.text(); return {status:res.status, text:t.slice(0,800)};
    }, {m,p,b,token});
    log({type:'probe', m, p, r});
  }

} catch(e){ log({type:'error', error:String(e), stack:(e.stack||'').slice(0,1500)}); }
fs.writeFileSync('/tmp/qt-me-events.jsonl', events.map(x=>JSON.stringify(x)).join('\n')+'\n');
await browser.close();
console.log('DONE');
