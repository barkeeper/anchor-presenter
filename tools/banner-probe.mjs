// banner-probe.mjs — show the notice banner and confirm it auto-hides after ~15s.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, undefined, { timeout: 60000 });

const shown = await p.evaluate(() => { const el = document.getElementById('banner'); el.hidden = false; el.textContent = 'Download canceled. Press send to try again.'; return !el.hidden; });
const at2s = await p.evaluate(() => new Promise((r) => setTimeout(() => r(!document.getElementById('banner').hidden), 2000)));
const at16s = await p.evaluate(() => new Promise((r) => setTimeout(() => r(!document.getElementById('banner').hidden), 14000)));

console.log(JSON.stringify({ visibleImmediately: shown, visibleAt2s: at2s, visibleAt16s: at16s, verdict: shown && at2s && !at16s ? 'AUTO-HIDES AFTER 15s (good)' : 'unexpected' }, null, 2));
await b.close();
