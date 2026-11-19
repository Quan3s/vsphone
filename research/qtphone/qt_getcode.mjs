import { chromium } from '/app/vsphone/node_modules/playwright/index.mjs';
import fs from 'fs';

const events = [];
function log(obj){ events.push(obj); console.log(JSON.stringify(obj)); }
function save(){ fs.writeFileSync('/tmp/qt-getcode-net.jsonl', events.map(x=>JSON.stringify(x)).join('\n')+'\n'); }

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
});
const context = await browser.newContext({ locale: 'en-US', viewport: {width: 430, height: 932} });
const page = await context.newPage();

function want(url){
  if (!url.includes('qtphone.com')) return false;
  if (url.includes('/_nuxt/')||url.includes('.png')||url.includes('.jpg')||url.includes('.css')||url.includes('.ico')||url.includes('salesmartly')) return false;
  return /h5-api|\/api\/|captcha|code|verify|send|email|login|register|auth/i.test(url);
}
page.on('request', req => {
  const url = req.url();
  if (want(url)) log({type:'request', method:req.method(), url, headers:req.headers(), postData:req.postData()});
});
page.on('response', async res => {
  const url = res.url();
  if (want(url)) {
    let body=null, b64=null, ct=(res.headers()['content-type']||'');
    try{
      const buf = await res.body();
      if (/image|octet/i.test(ct) || (buf[0]===0xff && buf[1]===0xd8) || (buf[0]===0x89 && buf[1]===0x50)) {
        b64 = buf.toString('base64').slice(0,200);
        body = `<binary ${buf.length} bytes>`;
        if (/image|jpeg|png/i.test(ct) || buf.length<20000) {
          const ext = ct.includes('png')?'png':'jpg';
          const safe = url.split('/').pop().split('?')[0].replace(/[^a-zA-Z0-9._-]/g,'_') || 'img';
          fs.writeFileSync(`/tmp/qt-captcha-${safe}.${ext}`, buf);
        }
      } else {
        body = buf.toString('utf8');
        if(body.length>12000) body=body.slice(0,12000)+'...<truncated>';
      }
    }catch(e){ body=String(e); }
    log({type:'response', status:res.status(), url, headers:res.headers(), body, b64Prefix:b64});
  }
});

const email = process.argv[2] || `qt${Math.random().toString(36).slice(2,10)}@inboxkitten.com`;
log({type:'info', email});

async function dump(step){
  await page.waitForTimeout(1500);
  await page.screenshot({path:`/tmp/qt-${step}.png`, fullPage:true});
  const text = await page.evaluate(()=>document.body.innerText.slice(0,12000));
  log({type:'dom', step, url: page.url(), text});
  save();
}

try {
  await page.goto('https://m.qtphone.com', {waitUntil:'networkidle', timeout:60000});
  await page.waitForTimeout(2500);
  await page.locator('input[type="email"]').first().fill(email);
  const cb = page.locator('input[type="checkbox"]').first();
  if (!(await cb.isChecked().catch(()=>false))) await cb.check({force:true}).catch(()=>{});
  await page.getByRole('button', {name:/Continue/i}).first().click();
  await page.waitForTimeout(5000);
  await dump('step2');

  // click Get code
  const gc = await page.evaluate(()=>{
    function vis(el){const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    const els=[...document.querySelectorAll('button,[role="button"],div,span')].filter(e=>vis(e)&&/^\s*Get code\s*$/i.test((e.innerText||'').trim()));
    if(els[0]){els[0].click(); return {t:els[0].innerText.trim(), tag:els[0].tagName, cls:els[0].className};}
    return null;
  });
  log({type:'action', step:'get-code', clicked:gc});
  await page.waitForTimeout(5000);
  await dump('step3-getcode');

  // any captcha image/popup visible?
  const cap = await page.evaluate(()=>{
    function vis(el){const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    const imgs=[...document.querySelectorAll('img')].filter(vis).map(i=>({src:(i.src||'').slice(0,200),alt:i.alt,w:i.naturalWidth,h:i.naturalHeight,cls:i.className}));
    const canv=[...document.querySelectorAll('canvas')].filter(vis).map(c=>({w:c.width,h:c.height,cls:c.className}));
    const inputs=[...document.querySelectorAll('input')].filter(vis).map(i=>({type:i.type,ph:i.placeholder,val:i.value,cls:i.className}));
    const texts=[...document.querySelectorAll('*')].filter(e=>vis(e)&&/captcha|verify|graphic|slide|puzzle/i.test(e.innerText||'')&&(e.innerText||'').trim().length<200).slice(0,10).map(e=>({tag:e.tagName,t:(e.innerText||'').trim().slice(0,120),cls:e.className}));
    return {imgs, canv, inputs, texts};
  });
  log({type:'captcha-ui', cap});
  save();

} catch(e) {
  log({type:'error', error:String(e), stack:(e.stack||'').slice(0,1500)});
  try{ await dump('error'); }catch{}
}
save();
await browser.close();
