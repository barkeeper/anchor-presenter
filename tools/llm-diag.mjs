// llm-diag.mjs — reproduce the LLM load and report WebGPU availability in BOTH
// the main thread and the worker, so we can see which context (if any) gets an
// adapter. Run against a dev server: node tools/llm-diag.mjs [url]
import { chromium } from 'playwright';
import fs from 'fs';

const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
// Ask Chromium for real-ish WebGPU; falls back to swiftshader if no GPU.
const b = await chromium.launch({
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,WebGPU',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
const logs = [], errs = [];
p.on('console', (m) => { logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));

await p.goto(url, { waitUntil: 'load' });

// Main-thread WebGPU probe.
const mainGpu = await p.evaluate(async () => {
  if (!navigator.gpu) return 'no navigator.gpu';
  try { const a = await navigator.gpu.requestAdapter(); return a ? 'adapter OK' : 'requestAdapter() returned null'; }
  catch (e) { return 'threw: ' + (e?.message || e); }
});

// Wait for the worker to post its env (app.js stashes it on window.__llmEnv).
let workerEnv = null;
try { await p.waitForFunction(() => !!window.__llmEnv, { timeout: 30000 }); workerEnv = await p.evaluate(() => window.__llmEnv); }
catch { workerEnv = '(worker never reported env within 30s)'; }

// Now try an actual generation and see whether it loads or Aborts.
let loadOutcome = 'unknown';
try {
  await p.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, { timeout: 60000 });
  await p.fill('#input', 'Say hi in one short sentence.');
  await p.click('#send');
  // Race: ON AIR (success) vs an error bubble / banner (failure).
  loadOutcome = await p.evaluate(() => new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const live = document.getElementById('onair')?.classList.contains('live');
      const errBubble = document.querySelector('.msg.assistant .err, .msg .error');
      const banner = document.getElementById('banner');
      const bannerShown = banner && !banner.hidden ? banner.textContent.slice(0, 200) : '';
      if (live) { clearInterval(iv); resolve('LIVE (loaded + speaking)'); }
      else if (errBubble) { clearInterval(iv); resolve('ERROR: ' + errBubble.textContent.slice(0, 200)); }
      else if (Date.now() - t0 > 180000) { clearInterval(iv); resolve('TIMEOUT 180s; banner=' + bannerShown); }
    }, 400);
  }));
} catch (e) { loadOutcome = 'driver error: ' + (e?.message || e); }

const report = { url, mainThreadWebGPU: mainGpu, workerEnv, loadOutcome, pageErrors: errs, consoleTail: logs.slice(-40) };
fs.writeFileSync('tools/_llm_diag.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await b.close();
