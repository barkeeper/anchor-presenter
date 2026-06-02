// console-probe.mjs — capture ALL console output on load to see which warnings remain.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
const msgs = [];
p.on('console', (m) => msgs.push(`[${m.type()}] ${m.text().slice(0, 160)}`));
p.on('pageerror', (e) => msgs.push(`[pageerror] ${e.message.slice(0, 160)}`));
await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__face, undefined, { timeout: 60000 }).catch(() => {});
await p.waitForTimeout(2500);
// drop the known-benign three.js deprecation that we can't avoid, keep everything else
const interesting = msgs.filter((m) => !/sigmaRadians|specVersion|\[llm-worker env\]|\[infer\]|\[llm-worker\] (reusing|LOADING)/.test(m));
console.log(JSON.stringify({ total: msgs.length, all: msgs, stillNoisy: interesting }, null, 2));
await b.close();
