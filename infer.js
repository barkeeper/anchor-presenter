// infer.js — main-thread client coordinating two parallel workers:
//   • llm-worker  → streams token deltas
//   • tts-worker  → turns those deltas into audio, concurrently
// The LLM and TTS therefore run on separate threads (low latency) while the
// main thread only schedules audio + renders the face.
export const LLM_MODELS = {
  '135m': { id: 'HuggingFaceTB/SmolLM2-135M-Instruct', label: 'SmolLM2 · 135M (fast)' },
  '360m': { id: 'HuggingFaceTB/SmolLM2-360M-Instruct', label: 'SmolLM2 · 360M (smarter)' },
};

export function createInference({ assets, offline, onProgress, onLoaded, onToken, onAudio, onSpeechEnd, onDone, onError }) {
  const abs = (u) => (u ? new URL(u, document.baseURI).href : null);
  const urls = {
    transformers: abs(assets.transformers), kokoro: abs(assets.kokoro), phonemizer: abs(assets.phonemizer),
    stub: abs('./vendor/stub-empty.js'), wasm: assets.wasm, localModelPath: abs(assets.modelBase),
  };
  const llm = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
  const tts = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
  let r1, r2; const ready = Promise.all([new Promise((r) => (r1 = r)), new Promise((r) => (r2 = r))]);

  llm.onmessage = (e) => {
    const d = e.data;
    switch (d.type) {
      case 'ready': r1(); break;
      case 'progress': onProgress?.('llm', d.info); break;
      case 'loaded': onLoaded?.(d.device, d.dtype); break;
      case 'piece': onToken?.(d.clean); tts.postMessage({ type: 'push', piece: d.piece }); break;
      case 'done': tts.postMessage({ type: 'close' }); onDone?.(d.reply); break;
      case 'error': onError?.(d.error); break;
    }
  };
  tts.onmessage = (e) => {
    const d = e.data;
    switch (d.type) {
      case 'ready': r2(); break;
      case 'progress': onProgress?.('tts', d.info); break;
      case 'audio': onAudio?.(d); break;
      case 'tts-done': onSpeechEnd?.(); break;
      case 'error': onError?.(d.error); break;
    }
  };
  llm.onerror = tts.onerror = (e) => onError?.(e.message || 'worker error');

  llm.postMessage({ type: 'init', offline, urls });
  tts.postMessage({ type: 'init', offline, urls });

  return {
    ready,
    load: (p) => { llm.postMessage({ type: 'load', opts: p.opts }); tts.postMessage({ type: 'load', ttsId: p.ttsId }); },
    generate: (p) => { tts.postMessage({ type: 'begin', ttsId: p.ttsId, voice: p.voice, speed: p.speed }); llm.postMessage({ type: 'generate', messages: p.messages, opts: p.opts }); },
    cancel: () => { llm.postMessage({ type: 'cancel' }); tts.postMessage({ type: 'cancel' }); },
  };
}
