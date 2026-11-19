import { chromium } from '/app/vsphone/node_modules/playwright/index.mjs';
import fs from 'fs';

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
page.on('request', req => { if (want(req.url())) log({type:'request', method:req.method(), url:req.url(), postData:req.postData(), headers:req.headers()}); });
page.on('response', async res => {
  if (want(res.url())) {
    let body=null; const ct=res.headers()['content-type']||'';
    try{ const buf=await res.body(); if(/image/i.test(ct)){ body=`<image ${buf.length}>`; fs.writeFileSync('/tmp/qt-cap2.bin', buf);} else { body=buf.toString('utf8'); if(body.length>12000) body=body.slice(0,12000)+'...'; } }catch(e){body=String(e)}
    log({type:'response', status:res.status(), url:res.url(), ct, body});
  }
});

const email = `qt${Math.random().toString(36).slice(2,10)}@inboxkitten.com`;
log({type:'info', email});

try {
  await page.goto('https://m.qtphone.com', {waitUntil:'networkidle', timeout:60000});
  await page.waitForTimeout(2500);
  await page.locator('input[type="email"]').first().fill(email);
  const cb = page.locator('input[type="checkbox"]').first();
  if (!(await cb.isChecked().catch(()=>false))) await cb.check({force:true}).catch(()=>{});
  await page.getByRole('button', {name:/Continue/i}).first().click();
  await page.waitForTimeout(5000);

  // inspect Get code elements
  const gcinfo = await page.evaluate(()=>{
    function vis(el){const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    const els=[...document.querySelectorAll('*')].filter(e=>vis(e)&&/get code/i.test((e.innerText||'')));
    return els.slice(0,12).map(e=>({tag:e.tagName, t:(e.innerText||'').trim().slice(0,60), cls:e.className, role:e.getAttribute('role'), disabled:e.disabled, onclick:!!e.onclick}));
  });
  log({type:'gcinfo', gcinfo});

  // try clicking the most specific "Get code" - likely a span/button inside auth-code-field
  await page.getByText('Get code', {exact:true}).first().click({force:true}).catch(()=>{});
  await page.waitForTimeout(6000);
  await page.screenshot({path:'/tmp/qt-getcode2.png', fullPage:true});
  log({type:'dom', step:'after', text: await page.evaluate(()=>document.body.innerText.slice(0,6000))});

  // maybe click again
  await page.evaluate(()=>{
    function vis(el){const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    const els=[...document.querySelectorAll('*')].filter(e=>vis(e) && (e.innerText||'').trim()==='Get code');
    // pick innermost
    els.sort((a,b)=>a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height);
    if(els[0]){els[0].dispatchEvent(new MouseEvent('click',{bubbles:true})); return els[0].outerHTML.slice(0,200);}
    return null;
  }).then(r=>log({type:'click2', r}));
  await page.waitForTimeout(6000);
  log({type:'dom', step:'after2', text: await page.evaluate(()=>document.body.innerText.slice(0,6000))});
  await page.screenshot({path:'/tmp/qt-getcode2b.png', fullPage:true});

} catch(e) {
  log({type:'error', error:String(e), stack:(e.stack||'').slice(0,1200)});
}
fs.writeFileSync('/tmp/qt-getcode2-net.jsonl', events.map(x=>JSON.stringify(x)).join('\n')+'\n');
await browser.close();
