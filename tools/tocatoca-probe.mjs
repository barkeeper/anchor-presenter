// tocatoca-probe.mjs — trigger each rare clip and measure how much it moves the rig, to find
// whether TocaToca (or any clip) loads but fails to animate.
import { chromium } from 'playwright';
import fs from 'fs';
const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
const faceLogs = [];
p.on('console', (m) => { const t = m.text(); if (/\[face\]|skipping|VRMA|animation/i.test(t)) faceLogs.push(`[${m.type()}] ${t.slice(0, 160)}`); });
p.on('pageerror', (e) => faceLogs.push('PAGEERR ' + e.message));

await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__face?.playRare, undefined, { timeout: 60000 });
const status = await p.evaluate(() => window.__face.status());

async function motionOf() {
  const seq = [];
  for (let i = 0; i < 8; i++) { seq.push(await p.evaluate(() => window.__face.sampleBones())); await p.waitForTimeout(180); }
  const bones = Object.keys(seq[0] || {}); let sum = 0;
  for (const bn of bones) for (let c = 0; c < 4; c++) { const v = seq.map((s) => s[bn]?.[c]).filter((x) => x !== undefined); sum += Math.max(...v) - Math.min(...v); }
  return +sum.toFixed(3);
}

const results = {};
for (let i = 0; i < 12; i++) {
  const res = await p.evaluate(() => window.__face.playRare()); // "playing: <name>"
  await p.waitForTimeout(500); // let crossfade settle
  const clip = await p.evaluate(() => window.__face.status().currentClip);
  const motion = await motionOf();
  if (!results[clip]) results[clip] = [];
  results[clip].push(motion);
  if (Object.keys(results).length >= 5 && Object.values(results).every((a) => a.length >= 1)) { /* keep going a bit */ }
}
const summary = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { runs: v, max: Math.max(...v), verdict: Math.max(...v) > 0.1 ? 'ANIMATES' : 'INERT (no motion!)' }]));
const report = { url, status, perClip: summary, faceLogs: faceLogs.slice(0, 20) };
fs.writeFileSync('tools/_tocatoca.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await b.close();
