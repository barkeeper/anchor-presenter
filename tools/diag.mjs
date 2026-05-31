import { chromium } from 'playwright';
const ORIGIN = process.argv[2] || 'http://127.0.0.1:5173';
const b = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const p = await (await b.newContext()).newPage();
p.on('pageerror', (e) => console.log('PAGEERR', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE.ERR', m.text().slice(0, 160)); });
await p.goto(ORIGIN + '/', { waitUntil: 'load' });
await p.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, { timeout: 60000 });
await p.fill('#input', 'Say hi in one short sentence.');
await p.click('#send');
let prev = '';
for (let i = 0; i < 320; i++) {
  const s = await p.evaluate(() => ({
    onair: document.getElementById('onair').classList.contains('live'),
    think: document.getElementById('onair').classList.contains('think'),
    stop: !document.getElementById('stopBtn').hidden,
    cap: document.getElementById('caption').classList.contains('show'),
    status: document.getElementById('status').textContent,
    blen: (document.querySelector('.msg.assistant .bubble')?.textContent || '').length,
    speaking: !!window.__spk,
  }));
  const key = JSON.stringify(s);
  if (key !== prev) { console.log((i * 0.3).toFixed(1) + 's', key); prev = key; }
  await p.waitForTimeout(300);
  if (s.status === 'ready' && !s.onair && !s.think && i > 20 && s.blen > 0) { /* keep going a bit to see speak */ }
}
await b.close();
