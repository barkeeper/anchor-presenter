// gemma4-arch.mjs — does transformers.js 3.8.1 actually SUPPORT the gemma4 model class?
// If not, pipeline() throws "Unsupported model type" right after config load, BEFORE any
// weight download. If supported, it starts fetching the decoder (progress events fire).
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const model = process.argv[3] || 'onnx-community/gemma-4-E2B-it-ONNX';
const tfUrl = process.argv[4] || null; // optional explicit transformers.js bundle URL (to test a newer version)
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, undefined, { timeout: 60000 });

const result = await p.evaluate(async ({ model, tfUrl }) => {
  const out = { startedDownloadingWeights: false, filesSeen: [], threw: false, error: '', tfVersion: '' };
  const t = await import(tfUrl || '@huggingface/transformers');
  out.tfVersion = t.env?.version || '?';
  const seen = new Set();
  const prog = (info) => { if (info?.file) seen.add(info.file); if (/onnx|model|decoder|embed/i.test(info?.file || '')) out.startedDownloadingWeights = true; };
  try {
    // race the load against a short timeout — we only care whether it reaches the weight stage
    await Promise.race([
      t.pipeline('text-generation', model, { dtype: 'q4f16', device: 'wasm', progress_callback: prog }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('__timeout_reached__')), 25000)),
    ]);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('__timeout_reached__')) { /* still loading — arch was accepted */ }
    else { out.threw = true; out.error = msg.slice(0, 220); }
  }
  out.filesSeen = [...seen].slice(0, 12);
  return out;
}, { model, tfUrl });
console.log(JSON.stringify(result, null, 2));
await b.close();
