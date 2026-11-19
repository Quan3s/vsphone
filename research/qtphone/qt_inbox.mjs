const local = process.argv[2];
if (!local) { console.error('usage: node qt_inbox.mjs <localpart>'); process.exit(1); }
const base = 'https://inboxkitten.com/api/v1/mail';
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function list() {
  const r = await fetch(`${base}/list?recipient=${encodeURIComponent(local)}`, {headers:{'accept':'application/json'}});
  if (!r.ok) throw new Error(`list ${r.status} ${await r.text()}`);
  return await r.json();
}
async function getHtml(region,key) {
  const r = await fetch(`${base}/getHtml?region=${encodeURIComponent(region)}&key=${encodeURIComponent(key)}`);
  if (!r.ok) throw new Error(`getHtml ${r.status}`);
  return await r.text();
}
function extractOtp(text) {
  const m = text.match(/\b(\d{4,8})\b/);
  return m ? m[1] : null;
}

const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  const msgs = await list();
  console.log('msgs', msgs.length);
  if (msgs.length > 0) {
    const msg = msgs[msgs.length-1];
    const region = msg.storage?.region;
    const key = msg.storage?.key;
    console.log('msg keys', Object.keys(msg), msg.message?.headers?.subject);
    if (region && key) {
      const html = await getHtml(region,key);
      const text = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      console.log('body', text.slice(0,500));
      const otp = extractOtp(text);
      console.log('OTP', otp);
      process.exit(0);
    }
  }
  await sleep(5000);
}
console.log('timeout');
process.exit(2);
