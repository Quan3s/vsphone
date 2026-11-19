import { chromium } from '/app/vsphone/node_modules/playwright/index.mjs';
import fs from 'fs';

const mailCreds = JSON.parse(fs.readFileSync('/tmp/mailtm.json','utf8'));
const email = mailCreds.address;
const mailPass = mailCreds.password;

const events = [];
function log(obj){ events.push({t:Date.now(), ...obj}); console.log(JSON.stringify(obj)); }
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function mailToken() {
  const res = await fetch('https://api.mail.tm/token', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({address:email,password:mailPass})});
  const t = await res.text();
  if (!res.ok) throw new Error('mailtm token '+res.status+' '+t);
  return JSON.parse(t).token;
}
async function getOtp(sinceTs, tries=45) {
  for (let i=0;i<tries;i++) {
    try {
      const tok = await mailToken();
      const res = await fetch('https://api.mail.tm/messages', {headers:{Authorization:`Bearer ${tok}`}});
      const t = await res.text();
      if (!res.ok) { log({type:'mail-poll-err', status:res.status, body:t.slice(0,200)}); await sleep(4000); continue; }
      const j = JSON.parse(t);
      const msgs = j['hydra:member'] || [];
      if (msgs.length>0) {
        const id = msgs[0].id;
        const r2 = await fetch(`https://api.mail.tm/messages/${id}`, {headers:{Authorization:`Bearer ${tok}`}});
        const m = await r2.json();
        const text = (m.subject||'')+'\n'+(m.intro||'')+'\n'+(m.text||'')+'\n'+(m.html||'');
        const match = text.match(/\b(\d{6})\b/) || text.match(/\b(\d{4,8})\b/);
        log({type:'mail', msg:{subject:m.subject,intro:m.intro,from:m.from}, otp: match?match[1]:null});
        if (match) return match[1];
      }
    } catch(e) {
      log({type:'mail-poll-ex', err:String(e)});
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
  if (url.includes('/saas-api/') || url.includes('oem-api') || url.includes('oem-core') || url.includes('pay.willclouds')) {
    log({type:'request', method:req.method(), url, headers:req.headers(), postData:req.postData()});
  }
});
page.on('response', async res => {
  const url = res.url();
  if (url.includes('/saas-api/') || url.includes('oem-api') || url.includes('oem-core') || url.includes('pay.willclouds')) {
    let body = null;
    try { body = await res.text(); if (body && body.length > 20000) body = body.slice(0,20000)+'...<truncated>'; } catch(e){ body = String(e); }
    log({type:'response', status:res.status(), url, body});
  }
});

const vis = () => ({});
async function clickText(regex) {
  return page.evaluate((s)=>{
    const re=new RegExp(s,'i');
    function v(el){const r=el.getBoundingClientRect(); const st=getComputedStyle(el); return r.width>0&&r.height>0&&st.visibility!=='hidden'&&st.display!=='none';}
    const els=[...document.querySelectorAll('*')].filter(e=>v(e)&&re.test((e.innerText||'').trim())&&(e.innerText||'').trim().length<80);
    els.sort((a,b)=>a.getBoundingClientRect().width*a.getBoundingClientRect().height-b.getBoundingClientRect().width*b.getBoundingClientRect().height);
    if(els[0]){els[0].click(); return {t:els[0].innerText.trim(),tag:els[0].tagName};}
    return null;
  }, regex.source);
}

try {
  await page.goto('https://h5.willclouds.com/h5app/?clientCode=ae02b', {waitUntil:'networkidle', timeout:60000});
  await page.waitForTimeout(3500);
  await clickText(/^Email$/); await sleep(800);

  // fill email
  await page.evaluate((val)=>{
    function v(el){const r=el.getBoundingClientRect(); const st=getComputedStyle(el); return r.width>0&&r.height>0&&st.visibility!=='hidden'&&st.display!=='none';}
    const el=[...document.querySelectorAll('input')].find(e=>v(e)&&(e.type==='text'||e.type==='email'));
    if(el){el.focus(); el.value=val; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));}
  }, email);
  await sleep(600);
  const beforeSend = Date.now();
  log({type:'info', step:'send_code_click', r: await clickText(/^Get Code$/)});
  await sleep(7000);
  await page.screenshot({path:'/tmp/umo2-sent.png', fullPage:true});
  log({type:'dom', step:'sent', text: await page.evaluate(()=>document.body.innerText.slice(0,5000))});

  const otp = await getOtp(beforeSend, 45);
  if (!otp) throw new Error('no otp');
  log({type:'info', step:'got_otp', otp});

  // fill otp
  await page.evaluate((code)=>{
    function v(el){const r=el.getBoundingClientRect(); const st=getComputedStyle(el); return r.width>0&&r.height>0&&st.visibility!=='hidden'&&st.display!=='none';}
    const inputs=[...document.querySelectorAll('input')].filter(v);
    let el=inputs.find(e=>e.type==='number'||e.type==='tel');
    if(!el) el=inputs.find(e=>e!==inputs.find(x=>x.type==='text'||x.type==='email'));
    if(!el && inputs.length>1) el=inputs[1];
    if(el){el.focus(); el.value=code; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));}
  }, otp);
  await sleep(800);

  // inspect for agreements/checkboxes
  const uiState = await page.evaluate(()=>{
    function v(el){const r=el.getBoundingClientRect(); const st=getComputedStyle(el); return r.width>0&&r.height>0&&st.visibility!=='hidden'&&st.display!=='none';}
    const checks=[...document.querySelectorAll('input[type=checkbox],checkbox,.uni-checkbox-input,.uni-checkbox-wrapper,[class*=check],[class*=agree]')].map(e=>({tag:e.tagName,cls:e.className,checked:e.checked,text:(e.innerText||'').slice(0,60),vis:v(e)}));
    const texts=[...document.querySelectorAll('*')].filter(e=>v(e)&&/agree|policy|terms|protocol|同意|协议/i.test(e.innerText||'')&&(e.innerText||'').length<120).map(e=>({tag:e.tagName,cls:e.className,text:(e.innerText||'').trim().slice(0,80)}));
    const btns=[...document.querySelectorAll('*')].filter(e=>v(e)&&/login|sign/i.test((e.innerText||'').trim())&&(e.innerText||'').trim().length<30).map(e=>({tag:e.tagName,cls:e.className,text:(e.innerText||'').trim(),disabled:e.disabled,aria:e.getAttribute('aria-disabled')}));
    return {checks,texts,btns,body:document.body.innerText.slice(0,3000)};
  });
  log({type:'ui-before-login', data: uiState});

  // click agreement related elements if any
  await page.evaluate(()=>{
    function v(el){const r=el.getBoundingClientRect(); const st=getComputedStyle(el); return r.width>0&&r.height>0&&st.visibility!=='hidden'&&st.display!=='none';}
    // try checkbox wrappers
    const cbs=[...document.querySelectorAll('.uni-checkbox-input,.uni-checkbox-wrapper,uni-checkbox,checkbox')].filter(v);
    cbs.forEach(e=>{try{e.click()}catch{}});
    // try small circles/icons near agreement text
    const agreeTexts=[...document.querySelectorAll('*')].filter(e=>v(e)&&/I have read|agree|同意/i.test((e.innerText||''))&&(e.innerText||'').length<120);
    agreeTexts.forEach(e=>{try{e.click()}catch{}});
  });
  await sleep(800);
  await page.screenshot({path:'/tmp/umo2-before-login.png', fullPage:true});

  log({type:'info', step:'login_click', r: await clickText(/^Login$/)});
  for(let i=0;i<15;i++){
    await sleep(2000);
    const state = await page.evaluate(()=>({url:location.href, text:document.body.innerText.slice(0,5000)}));
    // click dialog buttons if any
    const dialogBtn = await page.evaluate(()=>{
      function v(el){const r=el.getBoundingClientRect(); const st=getComputedStyle(el); return r.width>0&&r.height>0&&st.visibility!=='hidden'&&st.display!=='none';}
      const els=[...document.querySelectorAll('*')].filter(v);
      const b=els.find(e=>/^(agree and login|agree|同意并登录|同意|confirm|ok)$/i.test((e.innerText||'').trim()));
      if(b){b.click(); return b.innerText.trim();}
      return null;
    });
    if(dialogBtn) log({type:'dialog-click', btn:dialogBtn, i});
    log({type:'tick', i, url:state.url, text:state.text});
    if(!/Enter 6-digit code/i.test(state.text) && /cloud|phone|mine|device|experience|trial|领取|体验|没有云手机|我的|home/i.test(state.text)) {
      log({type:'info', step:'logged_in_detected'});
      break;
    }
  }
  await sleep(12000);
  await page.screenshot({path:'/tmp/umo2-final.png', fullPage:true});
  log({type:'dom', step:'final', text: await page.evaluate(()=>document.body.innerText.slice(0,15000))});
  log({type:'url', step:'final', url: page.url()});
  const storage = await page.evaluate(()=>{const ls={}; try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i); ls[k]=localStorage.getItem(k);}}catch(e){} return ls;});
  log({type:'storage', data: storage});

} catch(e) {
  log({type:'error', error:String(e), stack:(e.stack||'').slice(0,2000)});
  try { await page.screenshot({path:'/tmp/umo2-error.png', fullPage:true}); } catch {}
  try { log({type:'dom', step:'error', text: await page.evaluate(()=>document.body.innerText.slice(0,8000))}); } catch {}
}

fs.writeFileSync('/tmp/umo-e2e2-net.jsonl', events.map(x=>JSON.stringify(x)).join('\n')+'\n');
await browser.close();
