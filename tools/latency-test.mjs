// Measures warm time-to-first-audio (models already loaded) and checks reply
// quality for a simple greeting with the new few-shot prompting.
import { chromium } from 'playwright';
const ORIGIN = process.argv[2] || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.goto(ORIGIN + '/', { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, { timeout: 60000 });

const liveThenIdle = async (label, timeout) => {
  await page.waitForFunction(() => document.getElementById('onair').classList.contains('live'), undefined, { timeout });
  await page.waitForFunction(() => document.getElementById('status').textContent === 'ready', undefined, { timeout });
};

// 1) warm up (downloads models) with the greeting; capture the reply quality
await page.fill('#input', 'Hi, how are you?');
await page.click('#send');
console.log('Warming up (downloads models first run)…');
await page.waitForFunction(() => { const b = document.querySelector('.msg.assistant .bubble'); return b && !b.querySelector('.typing') && document.getElementById('status').textContent === 'ready'; }, undefined, { timeout: 360000 });
const greeting = await page.evaluate(() => document.querySelector('.msg.assistant .bubble').textContent.trim());
// let any speech settle
await page.waitForTimeout(500);

// 2) warm latency: time from click to first audio (ON AIR live)
await page.fill('#input', 'Tell me a fun fact.');
const t0 = Date.now();
await page.click('#send');
await page.waitForFunction(() => document.getElementById('onair').classList.contains('live'), undefined, { timeout: 120000 });
const ttfa = ((Date.now() - t0) / 1000).toFixed(1);

console.log('GREETING REPLY:', JSON.stringify(greeting));
console.log('WARM time-to-first-audio:', ttfa + 's');
await browser.close();
const personaLeak = /\bmy (boss|manager|meeting|day|colleague|team|shift|policy)\b|yesterday|tomorrow morning/i.test(greeting);
const ok = greeting.length > 0 && !personaLeak && +ttfa < 25;
console.log(ok ? 'PASS' : 'FAIL (persona leak or slow first audio)');
process.exit(ok ? 0 : 1);
