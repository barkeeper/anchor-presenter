import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
const errs = [];
p.on('pageerror', e => errs.push('PAGEERR ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('console ' + m.text().slice(0, 200)); });
await p.goto('http://127.0.0.1:5173/index.html', { waitUntil: 'load' });
await p.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, { timeout: 60000 });
await p.waitForTimeout(8000);
await p.screenshot({ path: 'tools/_vrm_idle.png' });
// speak
await p.fill('#input', 'Tell me something exciting in two short sentences!');
await p.click('#send');
let live = false;
for (let i = 0; i < 800; i++) {
  const s = await p.evaluate(() => document.getElementById('onair').classList.contains('live'));
  if (s) { live = true; await p.waitForTimeout(1500); await p.screenshot({ path: 'tools/_vrm_speak.png' }); break; }
  await p.waitForTimeout(300);
}
import fs from 'fs';
fs.writeFileSync('tools/_vrm_result.json', JSON.stringify({ live, errors: errs }, null, 2));
await b.close();
