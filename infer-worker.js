// infer-worker.js — all heavy inference runs here, off the main thread, so the
// main thread stays free to render the 3D face in sync with the audio.
// Runs the LLM (Transformers.js) AND Kokoro TTS on a single shared transformers
// instance: kokoro-js's bare imports are rewritten to absolute URLs and loaded
// as a Blob module, so there's one ORT runtime and offline paths "just work".

let tf = null, KokoroTTS = null, TextSplitterStream = null;
let gen = null, llmKey = '', usedDevice = '', usedDtype = '';
let tts = null, ttsId = '';
let current = null;

const MODELS = { '135m': 'HuggingFaceTB/SmolLM2-135M-Instruct', '360m': 'HuggingFaceTB/SmolLM2-360M-Instruct' };
const post = (m, transfer) => self.postMessage(m, transfer || []);
const gpuSafe = (d) => (['q8', 'int8', 'uint8'].includes(d) ? 'q4f16' : d); // int8 is broken on WebGPU

async function resolveDevice(pref) {
  if (pref !== 'webgpu') return 'wasm';
  try { const a = await navigator.gpu?.requestAdapter?.(); return a ? 'webgpu' : 'wasm'; } catch { return 'wasm'; }
}

async function init(d) {
  tf = await import(d.urls.transformers);
  // Load kokoro-js sharing THIS transformers module (rewrite its bare imports).
  let src = await (await fetch(d.urls.kokoro)).text();
  const rep = (spec, u) => { for (const q of ['"', "'"]) src = src.split(`from${q}${spec}${q}`).join(`from${JSON.stringify(u)}`); };
  rep('@huggingface/transformers', d.urls.transformers);
  rep('phonemizer', d.urls.phonemizer);
  rep('path', d.urls.stub); rep('fs/promises', d.urls.stub);
  const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  const k = await import(blobUrl);
  KokoroTTS = k.KokoroTTS; TextSplitterStream = k.TextSplitterStream;

  const env = tf.env;
  env.allowLocalModels = !!d.offline;
  env.allowRemoteModels = !d.offline;
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
  catch (e) {
    if (dev === 'wasm') throw e;
    llmKey = `${id}|${opts.dtype}|wasm`;
    gen = await build('wasm', opts.dtype); usedDevice = 'wasm'; usedDtype = opts.dtype;
  }
}

async function ensureTTS(id) {
  if (tts && ttsId === id) return;
  ttsId = id;
  tts = await KokoroTTS.from_pretrained(id, { dtype: 'q8', device: 'wasm', progress_callback: (info) => post({ type: 'progress', phase: 'tts', info }) });
}

async function generate(d) {
  await ensureLLM(d.opts);
  await ensureTTS(d.ttsId);
  post({ type: 'loaded', device: usedDevice, dtype: usedDtype });

  const session = { cancelled: false }; current = session;
  const stopper = new tf.InterruptableStoppingCriteria();
  session.stop = () => stopper.interrupt();

  const splitter = new TextSplitterStream();
  const stream = tts.stream(splitter, { voice: d.voice, speed: d.speed });
  const consume = (async () => {
    try {
      for await (const { text, phonemes, audio } of stream) {
        if (session.cancelled) break;
        const buf = audio.audio; // Float32Array — transfer to the main thread
        post({ type: 'audio', text, phonemes, sr: audio.sampling_rate, audio: buf }, [buf.buffer]);
      }
    } catch (e) { if (!session.cancelled) post({ type: 'error', error: String(e?.message || e) }); }
  })();

  const prompt = gen.tokenizer.apply_chat_template(d.messages, { tokenize: false, add_generation_prompt: true });
  let full = '';
  const streamer = new tf.TextStreamer(gen.tokenizer, {
    skip_prompt: true, skip_special_tokens: true,
    callback_function: (p) => {
      if (session.cancelled || !p) return;
      const piece = p.split('<|im_end|>')[0];
      full += piece;
      post({ type: 'token', clean: full.split('<|im_end|>')[0].split('<|im_start|>')[0] });
      try { splitter.push(piece); } catch {}
    },
  });
  try {
    await gen(prompt, { max_new_tokens: d.opts.maxTokens ?? 160, temperature: 0.5, repetition_penalty: 1.15, return_full_text: false, streamer, stopping_criteria: stopper });
  } catch (e) { if (!session.cancelled) post({ type: 'error', error: String(e?.message || e) }); }
  try { splitter.close(); } catch {}
  await consume;
  if (session === current) current = null;
  post({ type: 'done', reply: full.split('<|im_end|>')[0].split('<|im_start|>')[0].trim() || '…' });
}

self.onmessage = async (e) => {
  const d = e.data;
  try {
    if (d.type === 'init') await init(d);
    else if (d.type === 'load') { await ensureLLM(d.opts); await ensureTTS(d.ttsId); post({ type: 'loaded', device: usedDevice, dtype: usedDtype }); }
    else if (d.type === 'generate') await generate(d);
    else if (d.type === 'cancel') { if (current) { current.cancelled = true; current.stop?.(); } }
  } catch (err) { post({ type: 'error', error: String(err?.message || err) }); }
};
