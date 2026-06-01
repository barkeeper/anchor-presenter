// dance-music-probe.mjs — press the ✦ Dance button a few times and confirm the track that
// starts matches the dance clip that plays (and that it's actually playing).
import { chromium } from 'playwright';
import fs from 'fs';
const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
const errors = [];
p.on('pageerror', (e) => errors.push('PAGEERR ' + e.message));

await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => !!window.__face?.playRare, undefined, { timeout: 60000 });

const trials = [];
for (let i = 0; i < 4; i++) {
  await p.click('#danceBtn');
  await p.waitForTimeout(1700); // wait past the start delay (1200ms)
  const r = await p.evaluate(() => ({ clip: window.__face.status().currentClip, dance: window.__diag.dance() }));
  const fileFromSrc = r.dance ? decodeURIComponent(r.dance.src.split('/').pop().replace(/\.mp3$/, '')) : null;
  trials.push({ clip: r.clip, track: fileFromSrc, paused: r.dance?.paused, volume: r.dance?.volume, matches: r.clip === fileFromSrc });
}
const report = { url, trials, allMatch: trials.every((t) => t.matches && t.paused === false && Math.abs(t.volume - 0.6) < 0.001), errors };
fs.writeFileSync('tools/_dance_music.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await b.close();
