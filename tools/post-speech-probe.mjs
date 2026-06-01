// post-speech-probe.mjs — (1) does the mouth close after speech ends? (2) does a 2nd prompt
// reuse the loaded model (no reload/overlay)?
import { chromium } from 'playwright';
import fs from 'fs';

const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
const errors = [];
p.on('pageerror', (e) => errors.push('PAGEERR ' + e.message));

await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, undefined, { timeout: 60000 });

async function speakAndWatch(prompt) {
  await p.fill('#input', prompt);
  await p.click('#send');
  await p.waitForFunction(() => (window.__diag?.caption?.().text || '').length > 0 || window.__diag?.speaking?.(), undefined, { timeout: 180000 });
  // wait for speech to END
  await p.waitForFunction(() => window.__diag?.speaking?.() === false, undefined, { timeout: 120000 });
}

// ---- prompt 1: watch the mouth AFTER speech ends ----
await speakAndWatch('Say hello in one short sentence.');
const mouthAfter = [];
for (let i = 0; i < 20; i++) {
  const m = await p.evaluate(() => window.__face?.sampleMouth?.() || {});
  mouthAfter.push(+Object.values(m).reduce((a, v) => a + v, 0).toFixed(3));
  await p.waitForTimeout(150);
}

// ---- prompt 2: did it reload (overlay/downloading) or reuse the model? ----
let sawReload = false, statuses = new Set();
await p.fill('#input', 'Tell me a quick fun fact.');
await p.click('#send');
for (let i = 0; i < 24; i++) {
  const s = await p.evaluate(() => ({ overlay: document.getElementById('overlay').classList.contains('show'), status: document.getElementById('status').textContent }));
  statuses.add(s.status);
  if (s.overlay || s.status === 'downloading') sawReload = true;
  if (await p.evaluate(() => window.__diag?.speaking?.())) break; // started speaking → reused fine
  await p.waitForTimeout(250);
}

const report = {
  url,
  mouthAfterSpeech: { samples: mouthAfter, max: Math.max(...mouthAfter), verdict: Math.max(...mouthAfter) > 0.05 ? 'MOUTH STAYS OPEN (bug)' : 'MOUTH CLOSED' },
  secondPrompt: { reloaded: sawReload, statusesSeen: [...statuses], verdict: sawReload ? 'RELOADED (bug)' : 'REUSED MODEL (good)' },
  errors,
};
fs.writeFileSync('tools/_post_speech.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await b.close();
