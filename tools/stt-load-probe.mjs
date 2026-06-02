// stt-load-probe.mjs — verify whisper-tiny.en loads (creates an ORT 1.26 session) without the
// "Missing required scale / MatMulNBits" error. The error fires at session creation, so just
// building the pipeline is enough — no mic needed.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const dtype = process.argv[3] || 'fp32';
const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
const errors = [];
p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, undefined, { timeout: 60000 });

const result = await p.evaluate(async (dtype) => {
  const t = await import('@huggingface/transformers');
  try {
    const asr = await t.pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en', { dtype, device: 'wasm' });
    return { loaded: !!asr, dtype };
  } catch (e) { return { loaded: false, dtype, error: String(e?.message || e).slice(0, 300) }; }
}, dtype);
console.log(JSON.stringify({ ...result, consoleErrors: errors.slice(0, 5) }, null, 2));
await b.close();
