// Proves the worker fix: while the model is generating AND speaking, the main
// thread must stay responsive so the face can render. We measure requestAnimationFrame
// frame gaps during speech — large gaps == frozen face (the bug we fixed).
import { chromium } from 'playwright';
const ORIGIN = process.argv[2] || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.goto(ORIGIN + '/', { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, { timeout: 60000 });

await page.fill('#input', 'Tell me about the ocean in three sentences.');
await page.click('#send');
console.log('Waiting for speech to start…');
await page.waitForFunction(() => document.getElementById('onair').classList.contains('live'), undefined, { timeout: 360000 });

// sample frame pacing for ~3s while it speaks
const r = await page.evaluate(() => new Promise((res) => {
  const gaps = []; let last = performance.now(), n = 0;
  (function f() { const now = performance.now(); gaps.push(now - last); last = now; if (++n < 180 && document.getElementById('onair').classList.contains('live')) requestAnimationFrame(f); else res({ frames: n, avg: +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1), max: +Math.max(...gaps).toFixed(1) }); }());
}));
console.log('FRAME PACING during speech:', JSON.stringify(r));
await browser.close();
// max gap is the real signal: the old bug froze the main thread for seconds.
// (avg is dominated by SwiftShader's slow software render in headless; real GPU ~16ms.)
const ok = r.frames > 30 && r.max < 400;
console.log(ok ? 'PASS — main thread stays responsive while speaking' : 'FAIL — main thread stalls (face would freeze)');
process.exit(ok ? 0 : 1);
