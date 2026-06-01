// timing-probe.mjs — verify (1) the chat bubble reveals in SYNC with speech (grows gradually,
// doesn't jump to the full reply ahead of the voice) and (2) the mouth closes after speech.
import { chromium } from 'playwright';
import fs from 'fs';
const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
const errors = [];
p.on('pageerror', (e) => errors.push('PAGEERR ' + e.message));

await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, undefined, { timeout: 60000 });
await p.fill('#input', 'Please tell me three short fun facts about the ocean.');
await p.click('#send');

// note the moment speech starts and whether the bubble was already full then
await p.waitForFunction(() => (window.__diag?.caption?.().text || '').length > 0, undefined, { timeout: 180000 });
const atSpeechStart = await p.evaluate(() => ({ bubbleLen: window.__diag.bubble().length, fullLen: window.__diag.fullReply().length }));

const samples = [];
for (let i = 0; i < 60; i++) {
  const s = await p.evaluate(() => ({
    speaking: window.__diag.speaking(),
    bubbleLen: window.__diag.bubble().length,
    fullLen: window.__diag.fullReply().length,
    mouth: +Object.values(window.__face?.sampleMouth?.() || {}).reduce((a, v) => a + v, 0).toFixed(3),
  }));
  samples.push(s);
  if (!s.speaking && i > 4) break;
  await p.waitForTimeout(250);
}
const finalBubble = await p.evaluate(() => window.__diag.bubble());

// analysis
const speakingSamples = samples.filter((s) => s.speaking);
const bubbleLens = speakingSamples.map((s) => s.bubbleLen);
const distinctLens = new Set(bubbleLens).size;
const afterSpeech = samples.filter((s) => !s.speaking);
const mouthAfterMax = afterSpeech.length ? Math.max(...afterSpeech.map((s) => s.mouth)) : null;

const report = {
  url,
  // synced if the bubble was NOT already the full reply when speech began, and it grew in steps
  atSpeechStart,
  bubbleRevealedGradually: { distinctBubbleLengths: distinctLens, verdict: distinctLens >= 3 ? 'GRADUAL (synced to voice)' : 'JUMPED (not synced)' },
  notAheadAtStart: atSpeechStart.fullLen > 0 && atSpeechStart.bubbleLen <= atSpeechStart.fullLen * 0.6 ? 'BUBBLE WAITED FOR VOICE' : 'bubble may have raced ahead',
  mouthAfterSpeech: { max: mouthAfterMax, verdict: mouthAfterMax === null ? 'n/a' : mouthAfterMax > 0.05 ? 'STILL OPEN (bug)' : 'CLOSED' },
  finalBubblePreview: finalBubble.slice(0, 120),
  errors,
};
fs.writeFileSync('tools/_timing.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await b.close();
