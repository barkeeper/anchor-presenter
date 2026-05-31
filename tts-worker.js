// tts-worker.js — Kokoro TTS in its own thread. Receives token pieces while the
// LLM is still generating (in the other worker) and synthesizes audio in
// parallel, so the first words are spoken as soon as the first sentence exists.
// kokoro-js's bare imports are rewritten to absolute URLs + loaded as a Blob.
let tf = null, KokoroTTS = null, TextSplitterStream = null, tts = null, ttsId = '', session = null;
const post = (m, transfer) => self.postMessage(m, transfer || []);

async function init(d) {
  tf = await import(d.urls.transformers);
  let src = await (await fetch(d.urls.kokoro)).text();
  const rep = (spec, u) => { for (const q of ['"', "'"]) src = src.split(`from${q}${spec}${q}`).join(`from${JSON.stringify(u)}`); };
  rep('@huggingface/transformers', d.urls.transformers);
  rep('phonemizer', d.urls.phonemizer);
  rep('path', d.urls.stub); rep('fs/promises', d.urls.stub);
  const k = await import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  KokoroTTS = k.KokoroTTS; TextSplitterStream = k.TextSplitterStream;
  const env = tf.env;
  env.allowLocalModels = !!d.offline; env.allowRemoteModels = !d.offline;
  if (d.offline && d.urls.localModelPath) env.localModelPath = d.urls.localModelPath;
  env.backends.onnx.wasm.wasmPaths = d.urls.wasm;
  post({ type: 'ready' });
}
async function ensureTTS(id) {
  if (tts && ttsId === id) return;
  ttsId = id;
  tts = await KokoroTTS.from_pretrained(id, { dtype: 'q8', device: 'wasm', progress_callback: (info) => post({ type: 'progress', phase: 'tts', info }) });
}
function cancel() { if (session) { session.cancelled = true; try { session.splitter.close(); } catch {} session = null; } }
function begin(d) {
  cancel();
  const s = { cancelled: false, splitter: new TextSplitterStream() }; session = s;
  (async () => {
    try {
      await ensureTTS(d.ttsId);
      const stream = tts.stream(s.splitter, { voice: d.voice, speed: d.speed });
      for await (const { text, phonemes, audio } of stream) {
        if (s.cancelled) break;
        const buf = audio.audio;
        post({ type: 'audio', text, phonemes, sr: audio.sampling_rate, audio: buf }, [buf.buffer]);
      }
    } catch (e) { if (!s.cancelled) post({ type: 'error', error: String(e?.message || e) }); }
    finally { if (session === s) session = null; post({ type: 'tts-done' }); }
  })();
}
self.onmessage = async (e) => {
  const d = e.data;
  try {
    if (d.type === 'init') await init(d);
    else if (d.type === 'load') { await ensureTTS(d.ttsId); post({ type: 'loaded-tts' }); }
    else if (d.type === 'begin') begin(d);
    else if (d.type === 'push') { if (session && !session.cancelled) try { session.splitter.push(d.piece); } catch {} }
    else if (d.type === 'close') { if (session) try { session.splitter.close(); } catch {} }
    else if (d.type === 'cancel') cancel();
  } catch (err) { post({ type: 'error', error: String(err?.message || err) }); }
};
