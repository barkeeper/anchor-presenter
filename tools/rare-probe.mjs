// rare-probe.mjs — inspect the rare-dance animation system at runtime.
// Reports which clips loaded (watching for "[face] skipping" warnings), the
// __face.status(), and whether __face.playRare() actually changes the clip.
import { chromium } from 'playwright';
import fs from 'fs';

const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const b = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
const faceLogs = [];
p.on('console', (m) => { const t = m.text(); if (t.includes('[face]') || t.toLowerCase().includes('vrma') || t.toLowerCase().includes('animation')) faceLogs.push(`[${m.type()}] ${t.slice(0, 200)}`); });
p.on('pageerror', (e) => faceLogs.push('PAGEERR ' + e.message));

await p.goto(url, { waitUntil: 'load' });
// Wait for the face probe to be installed (face init complete).
await p.waitForFunction(() => !!window.__face, { timeout: 60000 }).catch(() => {});

const hasFace = await p.evaluate(() => !!window.__face);
const statusBefore = hasFace ? await p.evaluate(() => window.__face.status()) : '(no window.__face)';
const playRareResult = hasFace ? await p.evaluate(() => window.__face.playRare()) : '(no window.__face)';
await p.waitForTimeout(1500);
const statusAfter = hasFace ? await p.evaluate(() => window.__face.status()) : '(no window.__face)';
// Fire it a second time to confirm the no-repeat queue cycles.
const playRareResult2 = hasFace ? await p.evaluate(() => window.__face.playRare()) : '';

const report = { url, hasFace, statusBefore, playRareResult, statusAfter, playRareResult2, faceLogs };
fs.writeFileSync('tools/_rare_probe.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await b.close();
