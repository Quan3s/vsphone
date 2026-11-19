import { chromium } from '/app/vsphone/node_modules/playwright/index.mjs';
import fs from 'fs';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
});
const context = await browser.newContext({ locale: 'en-US', viewport: {width: 430, height: 932} });
const page = await context.newPage();

let capResp = null;
page.on('response', async res => {
  if (res.url().includes('/h5-api/zw/captcha/get')) {
    try { capResp = await res.json(); } catch(e) { capResp = {err:String(e)}; }
  }
});

const email = `qt${Math.random().toString(36).slice(2,10)}@inboxkitten.com`;
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
  fs.writeFileSync('/tmp/qt-cap-full.json', JSON.stringify(capResp, null, 2));
  console.log('saved', !!capResp);
  if (capResp && capResp.data) {
    const d = capResp.data;
    console.log('keys', Object.keys(d));
    for (const [k,v] of Object.entries(d)) {
      if (typeof v === 'string' && v.length > 100) console.log(k, 'len', v.length, v.slice(0,40));
      else console.log(k, JSON.stringify(v));
    }
    const b64 = (k) => { if(d[k]) { const buf=Buffer.from(d[k],'base64'); fs.writeFileSync(`/tmp/qt-${k}.png`, buf); console.log('wrote', k, buf.length); } };
    b64('originalImageBase64');
    b64('jigsawImageBase64');
  }
  await page.screenshot({path:'/tmp/qt-cap-full.png', fullPage:true});
} catch(e) { console.error(e); }
await browser.close();
