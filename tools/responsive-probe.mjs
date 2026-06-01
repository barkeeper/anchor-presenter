// responsive-probe.mjs — force the orange banner on and confirm the layout doesn't overflow
// (model + chat stay in bounds) at desktop and mobile widths.
import { chromium } from 'playwright';
import fs from 'fs';

const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const errors = [];
async function check(w, h, label) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  p.on('pageerror', (e) => errors.push(`${label} PAGEERR ${e.message}`));
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, undefined, { timeout: 60000 });
  // force a long banner like the real fallback notice
  await p.evaluate(() => { const el = document.getElementById('banner'); el.hidden = false; el.innerHTML = 'Could not load <b>Qwen3 · 1.7B (smart, WebGPU)</b> on this device; running <b>Qwen3 · 0.6B (small, CPU-friendly)</b> instead.'; });
  await p.waitForTimeout(300);
  const m = await p.evaluate(() => {
    const stage = document.querySelector('.stage').getBoundingClientRect();
    const composer = document.querySelector('.composer')?.getBoundingClientRect();
    return {
      innerH: innerHeight, innerW: innerWidth,
      stageBottom: Math.round(stage.bottom),
      composerBottom: composer ? Math.round(composer.bottom) : null,
      bodyScrollH: document.body.scrollHeight, bodyScrollW: document.body.scrollWidth,
      bannerShown: !document.getElementById('banner').hidden,
    };
  });
  await p.screenshot({ path: `tools/_resp_${label}.png` });
  // desktop: nothing should extend below the viewport (composer is the lowest element)
  const vOverflow = (m.composerBottom ?? m.stageBottom) - m.innerH;
  const hOverflow = m.bodyScrollW - m.innerW;
  await p.close();
  return { label, ...m, vOverflowPx: vOverflow, hOverflowPx: hOverflow, inBounds: vOverflow <= 2 && hOverflow <= 2 };
}

const desktop = await check(1340, 820, 'desktop');
const mobile = await check(480, 850, 'mobile');
const report = { url, desktop, mobile, errors };
fs.writeFileSync('tools/_responsive.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await b.close();
