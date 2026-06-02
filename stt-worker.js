// stt-worker.js — Whisper transcription off the main thread, so decoding a clip
// never janks the face render. The main thread (stt.js) still records + resamples
// to 16 kHz mono (AudioContext is main-thread only) and ships the Float32 PCM here.
let tf = null, asr = null, loading = null, ready = false;
const post = (m) => self.postMessage(m);

async function init(d) {
  tf = await import(d.urls.transformers);
  const env = tf.env;
  env.allowLocalModels = !!d.offline; env.allowRemoteModels = !d.offline;
  if (d.offline && d.urls.localModelPath) env.localModelPath = d.urls.localModelPath;
  env.backends.onnx.wasm.wasmPaths = d.urls.wasm;
  // single-threaded WASM works without SharedArrayBuffer / COOP+COEP — see llm-worker.js
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  ready = true;
  post({ type: 'ready' });
}

const TRANSIENT = /Failed to fetch|NetworkError|net::|ERR_|ECONN|ETIMEDOUT|timeout|timed out|\b(429|500|502|503|504)\b/i;
async function loadAsr(model) {
  for (let i = 0; i < 2; i++) {
    // fp32 (not q8): whisper-tiny.en's q8 export uses MatMulNBits with a missing scale that
    // ONNX Runtime 1.26 (transformers.js 4.x) rejects with "Missing required scale". fp32 has
    // no integer dequantization, so it loads cleanly on the wasm CPU backend.
    try { return await tf.pipeline('automatic-speech-recognition', model, { dtype: 'fp32', device: 'wasm', progress_callback: (info) => post({ type: 'progress', info }) }); }
    catch (e) { if (i === 1 || !TRANSIENT.test(String(e?.message || e))) throw e; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
  }
}
async function ensure(model) {
  if (asr) return asr;
  if (loading) return loading;
  loading = loadAsr(model).then((p) => { asr = p; return p; }).finally(() => { loading = null; });
  return loading;
}

self.onmessage = async (e) => {
  const d = e.data;
  try {
    if (d.type === 'init') await init(d);
    else if (d.type === 'load') { await ensure(d.model); post({ type: 'loaded' }); }
    else if (d.type === 'transcribe') {
      const model = await ensure(d.model);
      // whisper-tiny.en is English-only (no language/task tokens)
      const out = await model(d.pcm);
      post({ type: 'result', id: d.id, text: (out?.text || '').trim() });
    }
  } catch (err) { post({ type: 'error', id: d?.id, error: String(err?.message || err) }); }
};
