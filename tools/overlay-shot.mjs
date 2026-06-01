import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, undefined, { timeout: 60000 });
// force the stalled-download overlay state
await p.evaluate(() => {
  document.getElementById('overlay').classList.add('show');
  document.getElementById('ovTitle').textContent = 'loading language model…';
  document.getElementById('ovFile').textContent = 'onnx/model.onnx';
  document.getElementById('ovHint').textContent = 'This is taking longer than expected — your connection may be slow or interrupted. It will keep trying.';
  document.getElementById('ovCancel').hidden = false;
});
await p.waitForTimeout(300);
await p.locator('.modal').screenshot({ path: 'tools/_overlay.png' });
console.log('shot saved');
await b.close();
