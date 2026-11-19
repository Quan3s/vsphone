import { chromium } from '/app/vsphone/node_modules/playwright/index.mjs';
import fs from 'fs';

const events = [];
function log(obj){ events.push(obj); console.log(JSON.stringify(obj)); }
function save(){ fs.writeFileSync('/tmp/qt-flow-net.jsonl', events.map(x=>JSON.stringify(x)).join('\n')+'\n'); }

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
});
const context = await browser.newContext({ locale: 'en-US', viewport: {width: 430, height: 932} });
const page = await context.newPage();

page.on('request', req => {
  const url = req.url();
  if (url.includes('qtphone.com') && !url.includes('/_nuxt/') && !url.includes('.png') && !url.includes('.css') && !url.includes('.ico') && !url.includes('salesmartly')) {
    if (url.includes('/h5-api') || url.includes('/api') || url.includes('captcha') || url.includes('code') || url.includes('login') || url.includes('register') || url.includes('verify') || url.includes('send') || url.includes('email') || url.includes('trial') || url.includes('device') || url.includes('user')) {
      log({type:'request', method:req.method(), url, headers:req.headers(), postData:req.postData()});
    }
  }
});
page.on('response', async res => {
  const url = res.url();
  if (url.includes('qtphone.com') && !url.includes('/_nuxt/') && !url.includes('.png') && !url.includes('.css') && !url.includes('.ico') && !url.includes('salesmartly')) {
    if (url.includes('/h5-api') || url.includes('/api') || url.includes('captcha') || url.includes('code') || url.includes('login') || url.includes('register') || url.includes('verify') || url.includes('send') || url.includes('email') || url.includes('trial') || url.includes('device') || url.includes('user')) {
      let body=null; try{ body=await res.text(); if(body&&body.length>10000) body=body.slice(0,10000)+'...<truncated>'; }catch(e){ body=String(e); }
      log({type:'response', status:res.status(), url, headers:res.headers(), body});
    }
  }
});

const local = `qt${crypto.randomUUID().replace(/-/g,'').slice(0,12)}`;
const email = `${local}@inboxkitten.com`;
log({type:'info', email});

async function dump(step){
  await page.waitForTimeout(1200);
  await page.screenshot({path:`/tmp/qt-${step}.png`, fullPage:true});
  const text = await page.evaluate(()=>document.body.innerText.slice(0,12000));
  log({type:'dom', step, url: page.url(), text});
  const inputs = await page.evaluate(()=>{
    function vis(el){const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    return [...document.querySelectorAll('input,textarea,button')].map((el,i)=>({i,tag:el.tagName,vis:vis(el),type:el.type,placeholder:el.placeholder,value:el.value,text:(el.innerText||'').trim().slice(0,80),name:el.name,cls:el.className,aria:el.getAttribute('aria-label')}));
  });
  log({type:'elements', step, inputs});
  save();
}

try {
  await page.goto('https://m.qtphone.com', {waitUntil:'networkidle', timeout:60000});
  await page.waitForTimeout(3000);
  await dump('1-home');

  // fill email
  await page.locator('input[type="email"], input[placeholder*="email" i]').first().fill(email);
  // ensure terms checked
  const cb = page.locator('input[type="checkbox"]').first();
  const checked = await cb.isChecked().catch(()=>false);
  if (!checked) await cb.check({force:true}).catch(async()=>{ await page.locator('text=I have read and agree').first().click({force:true}).catch(()=>{}); });
  await dump('2-filled');

  // click Continue button (not divider). try to find button containing Continue
  const clicked = await page.evaluate(()=>{
    function vis(el){const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    const candidates=[...document.querySelectorAll('button, [role="button"], a, div, span')].filter(e=>{
      if(!vis(e)) return false;
      const t=(e.innerText||'').replace(/\s+/g,' ').trim();
      return /^Continue$/i.test(t) || /^Continue\s*→?$/i.test(t) || (t.includes('Continue') && t.length<20);
    });
    // prefer button-like
    candidates.sort((a,b)=>{
      const sa=(a.tagName==='BUTTON'?0:1);
      const sb=(b.tagName==='BUTTON'?0:1);
      return sa-sb;
    });
    if(candidates[0]){ candidates[0].click(); return {t:candidates[0].innerText.trim(), tag:candidates[0].tagName, cls:candidates[0].className}; }
    return null;
  });
  log({type:'action', step:'click-continue', clicked});
  await page.waitForTimeout(5000);
  await dump('3-after-continue');

  // if still same screen, try clicking arrow area
  const dom3 = await page.evaluate(()=>document.body.innerText);
  if (dom3.includes('Existing accounts can log in')) {
    const clicked2 = await page.evaluate(()=>{
      function vis(el){const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
      const els=[...document.querySelectorAll('*')].filter(e=>vis(e) && (e.innerText||'').trim()==='→');
      if(els[0]){els[0].click(); return {t:'→',tag:els[0].tagName,cls:els[0].className};}
      // try the continue container by text includes Continue and arrow
      const c=[...document.querySelectorAll('*')].filter(e=>vis(e) && /Continue/.test(e.innerText||'') && (e.innerText||'').includes('→') && (e.innerText||'').trim().length<30);
      if(c[0]){c[0].click(); return {t:c[0].innerText.trim(),tag:c[0].tagName,cls:c[0].className};}
      return null;
    });
    log({type:'action', step:'click-continue2', clicked:clicked2});
    await page.waitForTimeout(5000);
    await dump('4-after-continue2');
  }

} catch(e) {
  log({type:'error', error:String(e), stack:(e.stack||'').slice(0,1500)});
  try{ await dump('error'); }catch{}
}

save();
await browser.close();
