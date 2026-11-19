import { chromium } from '/app/vsphone/node_modules/playwright/index.mjs';
import fs from 'fs';

const email = process.argv[2];
const otp = process.argv[3];
const events = [];
function log(obj){ events.push({t:Date.now(), ...obj}); console.log(JSON.stringify(obj)); }

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
});
const context = await browser.newContext({ locale: 'en-US', viewport: {width: 430, height: 932} });
const page = await context.newPage();

page.on('request', req => {
  const url = req.url();
  if (url.includes('oem-api') || url.includes('oem-core') || url.includes('/saas-api/') || url.includes('pay.willclouds')) {
    log({type:'request', method:req.method(), url, headers:req.headers(), postData:req.postData()});
  }
});
page.on('response', async res => {
  const url = res.url();
  if (url.includes('oem-api') || url.includes('oem-core') || url.includes('/saas-api/') || url.includes('pay.willclouds')) {
    let body = null;
    try { body = await res.text(); if (body && body.length > 15000) body = body.slice(0,15000)+'...<truncated>'; } catch(e){ body = String(e); }
    log({type:'response', status:res.status(), url, body});
  }
});

async function clickByText(regex) {
  return page.evaluate((src)=>{
    const re = new RegExp(src, 'i');
    function vis(el){const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    const els=[...document.querySelectorAll('*')].filter(e=>vis(e) && re.test((e.innerText||'').trim()) && (e.innerText||'').trim().length<60);
    els.sort((a,b)=>a.getBoundingClientRect().width*a.getBoundingClientRect().height - b.getBoundingClientRect().width*b.getBoundingClientRect().height);
    if(els[0]){els[0].click(); return els[0].innerText.trim();}
    return null;
  }, regex.source);
}

try {
  await page.goto('https://h5.willclouds.com/h5app/?clientCode=ae02b', {waitUntil:'networkidle', timeout:60000});
  await page.waitForTimeout(3000);
  await clickByText(/^Email$/);
  await page.waitForTimeout(800);

  // fill email
  await page.evaluate((val)=>{
    function vis(el){const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    const el=[...document.querySelectorAll('input')].find(e=>vis(e) && (e.type==='text'||e.type==='email'));
    if(el){ el.focus(); el.value=val; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  }, email);
  await page.waitForTimeout(400);
  // fill otp
  await page.evaluate((code)=>{
    function vis(el){const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    const inputs=[...document.querySelectorAll('input')].filter(vis);
    let el = inputs.find(e=>e.type==='number' || e.type==='tel');
    if(!el) el = inputs[1];
    if(el){ el.focus(); el.value=code; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  }, otp);
  await page.waitForTimeout(600);
  await page.screenshot({path:'/tmp/umo-login-filled.png', fullPage:true});

  // click any agreement/checkbox if present
  await page.evaluate(()=>{
    function vis(el){const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    [...document.querySelectorAll('checkbox,.uni-checkbox-input,.checklist-box,input[type=checkbox]')].filter(vis).forEach(e=>{try{e.click()}catch{}});
  });

  const clickedLogin = await page.evaluate(()=>{
    function vis(el){const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    const els=[...document.querySelectorAll('*')].filter(e=>vis(e));
    let btn = els.find(e=>/^login$/i.test((e.innerText||'').trim()));
    if(!btn) btn = els.find(e=>/^sign in$/i.test((e.innerText||'').trim()));
    if(btn){btn.click(); return btn.innerText.trim();}
    return null;
  });
  log({type:'info', step:'login_clicked', clickedLogin});

  // wait and observe - handle possible agreement dialog appearing after click
  for (let i=0;i<12;i++) {
    await page.waitForTimeout(2000);
    const dom = await page.evaluate(()=>document.body.innerText.slice(0,4000));
    log({type:'tick', i, url: page.url(), dom});
    // if agreement dialog with "Agree" / "同意" appears, click it
    const agreed = await page.evaluate(()=>{
      function vis(el){const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
      const els=[...document.querySelectorAll('*')].filter(vis);
      const btn = els.find(e=>/^(agree|同意|accept|i agree)$/i.test((e.innerText||'').trim()));
      if(btn){btn.click(); return btn.innerText.trim();}
      return null;
    });
    if (agreed) log({type:'info', step:'agreed', agreed});
    if (/cloud phone|device|experience|trial|领取|体验|instance|我的云机/i.test(dom) && !/Enter 6-digit code/i.test(dom)) {
      log({type:'info', step:'looks_logged_in'});
      break;
    }
  }
  await page.waitForTimeout(10000);
  await page.screenshot({path:'/tmp/umo-after-login2.png', fullPage:true});
  const finalDom = await page.evaluate(()=>document.body.innerText.slice(0,12000));
  log({type:'dom', step:'final', text: finalDom});
  log({type:'url', step:'final', url: page.url()});
  const storage = await page.evaluate(()=>{
    const ls = {}; try{ for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i); ls[k]=localStorage.getItem(k);} }catch(e){}
    return ls;
  });
  log({type:'storage', data: storage});
} catch(e) {
  log({type:'error', error:String(e), stack:e.stack});
  try { log({type:'dom', step:'error', text: await page.evaluate(()=>document.body.innerText.slice(0,8000))}); } catch {}
}

fs.writeFileSync('/tmp/umo-login-net.jsonl', events.map(x=>JSON.stringify(x)).join('\n')+'\n');
await browser.close();
