// llm-worker.js — the language model, in its own thread. Streams token deltas
// so the TTS worker (a separate thread) can synthesize in parallel.
let tf = null, gen = null, llmKey = '', usedDevice = '', usedDtype = '', usedModelKey = '', current = null;
// Whether THIS worker can actually obtain a WebGPU adapter. Probed once at init.
// If false, attempting a webgpu ORT session not only fails but poisons the worker's
// global ORT backend state, so a subsequent wasm session also reports
// "no available backend found" — the real cause of the dead-end LLM load. We therefore
// never attempt webgpu unless an adapter is genuinely available in this context.
let workerGpuOk = false;
const MODELS = {
  'gemma-4-e2b': 'onnx-community/gemma-4-E2B-it-ONNX',
  'qwen3-0.6b': 'onnx-community/Qwen3-0.6B-ONNX',
};
const DEFAULT_KEY = 'gemma-4-e2b';
// What to retry with if the requested combo blows up with Aborted() / OOM.
// On WASM we want a much smaller model — q4f16 of Qwen3-1.7B is ~1.4 GB and
// onnxruntime's WASM heap can't always allocate it. 0.6B q8 is ~600 MB and runs.
const WASM_FALLBACK = { key: 'qwen3-0.6b', dtype: 'q8' };
const post = (m) => self.postMessage(m);
const gpuSafe = (d) => (['q8', 'int8', 'uint8'].includes(d) ? 'q4f16' : d); // int8 is broken on WebGPU
// Strip emoji/pictographs — the system prompt forbids them, but small models still emit one,
// and Kokoro's phonemizer then SPEAKS the name ("smiling face with smiling eyes").
const stripEmoji = (s) => s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}\u{20E3}\u{2122}\u{2139}]/gu, '').replace(/ {2,}/g, ' ');

// Use WebGPU only when the user asked for it AND this worker actually got an adapter.
// If `requestAdapter()` returned null here, ORT's webgpu backend can't get one either,
// so attempting it gains nothing and contaminates the wasm fallback (see workerGpuOk).
const useWebGPU = (pref) => pref === 'webgpu' && workerGpuOk;
async function init(d) {
  tf = await import(d.urls.transformers);
  const env = tf.env;
  env.allowLocalModels = !!d.offline; env.allowRemoteModels = !d.offline;
  if (d.offline && d.urls.localModelPath) env.localModelPath = d.urls.localModelPath;
  env.backends.onnx.wasm.wasmPaths = d.urls.wasm;
  // Threaded WASM needs SharedArrayBuffer (cross-origin isolation via COOP+COEP).
  // When unavailable, the threaded build aborts on init with "Aborted()". Pin to
  // single-threaded so the model loads regardless of headers.
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  // Disable transformers.js's built-in browser-cache layer. It tries to do
  // `cache.put(response.clone())` while ALSO consuming the same stream for onnxruntime;
  // when `cache.put` errors (e.g. quota / opaque-stream issues) it can leave the body
  // half-consumed and the subsequent ORT load aborts with "Aborted()". Our service
  // worker handles persistent caching anyway, so this is no functional loss.
  env.useBrowserCache = false;
  env.useFSCache = false;
  // Probe WebGPU *inside this worker*. Some Chrome/driver combos expose navigator.gpu on
  // the main thread but won't hand a worker an adapter; this is the case that breaks the
  // LLM load. We gate webgpu on this result (see useWebGPU) and also report it to the page
  // for the diagnostic banner. If requestAdapter() is null here, webgpu can't work here.
  let gpu = 'no navigator.gpu in worker', maxBuf = 0;
  try {
    if (self.navigator?.gpu) {
      const a = await self.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      workerGpuOk = !!a;
      gpu = a ? 'adapter OK' : 'requestAdapter() returned null';
      if (a) {
        // CRITICAL: WebGPU's DEFAULT maxStorageBufferBindingSize is only ~128 MiB even on a
        // 12 GB card, which makes big-vocab models (Qwen's 152k-token embedding) abort at
        // OrtCreateSession. Request a device with the adapter's REAL max limits and hand it to
        // ORT (env.webgpu.device) so large models fit. Requesting the adapter's own maxima is
        // always valid. Without this, only tiny models load regardless of VRAM.
        const L = a.limits;
        maxBuf = Math.round((L.maxStorageBufferBindingSize || 0) / (1024 * 1024));
        try {
          // q4f16 models need the GPU `shader-f16` feature — if we hand ORT a device WITHOUT
          // it, ORT's fp16 kernels fail and the whole thing silently drops to CPU. Request it.
          const feats = ['shader-f16'].filter((f) => a.features.has(f));
          const dev = await a.requestDevice({ requiredFeatures: feats, requiredLimits: {
            maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
            maxBufferSize: L.maxBufferSize,
          } });
          if (env.backends?.onnx?.webgpu) { env.backends.onnx.webgpu.adapter = a; env.backends.onnx.webgpu.device = dev; }
        } catch (e) { gpu += ` (device override failed: ${String(e?.message || e).slice(0, 80)})`; }
      }
    }
  } catch (e) { gpu = 'requestAdapter() threw: ' + String(e?.message || e); }
  post({ type: 'env', gpu, coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, maxStorageBufferMB: maxBuf });
  post({ type: 'ready' });
}

// Only transient network failures are worth retrying; backend/OOM errors won't self-heal.
const TRANSIENT = /Failed to fetch|NetworkError|net::|ERR_|ECONN|ETIMEDOUT|timeout|timed out|\b(429|500|502|503|504)\b/i;
async function withRetry(fn, label, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e; const msg = String(e?.message || e);
      if (i === tries - 1 || !TRANSIENT.test(msg)) throw e;
      post({ type: 'progress', phase: 'llm', info: { status: 'initiate', name: `Network hiccup — retrying ${label}…` } });
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}

