// sync-probe.mjs — verify (a) the mouth moves with speech (visemes/amplitude drive the
// VRM mouth weights), (b) captions track the spoken audio, and (c) the spoken text matches
// the chat text. Runs a real generation; TTS runs on wasm, the viseme timeline advances on
// the AudioContext clock even if the headless box has no speakers.
import { chromium } from 'playwright';
import fs from 'fs';

const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: 1340, height: 820 } });
const errors = [];
p.on('pageerror', (e) => errors.push('PAGEERR ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') errors.push('console.error ' + m.text().slice(0, 200)); });

await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, undefined, { timeout: 60000 });
await p.fill('#input', 'Please count slowly from one to eight, each number in its own short sentence.');
await p.click('#send');

// wait until audio is ACTUALLY playing — a caption line means a scheduled clip is on the
// AudioContext clock (not just that a session opened). Up to 3 min for cold model download.
await p.waitForFunction(() => (window.__diag?.caption?.().text || '').length > 0 || (window.__diag?.audioRMS?.() || 0) > 0.005, undefined, { timeout: 180000 });

// sample ~8s of speech
const samples = [];
const activeWords = new Set();
const captionsSeen = new Set();
for (let i = 0; i < 45; i++) {
  const s = await p.evaluate(() => ({
    t: performance.now(),
    speaking: window.__diag.speaking(),
    rms: +window.__diag.audioRMS().toFixed(4),
    mouth: window.__face?.sampleMouth?.() || {},
    cap: window.__diag.caption(),
  }));
  const mouthSum = Object.values(s.mouth).reduce((a, v) => a + v, 0);
  samples.push({ t: Math.round(s.t), speaking: s.speaking, rms: s.rms, mouthSum: +mouthSum.toFixed(3), active: s.cap.active });
  if (s.cap.active) activeWords.add(s.cap.active);
  if (s.cap.text) captionsSeen.add(s.cap.text);
  if (!s.speaking && i > 5) break;
  await p.waitForTimeout(200);
}

const bubble = await p.evaluate(() => window.__diag.bubble());
const mouthVals = samples.map((s) => s.mouthSum);
const mouthMax = Math.max(...mouthVals, 0);
const mouthNonZero = mouthVals.filter((v) => v > 0.02).length;
const distinctMouth = new Set(mouthVals.map((v) => v.toFixed(2))).size;
const rmsMax = Math.max(...samples.map((s) => s.rms), 0);

// caption-vs-chat: every caption line should be a substring of the (normalized) chat reply
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const nb = norm(bubble);
const capLines = [...captionsSeen];
const captionsInChat = capLines.length ? capLines.every((c) => nb.includes(norm(c)) || norm(c).includes(nb.slice(0, 10))) : null;

const report = {
  url,
  // (b) lip-sync: mouth weights move over the course of speech
  lipSync: { mouthMax: +mouthMax.toFixed(3), framesMouthOpen: mouthNonZero, distinctMouthLevels: distinctMouth, verdict: (mouthMax > 0.05 && distinctMouth > 3) ? 'MOUTH MOVES WITH SPEECH' : 'MOUTH NOT MOVING' },
  // (c) captions advance through distinct words (tracking the audio timeline)
  captionSync: { distinctActiveWords: activeWords.size, sampleWords: [...activeWords].slice(0, 12), verdict: activeWords.size > 2 ? 'CAPTIONS ADVANCE WITH SPEECH' : 'CAPTIONS NOT ADVANCING' },
  // (a) voice vs chat text: captions (spoken text) are contained in the chat reply
  voiceVsChat: { chatReply: bubble.slice(0, 200), captionLineCount: capLines.length, captionsMatchChat: captionsInChat },
  audioMeteredRMSmax: +rmsMax.toFixed(4), // 0 is OK headless (no speaker); visemes still drive mouth
  errors,
};
fs.writeFileSync('tools/_sync.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await b.close();
