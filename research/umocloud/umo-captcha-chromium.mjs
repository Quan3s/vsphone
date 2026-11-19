import { chromium } from '/app/vsphone/node_modules/playwright/index.mjs';
import fs from 'fs';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome',
  headless: true,
  args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
});
const context = await browser.newContext({ locale: 'en-US', viewport: {width: 430, height: 932} });
const page = await context.newPage();

const events = [];
page.on('response', async res => {
  const url = res.url();
  if (url.includes('/saas-api/cloud-client/auth/get-captcha')) {
    let bodyInfo = null;
    try {
      const buf = await res.body();
      bodyInfo = { len: buf.length, ct: res.headers()['content-type'], head: buf.slice(0,16).toString('hex') };
      fs.writeFileSync('/tmp/umo-captcha-via-chromium.bin', buf);
    } catch(e) { bodyInfo = {err:String(e)}; }
    events.push({type:'captcha-response', status:res.status(), url, headers:res.headers(), bodyInfo});
  }
});

await page.goto('https://h5.willclouds.com/h5app/?clientCode=ae02b', {waitUntil:'networkidle', timeout:60000});
await page.waitForTimeout(3000);

// try to get captcha via in-page app mechanisms: read storage and call fetch like app
const result = await page.evaluate(async () => {
  function javaURLEncode(str){
    const bytes = new TextEncoder().encode(String(str));
    let out='';
    for(const b of bytes){
      if(b===32) out+='+';
      else if((b>=48&&b<=57)||(b>=65&&b<=90)||(b>=97&&b<=122)||b===45||b===46||b===95||b===42) out+=String.fromCharCode(b);
      else out+='%'+b.toString(16).toUpperCase().padStart(2,'0');
    }
    return out;
  }
  function objectToQueryString(obj){
    const keys=Object.keys(obj).sort((a,b)=>a.localeCompare(b));
    return keys.map(k=>javaURLEncode(k)+'='+javaURLEncode(obj[k])).join('&');
  }
  async function md5hex(msg){
    // simple md5 impl
    function cmn(q,a,b,x,s,t){a=(a+q+(x>>>0)+(t>>>0))>>>0;return(((a<<s)|(a>>>(32-s)))+b)>>>0;}
    function ff(a,b,c,d,x,s,t){return cmn((b&c)|((~b)&d),a,b,x,s,t);}
    function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&(~d)),a,b,x,s,t);}
    function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t);}
    function ii(a,b,c,d,x,s,t){return cmn(c^(b|(~d)),a,b,x,s,t);}
    function md5cycle(x,k){
      let[a,b,c,d]=x;
      a=ff(a,b,c,d,k[0],7,-680876936); d=ff(d,a,b,c,k[1],12,-389564586); c=ff(c,d,a,b,k[2],17,606105819); b=ff(b,c,d,a,k[3],22,-1044525330);
      a=ff(a,b,c,d,k[4],7,-176418897); d=ff(d,a,b,c,k[5],12,1200080426); c=ff(c,d,a,b,k[6],17,-1473231341); b=ff(b,c,d,a,k[7],22,-45705983);
      a=ff(a,b,c,d,k[8],7,1770035416); d=ff(d,a,b,c,k[9],12,-1958414417); c=ff(c,d,a,b,k[10],17,-42063); b=ff(b,c,d,a,k[11],22,-1990404162);
      a=ff(a,b,c,d,k[12],7,1804603682); d=ff(d,a,b,c,k[13],12,-40341101); c=ff(c,d,a,b,k[14],17,-1502002290); b=ff(b,c,d,a,k[15],22,1236535329);
      a=gg(a,b,c,d,k[1],5,-165796510); d=gg(d,a,b,c,k[6],9,-1069501632); c=gg(c,d,a,b,k[11],14,643717713); b=gg(b,c,d,a,k[0],20,-373897302);
      a=gg(a,b,c,d,k[5],5,-701558691); d=gg(d,a,b,c,k[10],9,38016083); c=gg(c,d,a,b,k[15],14,-660478335); b=gg(b,c,d,a,k[4],20,-405537848);
      a=gg(a,b,c,d,k[9],5,568446438); d=gg(d,a,b,c,k[14],9,-1019803690); c=gg(c,d,a,b,k[3],14,-187363961); b=gg(b,c,d,a,k[8],20,1163531501);
      a=gg(a,b,c,d,k[13],5,-1444681467); d=gg(d,a,b,c,k[2],9,-51403784); c=gg(c,d,a,b,k[7],14,1735328473); b=gg(b,c,d,a,k[12],20,-1926607734);
      a=hh(a,b,c,d,k[5],4,-378558); d=hh(d,a,b,c,k[8],11,-2022574463); c=hh(c,d,a,b,k[11],16,1839030562); b=hh(b,c,d,a,k[14],23,-35309556);
      a=hh(a,b,c,d,k[1],4,-1530992060); d=hh(d,a,b,c,k[4],11,1272893353); c=hh(c,d,a,b,k[7],16,-155497632); b=hh(b,c,d,a,k[10],23,-1094730640);
      a=hh(a,b,c,d,k[13],4,681279174); d=hh(d,a,b,c,k[0],11,-358537222); c=hh(c,d,a,b,k[3],16,-722521979); b=hh(b,c,d,a,k[6],23,76029189);
      a=hh(a,b,c,d,k[9],4,-640364487); d=hh(d,a,b,c,k[12],11,-421815835); c=hh(c,d,a,b,k[15],16,530742520); b=hh(b,c,d,a,k[2],23,-995338651);
      a=ii(a,b,c,d,k[0],6,-198630844); d=ii(d,a,b,c,k[7],10,1126891415); c=ii(c,d,a,b,k[14],15,-1416354905); b=ii(b,c,d,a,k[5],21,-57434055);
      a=ii(a,b,c,d,k[12],6,1700485571); d=ii(d,a,b,c,k[3],10,-1894986606); c=ii(c,d,a,b,k[10],15,-1051523); b=ii(b,c,d,a,k[1],21,-2054922799);
      a=ii(a,b,c,d,k[8],6,1873313359); d=ii(d,a,b,c,k[15],10,-30611744); c=ii(c,d,a,b,k[6],15,-1560198380); b=ii(b,c,d,a,k[13],21,1309151649);
      a=ii(a,b,c,d,k[4],6,-145523070); d=ii(d,a,b,c,k[11],10,-1120210379); c=ii(c,d,a,b,k[2],15,718787259); b=ii(b,c,d,a,k[9],21,-343485551);
      x[0]=(x[0]+a)>>>0; x[1]=(x[1]+b)>>>0; x[2]=(x[2]+c)>>>0; x[3]=(x[3]+d)>>>0;
    }
    function md51(s){
      const n=s.length; let state=[1732584193,-271733879,-1732584194,271733878]; let i;
      for(i=64;i<=n;i+=64){
        const blk=[]; for(let j=0;j<64;j+=4) blk[j>>2]=s.charCodeAt(i-64+j)|(s.charCodeAt(i-64+j+1)<<8)|(s.charCodeAt(i-64+j+2)<<16)|(s.charCodeAt(i-64+j+3)<<24);
        md5cycle(state,blk);
      }
      const tail=new Array(16).fill(0);
      let j=0; for(;i-64+j<n;j++) tail[j>>2]|=s.charCodeAt(i-64+j)<<((j%4)*8);
      tail[j>>2]|=0x80<<((j%4)*8);
      if(j>55){ md5cycle(state,tail); tail.fill(0); }
      const bits=n*8; tail[14]=bits&0xffffffff; tail[15]=Math.floor(bits/0x100000000);
      md5cycle(state,tail); return state;
    }
    function rhex(n){const h='0123456789abcdef'; let s=''; for(let j=0;j<4;j++) s+=h[(n>>(j*8+4))&0x0f]+h[(n>>(j*8))&0x0f]; return s;}
    const bytes = new TextEncoder().encode(msg);
    let bin=''; for(const b of bytes) bin+=String.fromCharCode(b);
    return md51(bin).map(rhex).join('');
  }

  const ci = localStorage.getItem('clientInfo');
  const clientInfo = ci ? JSON.parse(ci) : null;
  const salt = clientInfo?.signatureSalt || '4d9cbb6b585448419578a95954a2b886';
  const tenantId = String(clientInfo?.tenantId || '242');
  const brandId = String(clientInfo?.clientBrandId || '108');
  const chnl = clientInfo?.channelCode || 'h5_cphone';
  const cuid = Date.now()+''+Math.floor(1000000+Math.random()*9000000)+'ae02b';
  const params = {cuid, ts: Date.now()+'', userId:'', cid:'50000', chnl, cver:'1001021', locale:'en-US', clientType:'h5', type:'MAIL'};
  const qs = objectToQueryString(params);
  const w = await md5hex(qs + salt);
  const sig = w.slice(4,20);
  const res = await fetch('https://oem-api.willclouds.com/saas-api/cloud-client/auth/get-captcha', {
    method:'POST',
    headers:{'x-signature':sig,'content-type':'application/x-www-form-urlencoded','tenant-id':tenantId,'client-brand-id':brandId,'timezone':'Asia/Saigon','accept-language':'en-US'},
    body: qs
  });
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin=''; for(let i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return {status:res.status, ct:res.headers.get('content-type'), len:buf.byteLength, dataUrl:'data:image/jpeg;base64,'+b64, clientInfo: {tenantId, brandId, chnl, hasSalt: !!clientInfo?.signatureSalt}};
});

console.log(JSON.stringify({events, meta:{status:result.status, ct:result.ct, len:result.len, clientInfo:result.clientInfo}}));
fs.writeFileSync('/tmp/umo-captcha-dataurl.txt', result.dataUrl);
await page.screenshot({path:'/tmp/umo-page.png', fullPage:false});
await browser.close();
