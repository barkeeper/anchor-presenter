// wasm-only-probe.mjs — force device=wasm + the small model BEFORE the app boots,
// so the very first (and only) ORT attempt is the wasm EP. No prior webgpu attempt
// to contaminate global state. Tells us whether CPU inference works at all here.
import { chromium } from 'playwright';
import fs from 'fs';

const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const b = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
// Seed localStorage so app.js picks wasm + the CPU-friendly model on boot.
await p.addInitScript(() => {
  localStorage.setItem('anchor.device', 'wasm');
  localStorage.setItem('anchor.model', 'qwen3-0.6b');
  localStorage.setItem('anchor.dtype', 'q8');
});
const logs = [];
p.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 400)}`));
p.on('pageerror', (e) => logs.push('PAGEERR ' + e.message));

await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, { timeout: 60000 });
await p.fill('#input', 'Say hi in one short sentence.');
await p.click('#send');

const outcome = await p.evaluate(() => new Promise((resolve) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const live = document.getElementById('onair')?.classList.contains('live');
    const errBubble = document.querySelector('.msg.assistant .err, .msg .error');
    if (live) { clearInterval(iv); resolve('LIVE (wasm loaded + speaking)'); }
    else if (errBubble) { clearInterval(iv); resolve('ERROR: ' + errBubble.textContent.slice(0, 250)); }
    else if (Date.now() - t0 > 180000) { clearInterval(iv); resolve('TIMEOUT 180s'); }
  }, 500);
}));

const report = { url, forced: 'device=wasm, model=qwen3-0.6b, dtype=q8', outcome, consoleTail: logs.slice(-30) };
fs.writeFileSync('tools/_wasm_probe.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await b.close();
