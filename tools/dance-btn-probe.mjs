// dance-btn-probe.mjs — verify the UI "Dance" button triggers a rare clip, and that
// clips are now named (not all "Clip").
import { chromium } from 'playwright';
import fs from 'fs';

const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const RARE = ['OtonaBlue', 'BabyYou', 'TocaToca', 'RareDance_3', 'RareDance_5'];
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
const errors = [];
p.on('pageerror', (e) => errors.push('PAGEERR ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errors.push('console.error ' + m.text().slice(0, 200)); });

await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__face, { timeout: 60000 });
const before = await p.evaluate(() => window.__face.status());
await p.click('#danceBtn');
await p.waitForTimeout(900);
const after = await p.evaluate(() => window.__face.status());

const report = {
  url,
  clipNamed: before.currentClip && before.currentClip !== 'Clip',
  before, after,
  danceTriggered: RARE.includes(after.currentClip),
  errors,
};
fs.writeFileSync('tools/_dance_btn.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await b.close();
