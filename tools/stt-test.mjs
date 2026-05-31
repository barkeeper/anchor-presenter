// Validates the voice-input model: synthesize a phrase with Kokoro, resample to
// 16 kHz, and transcribe it with Whisper (same path stt.js uses). No mic needed.
import { chromium } from 'playwright';
const ORIGIN = process.argv[2] || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--use-gl=angle', '--use-angle=swiftshader'] });
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.goto(ORIGIN + '/', { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, { timeout: 60000 });

console.log('Synthesizing + transcribing (downloads Whisper ~41MB first run)…');
const text = await page.evaluate(async () => {
  const { KokoroTTS } = await import('kokoro-js');
  const { pipeline } = await import('@huggingface/transformers');
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'wasm' });
  const a = await tts.generate('The quick brown fox jumps over the lazy dog.', { voice: 'af_heart' });
  const off = new OfflineAudioContext(1, Math.ceil(a.audio.length * 16000 / a.sampling_rate), 16000);
  const buf = off.createBuffer(1, a.audio.length, a.sampling_rate); buf.getChannelData(0).set(a.audio);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  const r = await off.startRendering();
  const asr = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en', { dtype: 'q8' });
  return (await asr(r.getChannelData(0))).text;
}, { timeout: 420000 });

console.log('TRANSCRIPT:', JSON.stringify(text));
await browser.close();
const ok = (text || '').trim().split(/\s+/).length >= 4 && /fox|dog|quick|brown/i.test(text);
console.log(ok ? 'PASS — Whisper transcribed synthesized speech' : 'FAIL');
process.exit(ok ? 0 : 1);
