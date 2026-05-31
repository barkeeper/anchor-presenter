// Full-feature UI test (sample-based, race-free): streaming reply, captions,
// ON AIR, mid-speech stop, settings persistence, service-worker control.
import { chromium } from 'playwright';
const ORIGIN = process.argv[2] || 'http://127.0.0.1:5173';
const errors = [];
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 140)); });

await page.goto(ORIGIN + '/', { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, { timeout: 60000 });

// settings: open, change speed, verify persistence + model list
await page.click('#settingsBtn'); await page.waitForTimeout(300);
await page.$eval('#speed', (el) => { el.value = '1.2'; el.dispatchEvent(new Event('input', { bubbles: true })); });
const persisted = await page.evaluate(() => ({ speed: localStorage.getItem('anchor.speed'), models: document.querySelectorAll('#modelSel option').length }));
await page.click('#settingsPanel [data-close]'); await page.waitForTimeout(200);

await page.fill('#input', 'Tell me one fun fact in two short sentences!');
await page.click('#send');
console.log('Sent. Sampling state (first run downloads models)…');

const seen = { think: false, live: false, caption: false, stop: false };
let stoppedOk = false, clickedStop = false, finalReply = '', liveAt = -1;
for (let i = 0; i < 1200; i++) { // up to 6 min
  const s = await page.evaluate(() => ({
    live: document.getElementById('onair').classList.contains('live'),
    think: document.getElementById('onair').classList.contains('think'),
    stop: !document.getElementById('stopBtn').hidden,
    cap: document.getElementById('caption').classList.contains('show'),
    status: document.getElementById('status').textContent,
    blen: (document.querySelector('.msg.assistant .bubble')?.textContent || '').length,
  }));
  seen.think ||= s.think; seen.live ||= s.live; seen.caption ||= s.cap; seen.stop ||= s.stop;
  if (s.live && liveAt < 0) liveAt = i;
  // let it speak briefly (captions appear a beat after ON AIR), then exercise Stop
  if (liveAt >= 0 && !clickedStop && (seen.caption || i - liveAt >= 10)) { clickedStop = true; await page.click('#stopBtn').catch(() => {}); await page.waitForTimeout(700); stoppedOk = await page.evaluate(() => !document.getElementById('onair').classList.contains('live') && document.getElementById('stopBtn').hidden); }
  if (clickedStop && stoppedOk) { finalReply = await page.evaluate(() => (document.querySelector('.msg.assistant .bubble')?.textContent || '').trim()); break; }
  await page.waitForTimeout(300);
}

// SW controls after reload
await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(1500);
const swControlled = await page.evaluate(() => !!navigator.serviceWorker.controller);

console.log('RESULT', JSON.stringify({ persisted, seen, stoppedOk, swControlled, reply: finalReply.slice(0, 120) }, null, 2));
console.log('ERRORS:', errors.length ? errors.join('\n  ') : '(none)');
await browser.close();
const ok = persisted.speed === '1.2' && persisted.models >= 2 && seen.think && seen.live && seen.stop && seen.caption && stoppedOk && swControlled && !errors.length;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
