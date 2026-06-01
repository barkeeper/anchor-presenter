// stt.js — push-to-talk voice input. Records the mic and resamples to 16 kHz mono
// on the main thread (AudioContext is main-thread only), then hands the PCM to
// stt-worker.js for Whisper transcription so inference never janks the face.
export const STT_MODEL = 'onnx-community/whisper-tiny.en';

// whisper-tiny.en routinely hallucinates these on silence / breath / non-speech.
// If the WHOLE transcript reduces to one of them, treat it as no input.
const PHANTOMS = new Set([
  'thankyou', 'thankyouforwatching', 'thanksforwatching', 'thankyouverymuch', 'thanksforlistening',
  'you', 'bye', 'byebye', 'thanks', 'please', 'pleasesubscribe', 'subscribe', 'okay', 'ok',
  'thefirstofall', 'ithinkitsgoingtobeagoodone', 'wewillseeyouinthenextvideo',
]);

export function createSTT({ assets, offline, onProgress }) {
  const abs = (u) => (u ? new URL(u, document.baseURI).href : null);
  const urls = { transformers: abs(assets.transformers), wasm: assets.wasm, localModelPath: abs(assets.modelBase) };
  const worker = new Worker(new URL('./stt-worker.js', import.meta.url), { type: 'module' });

  let resolveReady; const ready = new Promise((r) => (resolveReady = r));
  let resolveLoaded; let loadedP = null; let loaded = false;
  let reqId = 0; const pending = new Map();

  worker.onmessage = (e) => {
    const d = e.data;
    switch (d.type) {
      case 'ready': resolveReady(); break;
      case 'progress': onProgress?.(d.info); break;
      case 'loaded': loaded = true; resolveLoaded?.(); break;
      case 'result': pending.get(d.id)?.resolve(d.text); pending.delete(d.id); break;
      case 'error':
        if (d.id != null && pending.has(d.id)) { pending.get(d.id).reject(new Error(d.error)); pending.delete(d.id); }
        else console.error('stt-worker:', d.error);
        break;
    }
  };
  worker.onerror = (e) => console.error('stt-worker error:', e.message || e);
  worker.postMessage({ type: 'init', offline, urls });

  let stream = null, recorder = null, chunks = [];

  // Preload the Whisper model (resolves once it's in memory in the worker).
  function ensure() {
    if (loaded) return Promise.resolve();
    if (!loadedP) loadedP = new Promise((r) => (resolveLoaded = r));
    ready.then(() => worker.postMessage({ type: 'load', model: STT_MODEL }));
    return loadedP;
  }

  async function startRecording() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.start();
  }

  // stop, decode, resample to 16k mono, gate non-speech, then transcribe in the worker
  async function stopAndTranscribe() {
    if (!recorder) return '';
    const blob = await new Promise((res) => { recorder.onstop = () => res(new Blob(chunks, { type: recorder.mimeType })); recorder.stop(); });
    stream?.getTracks().forEach((t) => t.stop());
    stream = null; recorder = null;

    const arr = await blob.arrayBuffer();
    if (!arr.byteLength) return '';
    const tmp = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await tmp.decodeAudioData(arr);
    tmp.close();

    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
    const rendered = await off.startRendering();
    const pcm = rendered.getChannelData(0);

    // ---- non-speech gate: drop clips that are too short or too quiet to be a real utterance.
    const dur = pcm.length / 16000;
    let sumSq = 0; for (let i = 0; i < pcm.length; i++) sumSq += pcm[i] * pcm[i];
    const rms = Math.sqrt(sumSq / Math.max(1, pcm.length));
    if (dur < 0.3 || rms < 0.005) return '';

    await ready;
    const id = ++reqId;
    const text = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'transcribe', id, model: STT_MODEL, pcm }, [pcm.buffer]); // zero-copy
    });

    // ---- phantom filter: a transcript that's ONLY a known hallucination phrase is no input.
    const norm = (text || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!norm || PHANTOMS.has(norm)) return '';
    return text;
  }

  return { ensure, startRecording, stopAndTranscribe, get loaded() { return loaded; } };
}
