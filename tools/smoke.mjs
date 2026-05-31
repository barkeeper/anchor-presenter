import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://localhost:5180/';
const errors = [], logs = [];

const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
page.on('console', (m) => { logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(URL, { waitUntil: 'load' });

// app.js runs only if the dynamically-injected import map resolved the bare specifiers.
try {
  await page.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, { timeout: 60000 });
} catch (e) {
  console.log('WAIT FAILED:', e.message);
  console.log('CONSOLE:\n  ' + logs.join('\n  '));
  console.log('PAGE ERRORS:\n  ' + (errors.join('\n  ') || '(none)'));
  const dbg = await page.evaluate(() => ({
    importmap: document.querySelector('script[type="importmap"]')?.textContent?.slice(0, 400),
    appScript: !!document.querySelector('script[src="./app.js"]'),
  }));
  console.log('DEBUG', JSON.stringify(dbg, null, 2));
  await browser.close();
  process.exit(1);
}

const r = await page.evaluate(() => ({
  voices: document.querySelectorAll('#voice option').length,
  llmId: document.getElementById('llmId').textContent,
  ttsId: document.getElementById('ttsId').textContent,
  hasSystemMsg: !!document.querySelector('.msg.system .bubble'),
  mode: document.getElementById('modeSwitch').dataset.mode,
  theme: document.documentElement.getAttribute('data-theme'),
  importmap: !!document.querySelector('script[type="importmap"]'),
}));

// theme toggle
await page.click('#themeBtn');
const theme2 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));

// give the WebGPU face a moment, then see if it initialised or fell back
await page.waitForTimeout(6000);
const face = await page.evaluate(() => ({
  fallbackShown: !document.getElementById('faceFallback').hidden,
  canvasSized: (() => { const c = document.getElementById('face'); return c.width > 0 && c.height > 0; })(),
}));

console.log('RESULT', JSON.stringify({ ...r, theme2, face }, null, 2));
console.log('CONSOLE ERRORS:', logs.filter((l) => l.startsWith('error')).join('\n  ') || '(none)');
console.log('PAGE ERRORS:', errors.join('\n  ') || '(none)');

await browser.close();
const fatal = errors.length || r.voices === 0;
process.exit(fatal ? 1 : 0);
