// llm-worker.js — the language model, in its own thread. Streams token deltas
// so the TTS worker (a separate thread) can synthesize in parallel.
let tf = null, gen = null, llmKey = '', usedDevice = '', usedDtype = '', current = null;
const MODELS = { '135m': 'HuggingFaceTB/SmolLM2-135M-Instruct', '360m': 'HuggingFaceTB/SmolLM2-360M-Instruct' };
const post = (m) => self.postMessage(m);
const gpuSafe = (d) => (['q8', 'int8', 'uint8'].includes(d) ? 'q4f16' : d); // int8 is broken on WebGPU

async function resolveDevice(pref) {
  if (pref !== 'webgpu') return 'wasm';
  try { const a = await navigator.gpu?.requestAdapter?.(); return a ? 'webgpu' : 'wasm'; } catch { return 'wasm'; }
}
async function init(d) {
  tf = await import(d.urls.transformers);
  const env = tf.env;
  env.allowLocalModels = !!d.offline; env.allowRemoteModels = !d.offline;
  if (d.offline && d.urls.localModelPath) env.localModelPath = d.urls.localModelPath;
  env.backends.onnx.wasm.wasmPaths = d.urls.wasm;
  post({ type: 'ready' });
}
async function ensureLLM(opts) {
  const id = MODELS[opts.modelKey] || MODELS['135m'];
  const dev = await resolveDevice(opts.device);
  const eff = dev === 'webgpu' ? gpuSafe(opts.dtype) : opts.dtype;
  const wantKey = `${id}|${eff}|${dev}`;
  if (gen && llmKey === wantKey) return;
  if (gen) { try { await gen.dispose?.(); } catch {} gen = null; }
  llmKey = wantKey;
  const prog = (info) => post({ type: 'progress', phase: 'llm', info });
  const build = (dvc, dt) => tf.pipeline('text-generation', id, { dtype: dt, device: dvc, progress_callback: prog });
  try { gen = await build(dev, eff); usedDevice = dev; usedDtype = eff; }
  catch (e) { if (dev === 'wasm') throw e; llmKey = `${id}|${opts.dtype}|wasm`; gen = await build('wasm', opts.dtype); usedDevice = 'wasm'; usedDtype = opts.dtype; }
}
async function generate(d) {
  await ensureLLM(d.opts);
  post({ type: 'loaded', device: usedDevice, dtype: usedDtype });
  const session = { cancelled: false }; current = session;
  const stopper = new tf.InterruptableStoppingCriteria(); session.stop = () => stopper.interrupt();
  const prompt = gen.tokenizer.apply_chat_template(d.messages, { tokenize: false, add_generation_prompt: true });
  let full = '';
  const streamer = new tf.TextStreamer(gen.tokenizer, {
    skip_prompt: true, skip_special_tokens: true,
    callback_function: (p) => {
      if (session.cancelled || !p) return;
      const piece = p.split('<|im_end|>')[0]; full += piece;
      post({ type: 'piece', piece, clean: full.split('<|im_end|>')[0].split('<|im_start|>')[0] });
    },
  });
  try { await gen(prompt, { max_new_tokens: d.opts.maxTokens ?? 120, temperature: 0.3, repetition_penalty: 1.2, return_full_text: false, streamer, stopping_criteria: stopper }); }
  catch (e) { if (!session.cancelled) post({ type: 'error', error: String(e?.message || e) }); }
  if (session === current) current = null;
  post({ type: 'done', reply: full.split('<|im_end|>')[0].split('<|im_start|>')[0].trim() || '…' });
}
self.onmessage = async (e) => {
  const d = e.data;
  try {
    if (d.type === 'init') await init(d);
    else if (d.type === 'load') { await ensureLLM(d.opts); post({ type: 'loaded', device: usedDevice, dtype: usedDtype }); }
    else if (d.type === 'generate') await generate(d);
    else if (d.type === 'cancel') { if (current) { current.cancelled = true; current.stop?.(); } }
  } catch (err) { post({ type: 'error', error: String(err?.message || err) }); }
};
