// Functional test of the real speech path: kokoro-js -> shared transformers.js
// -> phonemizer (espeak wasm) -> audio samples. Proves the trickiest runtime
// wiring (bare imports + node-builtin stubs) actually works end to end.
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://localhost:5180/';
const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--use-gl=angle', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('console.error:', m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, { timeout: 60000 });

console.log('Loading Kokoro + generating speech (downloads ~92MB on first run)…');
const t0 = Date.now();
const out = await page.evaluate(async () => {
  const { KokoroTTS } = await import('kokoro-js');             // resolved via the page import map
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'wasm' });
  const audio = await tts.generate('Hello, I am Anchor.', { voice: 'af_heart' });
  let peak = 0; const a = audio.audio;
  for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i]));
  return { samples: a.length, sr: audio.sampling_rate, seconds: +(a.length / audio.sampling_rate).toFixed(2), peak: +peak.toFixed(3) };
}, { timeout: 420000 });

console.log('TTS RESULT', JSON.stringify(out));
const ok = out.samples > 1000 && out.peak > 0.01;
console.log(ok ? `PASS in ${((Date.now() - t0) / 1000).toFixed(0)}s — produced ${out.seconds}s of audio` : 'FAIL — silent/empty audio');
await browser.close();
process.exit(ok ? 0 : 1);