// Build a pipeline for a specific (modelKey, dtype, device). Throws on failure.
async function build(modelKey, dtype, device) {
  const id = MODELS[modelKey] || MODELS[DEFAULT_KEY];
  const prog = (info) => post({ type: 'progress', phase: 'llm', info });
  const p = await withRetry(() => tf.pipeline('text-generation', id, { dtype, device, progress_callback: prog }), id);
  return { pipe: p, id };
}

// Load ONE (model, dtype, device) combo — a single attempt. We do NOT walk a fallback
// ladder inside the worker any more: a failed WebGPU `OrtCreateSession` calls abort() and
// poisons this worker's whole ORT runtime, so any same-worker retry (even wasm) also
// aborts. The real fallback ladder lives in infer.js and runs each rung in a FRESH worker.
async function ensureLLM(opts) {
  const reqKey = MODELS[opts.modelKey] ? opts.modelKey : DEFAULT_KEY;
  const dev = useWebGPU(opts.device) ? 'webgpu' : 'wasm';
  let key = reqKey, dt = opts.dtype;
  if (dev === 'webgpu') dt = gpuSafe(dt);
  else if (key !== WASM_FALLBACK.key) { key = WASM_FALLBACK.key; dt = WASM_FALLBACK.dtype; } // big model won't fit the WASM heap

  const wantKey = `${MODELS[key]}|${dt}|${dev}`;
  if (gen && llmKey === wantKey) return;
  if (gen) { try { await gen.dispose?.(); } catch {} gen = null; }

  try {
    post({ type: 'progress', phase: 'llm', info: { status: 'initiate', name: `Loading ${MODELS[key]} (${dt}, ${dev})` } });
    const { pipe } = await build(key, dt, dev);
    gen = pipe; usedModelKey = key; usedDtype = dt; usedDevice = dev; llmKey = wantKey;
  } catch (e) {
    const msg = String(e?.message || e);
    console.warn('[llm-worker] load failed for', key, dt, dev, '— FULL ERROR:', msg);
    throw new Error(`Could not load ${MODELS[key]} (${dt}, ${dev}): ${msg}`);
  }
}
async function generate(d) {
  // A total load failure is recoverable: the main thread can respawn this worker pinned
  // to wasm (escaping any poisoned ORT state) and replay. Tag it so it can tell.
  try { await ensureLLM(d.opts); }
  catch (e) { post({ type: 'error', code: 'load-failed', error: String(e?.message || e) }); return; }
  post({ type: 'loaded', device: usedDevice, dtype: usedDtype, modelKey: usedModelKey });
  const session = { cancelled: false }; current = session;
  const stopper = new tf.InterruptableStoppingCriteria(); session.stop = () => stopper.interrupt();
  // Qwen3 supports a reasoning preamble via `enable_thinking`; we want fast replies that
  // stream straight into TTS, so disable it.
  // Gemma's chat template rejects a `system` role; fold it into the first user turn on failure.
  const foldSystem = (msgs) => {
    const sys = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const rest = msgs.filter((m) => m.role !== 'system');
    if (sys && rest[0]?.role === 'user') return [{ role: 'user', content: `${sys}\n\n${rest[0].content}` }, ...rest.slice(1)];
    return rest.length ? rest : msgs;
  };
  let prompt;
  try { prompt = gen.tokenizer.apply_chat_template(d.messages, { tokenize: false, add_generation_prompt: true, enable_thinking: false }); }
  catch { prompt = gen.tokenizer.apply_chat_template(foldSystem(d.messages), { tokenize: false, add_generation_prompt: true }); }
  let full = '';
  // Cut at any chat turn-sentinel (Qwen ChatML or Gemma turns), strip <think> blocks + emoji.
  const STOP = /<\|im_end\|>|<\|im_start\|>|<end_of_turn>|<start_of_turn>/;
  const sanitize = (s) => stripEmoji(s.replace(/<think>[\s\S]*?<\/think>/g, '').split(STOP)[0]);
  const streamer = new tf.TextStreamer(gen.tokenizer, {
    skip_prompt: true, skip_special_tokens: true,
    callback_function: (p) => {
      if (session.cancelled || !p) return;
      const raw = p.split(STOP)[0]; full += raw;
      post({ type: 'piece', piece: stripEmoji(raw), clean: sanitize(full) });
    },
  });
  try { await gen(prompt, { max_new_tokens: d.opts.maxTokens ?? 120, temperature: 0.3, repetition_penalty: 1.2, return_full_text: false, streamer, stopping_criteria: stopper }); }
  catch (e) { if (!session.cancelled) post({ type: 'error', error: String(e?.message || e) }); }
  if (session === current) current = null;
  post({ type: 'done', reply: sanitize(full).trim() || '…' });
}
self.onmessage = async (e) => {
  const d = e.data;
  try {
    if (d.type === 'init') await init(d);
    else if (d.type === 'load') { try { await ensureLLM(d.opts); post({ type: 'loaded', device: usedDevice, dtype: usedDtype, modelKey: usedModelKey }); } catch (e) { post({ type: 'error', code: 'load-failed', error: String(e?.message || e) }); } }
    else if (d.type === 'generate') await generate(d);
    else if (d.type === 'cancel') { if (current) { current.cancelled = true; current.stop?.(); } }
  } catch (err) { post({ type: 'error', error: String(err?.message || err) }); }
};
