import { chromium } from '/app/vsphone/node_modules/playwright/index.mjs';
import fs from 'fs';

const email = process.argv[2];
const mailToken = process.argv[3];
if (!email || !mailToken) { console.error('usage: node umo-e2e.mjs <email> <mailtmToken>'); process.exit(1); }

const events = [];
function log(obj){ events.push({t:Date.now(), ...obj}); console.log(JSON.stringify(obj)); }

async function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function getOtp(token, tries=30) {
  for (let i=0;i<tries;i++) {
    const res = await fetch('https://api.mail.tm/messages', {headers:{Authorization:`Bearer ${token}`}});
    const j = await res.json();
    const msgs = j['hydra:member'] || j['hydra:members'] || [];
    if (msgs.length>0) {
      const id = msgs[0].id;
      const r2 = await fetch(`https://api.mail.tm/messages/${id}`, {headers:{Authorization:`Bearer ${token}`}});
      const m = await r2.json();
      const text = (m.text||'') + '\n' + (m.html||'') + '\n' + (m.intro||'') + '\n' + (m.subject||'');
      const match = text.match(/\b(\d{4,8})\b/);
      return {msg:m, otp: match?match[1]:null, text};
    }
    await sleep(4000);
  }
  return null;
}

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
    try { body = await res.text(); if (body && body.length > 12000) body = body.slice(0,12000)+'...<truncated>'; } catch(e){ body = String(e); }
    log({type:'response', status:res.status(), url, body});
  }
});

try {
  await page.goto('https://h5.willclouds.com/h5app/?clientCode=ae02b', {waitUntil:'networkidle', timeout:60000});
  await page.waitForTimeout(3000);

  // ensure Email tab
  try { await page.getByText(/^Email$/i).first().click({timeout:2000}); } catch {}
  await page.waitForTimeout(800);

  // fill email (visible text input)
  await page.evaluate((val)=>{
    function vis(el){const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    const el=[...document.querySelectorAll('input')].find(e=>vis(e) && (e.type==='text'||e.type==='email'));
    if(el){ el.focus(); el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); el.value=val; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  }, email);
  await page.waitForTimeout(500);

  // click Get Code
  await page.evaluate(()=>{
    function vis(el){const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    const el=[...document.querySelectorAll('*')].find(e=>vis(e) && /^get code$/i.test((e.innerText||'').trim()));
    if(el) el.click();
  });
  log({type:'info', step:'clicked_get_code'});
  await page.waitForTimeout(4000);
  await page.screenshot({path:'/tmp/umo-e2e-1-sent.png', fullPage:true});
  log({type:'dom', step:'sent', text: await page.evaluate(()=>document.body.innerText.slice(0,6000))});

  // wait for OTP
  log({type:'info', step:'waiting_otp'});
  const mail = await getOtp(mailToken, 40);
  log({type:'mail', result: mail ? {otp: mail.otp, subject: mail.msg.subject, from: mail.msg.from, intro: mail.msg.intro, text: (mail.text||'').slice(0,2000)} : null});
  if (!mail || !mail.otp) throw new Error('no otp received');

  // enter OTP in visible code input (number input)
  await page.evaluate((code)=>{
    function vis(el){const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    const inputs=[...document.querySelectorAll('input')].filter(vis);
    // code input likely type number or placeholder has code/6-digit
    let el = inputs.find(e=>/code|digit|6/i.test(e.placeholder||''));
    if(!el) el = inputs.find(e=>e.type==='number' || e.type==='tel');
    if(!el) el = inputs[1] || inputs[0];
    if(el){ el.focus(); el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); el.value=code; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
  }, mail.otp);
  await page.waitForTimeout(800);
  await page.screenshot({path:'/tmp/umo-e2e-2-code.png', fullPage:true});

  // handle possible agreement checkbox/dialog then click Login
  // try click agreement checkbox/text if exists
  await page.evaluate(()=>{
    function vis(el){const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    const texts=[...document.querySelectorAll('*')].filter(e=>vis(e) && /agree|protocol|policy|terms/i.test((e.innerText||'')) && (e.innerText||'').length<200);
    // click checkbox-like elements
    const cb=[...document.querySelectorAll('checkbox,.uni-checkbox-input,.checkbox,input[type=checkbox]')].filter(vis);
    cb.forEach(e=>{ try{e.click();}catch{} });
  });
  await page.waitForTimeout(500);

  await page.evaluate(()=>{
    function vis(el){const r=el.getBoundingClientRect(); const s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
    // click Login button
    const els=[...document.querySelectorAll('*')].filter(e=>vis(e));
    let btn = els.find(e=>/^login$/i.test((e.innerText||'').trim()));
    if(!btn) btn = els.find(e=>/login/i.test((e.innerText||'').trim()) && e.tagName.match(/BUTTON|UNI-BUTTON|UNI-VIEW/));
    if(btn) btn.click();
  });
  log({type:'info', step:'clicked_login'});
  await page.waitForTimeout(10000);
  await page.screenshot({path:'/tmp/umo-e2e-3-afterlogin.png', fullPage:true});
  log({type:'dom', step:'after_login', text: await page.evaluate(()=>document.body.innerText.slice(0,10000))});
  log({type:'url', step:'after_login', url: page.url()});

  // try to navigate around / wait for app to settle and maybe trigger get-experience-qual
  await page.waitForTimeout(8000);
  await page.screenshot({path:'/tmp/umo-e2e-4-settled.png', fullPage:true});
  log({type:'dom', step:'settled', text: await page.evaluate(()=>document.body.innerText.slice(0,10000))});
  log({type:'url', step:'settled', url: page.url()});

  // dump local storage / storage state
  const storage = await page.evaluate(()=>{
    const ls = {}; try{ for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i); ls[k]=localStorage.getItem(k);} }catch(e){}
    return ls;
  });
  log({type:'storage', data: storage});

} catch(e) {
  log({type:'error', error:String(e), stack:e.stack});
  try { await page.screenshot({path:'/tmp/umo-e2e-error.png', fullPage:true}); } catch {}
  try { log({type:'dom', step:'error', text: await page.evaluate(()=>document.body.innerText.slice(0,8000))}); } catch {}
}

fs.writeFileSync('/tmp/umo-e2e-net.jsonl', events.map(x=>JSON.stringify(x)).join('\n')+'\n');
await browser.close();
