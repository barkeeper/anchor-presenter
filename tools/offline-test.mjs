// Proves LOCAL mode runs with zero internet: every request to anything other
// than the local server is aborted. Then it runs the full chat→voice loop.
import { chromium } from 'playwright';

const ORIGIN = process.argv[2] || 'http://127.0.0.1:5180';
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext();

// Force LOCAL mode before any script runs.
await ctx.addInitScript(() => localStorage.setItem('anchor.mode', 'offline'));

// Hard network cut: allow only the local origin.
let blocked = 0;
await ctx.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith(ORIGIN) || u.startsWith('http://localhost')) return route.continue();
  blocked++; return route.abort();
});

const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error:', m.text()); });

await page.goto(ORIGIN + '/', { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, { timeout: 60000 });

const info = await page.evaluate(() => ({
  mode: document.getElementById('modeSwitch').dataset.mode,
  importmap: document.querySelector('script[type="importmap"]').textContent,
}));
const allLocal = !/https?:\/\/(?!localhost|127\.)/.test(info.importmap);
console.log('mode:', info.mode, '| import map is all-local:', allLocal);

await page.fill('#input', 'Say hello in one short sentence.');
await page.click('#send');
console.log('Sent (offline). Waiting for reply from disk-loaded model…');
await page.waitForFunction(() => {
  const b = document.querySelector('.msg.assistant .bubble');
  return b && !b.querySelector('.typing') && b.textContent.trim().length > 0;
}, { timeout: 300000 });
const reply = await page.evaluate(() => document.querySelector('.msg.assistant .bubble').textContent.trim());
console.log('REPLY:', JSON.stringify(reply.slice(0, 140)));

let live = false;
try { await page.waitForFunction(() => document.getElementById('onair').classList.contains('live'), { timeout: 120000 }); live = true; } catch {}
console.log('ON AIR (speaking):', live, '| external requests blocked:', blocked);

await browser.close();
const ok = info.mode === 'offline' && allLocal && reply.length > 0 && live;
console.log(ok ? 'PASS — fully offline chat→voice→face loop' : 'FAIL');
process.exit(ok ? 0 : 1);
