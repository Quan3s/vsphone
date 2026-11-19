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

page.on('request', req => {
  const url = req.url();
  if (url.includes('/h5-api') || url.includes('/api') || url.includes('captcha') || url.includes('code') || url.includes('login') || url.includes('register') || url.includes('verify') || url.includes('send')) {
    log({type:'request', method:req.method(), url, headers:req.headers(), postData:req.postData()});
  }
});
page.on('response', async res => {
  const url = res.url();
  if (url.includes('/h5-api') || url.includes('/api') || url.includes('captcha') || url.includes('code') || url.includes('login') || url.includes('register') || url.includes('verify') || url.includes('send')) {
    let body=null; try{ body=await res.text(); if(body&&body.length>8000) body=body.slice(0,8000)+'...<truncated>'; }catch(e){ body=String(e); }
    log({type:'response', status:res.status(), url, headers:res.headers(), body});
  }
});

async function dump(step){
  await page.waitForTimeout(1500);
  await page.screenshot({path:`/tmp/qt-m-${step}.png`, fullPage:true});
  const text = await page.evaluate(()=>document.body.innerText.slice(0,10000));
  log({type:'dom', step, url: page.url(), text});
  const html = await page.evaluate(()=>document.body.innerHTML.slice(0,15000));
  fs.writeFileSync(`/tmp/qt-m-${step}.html`, html);
}

try {
  await page.goto('https://m.qtphone.com', {waitUntil:'networkidle', timeout:60000});
  await page.waitForTimeout(3000);
  await dump('1-home');

  // click Continue
  const clicked = await page.evaluate(()=>{
    function vis(el){const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    const els=[...document.querySelectorAll('*')].filter(e=>vis(e) && /continue|log in|sign up|登录|继续/i.test((e.innerText||'').trim()) && (e.innerText||'').trim().length<40);
    els.sort((a,b)=>a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height);
    if(els[0]){els[0].click(); return {t:els[0].innerText.trim(),tag:els[0].tagName,cls:els[0].className};}
    return null;
  });
  log({type:'action', step:'click-continue', clicked});
  await dump('2-after-continue');

  // dump inputs visible
  const inputs = await page.evaluate(()=>{
    function vis(el){const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    return [...document.querySelectorAll('input,textarea')].map((el,i)=>({i,vis:vis(el),type:el.type,placeholder:el.placeholder,value:el.value,name:el.name,cls:el.className}));
  });
  log({type:'inputs', step:'after-continue', inputs});

} catch(e) {
  log({type:'error', error:String(e), stack:(e.stack||'').slice(0,1500)});
  try{ await dump('error'); }catch{}
}

fs.writeFileSync('/tmp/qt-m-flow-net.jsonl', events.map(x=>JSON.stringify(x)).join('\n')+'\n');
await browser.close();
