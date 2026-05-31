// Full loop: type a message -> SmolLM2 replies -> Kokoro speaks -> the ON AIR
// indicator lights (proving speak() fired from a real LLM reply and the audio
// graph is running). Downloads both models on first run.
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://localhost:5180/';
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error:', m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, { timeout: 60000 });

await page.fill('#input', 'Say hello in one short friendly sentence.');
await page.click('#send');
console.log('Sent. Waiting for LLM reply (downloads ~140MB first run)…');

await page.waitForFunction(() => {
  const b = document.querySelector('.msg.assistant .bubble');
  return b && !b.querySelector('.typing') && b.textContent.trim().length > 0;
}, { timeout: 360000 });
const reply = await page.evaluate(() => document.querySelector('.msg.assistant .bubble').textContent.trim());
console.log('REPLY:', JSON.stringify(reply.slice(0, 160)));

// speak() should flip ON AIR live within a short window after the reply
let live = false;
try {
  await page.waitForFunction(() => document.getElementById('onair').classList.contains('live'), { timeout: 120000 });
  live = true;
} catch {}
console.log('ON AIR (speaking):', live);

await browser.close();
const ok = reply.length > 0 && live;
console.log(ok ? 'PASS — full chat→voice→face loop fired' : 'FAIL');
process.exit(ok ? 0 : 1);
