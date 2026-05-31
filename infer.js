// infer.js — main-thread client for the inference worker. Spawns the worker,
// initialises it with the right asset URLs (WEB or LOCAL), and surfaces a small
// event API: progress, loaded, token, audio, done, error.
export const LLM_MODELS = {
  '135m': { id: 'HuggingFaceTB/SmolLM2-135M-Instruct', label: 'SmolLM2 · 135M (fast)' },
  '360m': { id: 'HuggingFaceTB/SmolLM2-360M-Instruct', label: 'SmolLM2 · 360M (smarter)' },
};

export function createInference({ assets, offline, onProgress, onLoaded, onToken, onAudio, onDone, onError }) {
  const abs = (u) => (u ? new URL(u, document.baseURI).href : null);
  const worker = new Worker(new URL('./infer-worker.js', import.meta.url), { type: 'module' });
  let readyResolve; const ready = new Promise((r) => (readyResolve = r));

  worker.onmessage = (e) => {
    const d = e.data;
    switch (d.type) {
      case 'ready': readyResolve(); break;
      case 'progress': onProgress?.(d.phase, d.info); break;
      case 'loaded': onLoaded?.(d.device, d.dtype); break;
      case 'token': onToken?.(d.clean); break;
      case 'audio': onAudio?.(d); break;
      case 'done': onDone?.(d.reply); break;
      case 'error': onError?.(d.error); break;
    }
  };
  worker.onerror = (e) => onError?.(e.message || 'worker error');

  worker.postMessage({
    type: 'init', offline,
    urls: {
      transformers: abs(assets.transformers),
      kokoro: abs(assets.kokoro),
      phonemizer: abs(assets.phonemizer),
      stub: abs('./vendor/stub-empty.js'),
      wasm: assets.wasm,                 // already absolute (CDN or vendored)
      localModelPath: abs(assets.modelBase),
    },
  });

  return {
    ready,
    load: (payload) => worker.postMessage({ type: 'load', ...payload }),
    generate: (payload) => worker.postMessage({ type: 'generate', ...payload }),
    cancel: () => worker.postMessage({ type: 'cancel' }),
  };
}
