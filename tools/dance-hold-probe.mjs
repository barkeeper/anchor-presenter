// dance-hold-probe.mjs — press the ✦ button and confirm the rare dance KEEPS playing (isn't
// overridden by a queued idle VRMA_x). Covers all rare clips.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const RARE = ['OtonaBlue','BabyYou','TocaToca','RareDance_3','RareDance_5'];
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
const errors = [];
p.on('pageerror', (e) => errors.push('PAGEERR ' + e.message));
await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__face?.playRare, undefined, { timeout: 90000 });

const seen = {};
for (let i = 0; i < 12 && Object.keys(seen).length < 5; i++) {
  await p.click('#danceBtn');
  await p.waitForTimeout(700);
  const started = await p.evaluate(() => window.__face.status().currentClip);
  await p.waitForTimeout(3500);                 // past the queued-idle override window (~1.2-3.2s)
  const after = await p.evaluate(() => window.__face.status().currentClip);
  if (RARE.includes(started) && !(started in seen)) {
    seen[started] = { startedAs: started, after, held: started === after, overriddenBy: started === after ? null : after };
  }
}
const report = { url, perClip: seen, allHeld: Object.values(seen).every((v) => v.held) && Object.keys(seen).length === 5, covered: Object.keys(seen), errors };
console.log(JSON.stringify(report, null, 2));
await b.close();
