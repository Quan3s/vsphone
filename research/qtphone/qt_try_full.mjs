import { chromium } from '/app/vsphone/node_modules/playwright/index.mjs';
import fs from 'fs';
import crypto from 'crypto';

function aesEncryptECB(plaintext, keyStr) {
  const key = Buffer.from(keyStr, 'utf8');
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

// simple edge/template match in pure JS? easier to shell out to python if available later, but for now try to solve via page context? 
// Actually easier: compute offset in python via a quick inline script.

async function solveSlider(originalB64, jigsawB64) {
  // write temp files and run python matcher
  fs.writeFileSync('/tmp/qt-orig.png', Buffer.from(originalB64,'base64'));
  fs.writeFileSync('/tmp/qt-jig.png', Buffer.from(jigsawB64,'base64'));
  const {execSync} = await import('child_process');
  const py = `
from PIL import Image
import numpy as np, json
orig = Image.open('/tmp/qt-orig.png').convert('RGBA')
jig = Image.open('/tmp/qt-jig.png').convert('RGBA')
O = np.array(orig.convert('L')).astype(np.float32)
Jfull = np.array(jig)
mask = Jfull[:,:,3] > 50
ys,xs = np.where(mask)
y0,y1,x0,x1 = ys.min(),ys.max()+1,xs.min(),xs.max()+1
# edge match
from PIL import ImageFilter
Og = np.array(orig.convert('L').filter(ImageFilter.FIND_EDGES)).astype(np.float32)
Jg = np.array(jig.convert('L').filter(ImageFilter.FIND_EDGES)).astype(np.float32)
jmask = mask
tpl = Jg[y0:y1,x0:x1]; tmask=jmask[y0:y1,x0:x1]
ph,pw = tpl.shape
H,W = Og.shape
best=(1e18,0,y0)
for y in range(max(0,y0-4), min(H-ph, y0+5)):
  for x in range(0, W-pw):
    reg = Og[y:y+ph,x:x+pw]
    d = (np.abs(reg-tpl)*tmask).sum()/(tmask.sum()+1)
    if d < best[0]: best=(d,x,y)
print(best[1])
`;
  fs.writeFileSync('/tmp/qt_solve.py', py);
  const out = execSync('python3 /tmp/qt_solve.py', {encoding:'utf8'}).trim();
  return parseInt(out,10);
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

function want(url){
  if (!url.includes('qtphone.com')) return false;
  if (url.includes('/_nuxt/')||url.includes('salesmartly')||url.match(/\.(css|ico)(\?|$)/)) return false;
  return /h5-api|captcha|code|verify|send|email|login|register|auth/i.test(url);
}
page.on('request', req => { if (want(req.url())) log({type:'request', method:req.method(), url:req.url(), postData:req.postData()}); });
page.on('response', async res => {
  if (want(res.url())) {
    let body=null; const ct=res.headers()['content-type']||'';
    try{ const t=await res.text(); body=t.length>12000? t.slice(0,12000)+'...': t; }catch(e){body=String(e)}
    log({type:'response', status:res.status(), url:res.url(), ct, body});
  }
});

const email = `qt${crypto.randomUUID().replace(/-/g,'').slice(0,10)}@inboxkitten.com`;
log({type:'info', email});

try {
  await page.goto('https://m.qtphone.com', {waitUntil:'networkidle', timeout:60000});
  await page.waitForTimeout(2500);
  await page.locator('input[type="email"]').first().fill(email);
  const cb = page.locator('input[type="checkbox"]').first();
  if (!(await cb.isChecked().catch(()=>false))) await cb.check({force:true}).catch(()=>{});
  await page.getByRole('button', {name:/Continue/i}).first().click();
  await page.waitForTimeout(5000);
  await page.getByText('Get code', {exact:true}).first().click({force:true});
  await page.waitForTimeout(6000);

  // get captcha data by calling API via page fetch to capture easily
  const cap = await page.evaluate(async () => {
    const r = await fetch('https://web.qtphone.com/h5-api/zw/captcha/get', {
      method:'POST', headers:{'content-type':'application/json','lang':'en-US'}, body: JSON.stringify({captchaType:'blockPuzzle'})
    });
    return await r.json();
  });
  fs.writeFileSync('/tmp/qt-cap-test.json', JSON.stringify(cap));
  log({type:'cap', keys: Object.keys(cap.data||{})});
  const d = cap.data;
  const x = await solveSlider(d.originalImageBase64, d.jigsawImageBase64);
  log({type:'solve', x, token:d.token, secretKey:d.secretKey});
  const pointJson = aesEncryptECB(JSON.stringify({x, y:5}), d.secretKey);
  log({type:'enc', pointJson});

  const check = await page.evaluate(async (payload) => {
    const r = await fetch('https://web.qtphone.com/h5-api/zw/captcha/check', {
      method:'POST', headers:{'content-type':'application/json','lang':'en-US'}, body: JSON.stringify(payload)
    });
    return await r.json();
  }, {captchaType:'blockPuzzle', pointJson, token:d.token});
  log({type:'check', check});

  if (check && check.code === 0) {
    const cv = check.data?.captchaVerification || (pointJson ? null : null);
    log({type:'captchaVerification', cv, data: check.data});
    // try sendEmail with captchaVerification
    const send = await page.evaluate(async (body) => {
      const r = await fetch('https://web.qtphone.com/h5-api/auth/sendEmail', {
        method:'POST', headers:{'content-type':'application/json','lang':'en-US'}, body: JSON.stringify(body)
      });
      return await r.json();
    }, {email, type:3, captchaVerification: check.data.captchaVerification});
    log({type:'send', send});
  }

} catch(e) {
  log({type:'error', error:String(e), stack:(e.stack||'').slice(0,1500)});
}
fs.writeFileSync('/tmp/qt-try-full-net.jsonl', events.map(x=>JSON.stringify(x)).join('\n')+'\n');
await browser.close();
