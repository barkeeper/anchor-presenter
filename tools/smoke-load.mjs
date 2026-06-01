// smoke-load.mjs — fast boot check: load the page, confirm the face + voices come up,
// and report any pageerrors / console errors. No model download, so ~10s.
import { chromium } from 'playwright';
import fs from 'fs';

const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
const errors = [];
p.on('pageerror', (e) => errors.push('PAGEERR ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errors.push('console.error ' + m.text().slice(0, 200)); });

await p.goto(url, { waitUntil: 'load' });
const facePromise = p.waitForFunction(() => !!window.__face, { timeout: 60000 }).then(() => true).catch(() => false);
const voicesPromise = p.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, { timeout: 60000 }).then(() => true).catch(() => false);
const [face, voices] = await Promise.all([facePromise, voicesPromise]);
await p.waitForTimeout(1500); // let workers post their init/ready

const report = { url, faceUp: face, voicesUp: voices, env: await p.evaluate(() => window.__llmEnv || null), errors };
fs.writeFileSync('tools/_smoke_load.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await b.close();
