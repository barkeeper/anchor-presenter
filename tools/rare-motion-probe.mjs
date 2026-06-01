// rare-motion-probe.mjs — does a rare clip actually MOVE the rig? Samples humanoid
// bone rotations across frames during idle vs. during a forced rare clip.
import { chromium } from 'playwright';
import fs from 'fs';

const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const b = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__face?.sampleBones, { timeout: 60000 });

// Collect N bone samples spaced `gap` ms apart, return per-bone max component delta.
async function motion(samples = 8, gap = 180) {
  const seq = [];
  for (let i = 0; i < samples; i++) { seq.push(await p.evaluate(() => window.__face.sampleBones())); await p.waitForTimeout(gap); }
  const bones = Object.keys(seq[0] || {});
  const out = {};
  for (const bn of bones) {
    let maxDelta = 0;
    for (let c = 0; c < 4; c++) {
      const vals = seq.map((s) => s[bn]?.[c]).filter((v) => v !== undefined);
      maxDelta = Math.max(maxDelta, Math.max(...vals) - Math.min(...vals));
    }
    out[bn] = +maxDelta.toFixed(4);
  }
  return out;
}

const idleMotion = await motion();          // whatever clip is currently playing (idle/intro)
const rareResult = await p.evaluate(() => window.__face.playRare());
await p.waitForTimeout(600);                 // let the crossfade settle into the rare clip
const rareMotion = await motion();

const sum = (o) => +Object.values(o).reduce((a, v) => a + v, 0).toFixed(4);
const report = {
  url, rareResult,
  idleMotion, idleMotionSum: sum(idleMotion),
  rareMotion, rareMotionSum: sum(rareMotion),
  verdict: sum(rareMotion) > 0.02 ? 'RARE CLIP DRIVES THE RIG (motion detected)' : 'RARE CLIP APPEARS INERT (little/no motion)',
};
fs.writeFileSync('tools/_rare_motion.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await b.close();
