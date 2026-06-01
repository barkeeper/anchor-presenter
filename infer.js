// infer.js — main-thread client coordinating two parallel workers:
//   • llm-worker  → streams token deltas
//   • tts-worker  → turns those deltas into audio, concurrently
// The LLM and TTS therefore run on separate threads (low latency) while the
// main thread only schedules audio + renders the face.
export const LLM_MODELS = {
  'gemma-4-e2b': { id: 'onnx-community/gemma-4-E2B-it-ONNX', label: 'Gemma 4 · E2B (conversational)' },
  // hidden from the dropdown — used only as a last-resort fallback so the app never dead-ends
  'qwen3-0.6b': { id: 'onnx-community/Qwen3-0.6B-ONNX', label: 'Qwen3 · 0.6B', fallback: true },
};
// Gemma needs the worker's max-buffer-limit override (see llm-worker.js) to fit on WebGPU
// (its 262k-token vocab makes a large embedding buffer). If it still can't, drop to 0.6B.
const GPU_ORDER = ['gemma-4-e2b', 'qwen3-0.6b'];

// Fallback ladder. A failed WebGPU OrtCreateSession (e.g. the 1.7B exceeds the GPU's
// buffer-size limit) calls abort() and poisons the worker's whole ORT runtime — so each
// rung must run in a FRESH worker. We try the user's pick on the GPU, then progressively
// smaller models on the SAME GPU, then the small model on CPU as a last resort.
function buildLadder(opts) {
  const rungs = [{ ...opts }];
  if (opts.device === 'webgpu') {
    const start = GPU_ORDER.indexOf(opts.modelKey);
    for (let i = (start === -1 ? 0 : start + 1); i < GPU_ORDER.length; i++) rungs.push({ ...opts, modelKey: GPU_ORDER[i], dtype: 'q4f16' });
    rungs.push({ ...opts, device: 'wasm', modelKey: 'qwen3-0.6b', dtype: 'q8' }); // CPU last resort
  }
  return rungs;
}

export function createInference({ assets, offline, onProgress, onLoaded, onToken, onAudio, onSpeechEnd, onDone, onError, onEnv }) {
  const abs = (u) => (u ? new URL(u, document.baseURI).href : null);
  const urls = {
    transformers: abs(assets.transformers), kokoro: abs(assets.kokoro), phonemizer: abs(assets.phonemizer),
    stub: abs('./vendor/stub-empty.js'), wasm: assets.wasm, localModelPath: abs(assets.modelBase),
  };

  const tts = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });

  // The LLM worker is disposable: we tear it down and respawn for each ladder rung.
  let llm, llmReadyResolve, llmReady;
  let rungs = [], rungIdx = 0, lastReq = null, lastErr = '';
  // Remember which rung actually loaded so repeat prompts REUSE it (no ladder walk, no
  // reload) — we only re-walk when the user changes model/device/dtype.
  let activeKey = null, loadedRung = null;
  const optKey = (o) => `${o.modelKey}|${o.dtype}|${o.device}`;

  function onLLMMessage(e) {
    const d = e.data;
    switch (d.type) {
      case 'ready': llmReadyResolve?.(); break;
      case 'env': onEnv?.(d); break;
      case 'progress': onProgress?.('llm', d.info); break;
      case 'loaded': loadedRung = rungs[rungIdx] || loadedRung; onLoaded?.(d.device, d.dtype, d.modelKey); break;
      case 'piece': onToken?.(d.clean); tts.postMessage({ type: 'push', piece: d.piece }); break;
      case 'done': tts.postMessage({ type: 'close' }); onDone?.(d.reply); break;
      case 'error':
        if (d.code === 'load-failed') { lastErr = d.error || lastErr; advanceLadder(); return; }
        onError?.(d.error);
        break;
    }
  }
  function makeLLM() {
    const w = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = onLLMMessage;
    w.onerror = (e) => onError?.(e.message || 'llm worker error');
    return w;
  }
  function startLLM() {
    llmReady = new Promise((r) => (llmReadyResolve = r));
    llm = makeLLM();
    llm.postMessage({ type: 'init', offline, urls });
  }
  startLLM();

  // Send the current rung's request to the (current) LLM worker.
  function sendRung() {
    const opts = rungs[rungIdx];
    if (lastReq.type === 'generate') {
      const p = lastReq.payload;
      tts.postMessage({ type: 'begin', ttsId: p.ttsId, voice: p.voice, speed: p.speed });
      llm.postMessage({ type: 'generate', messages: p.messages, opts });
    } else {
      llm.postMessage({ type: 'load', opts });
    }
  }
  // A rung failed to load: respawn a clean worker and try the next rung, or give up.
  async function advanceLadder() {
    if (rungIdx >= rungs.length - 1) { onError?.(`Could not load any LLM. Last error: ${lastErr}`); return; }
    rungIdx++;
    try { tts.postMessage({ type: 'cancel' }); } catch {}
    try { llm.terminate(); } catch {}
    startLLM();
    await llmReady;
    if (lastReq) sendRung();
  }

  let r2; const ttsReady = new Promise((r) => (r2 = r));
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
  tts.onerror = (e) => onError?.(e.message || 'tts worker error');
  tts.postMessage({ type: 'init', offline, urls });

  return {
    ready: Promise.all([llmReady, ttsReady]),
    load: (p) => {
      tts.postMessage({ type: 'load', ttsId: p.ttsId });
      if (loadedRung && activeKey === optKey(p.opts)) return;          // already loaded → nothing to do
      activeKey = optKey(p.opts); rungs = buildLadder(p.opts); rungIdx = 0; loadedRung = null; lastErr = '';
      lastReq = { type: 'load', payload: p }; llm.postMessage({ type: 'load', opts: rungs[0] });
    },
    generate: (p) => {
      lastReq = { type: 'generate', payload: p };
      if (loadedRung && activeKey === optKey(p.opts)) {                // reuse the loaded model — no reload
        tts.postMessage({ type: 'begin', ttsId: p.ttsId, voice: p.voice, speed: p.speed });
        llm.postMessage({ type: 'generate', messages: p.messages, opts: loadedRung });
        return;
      }
      activeKey = optKey(p.opts); rungs = buildLadder(p.opts); rungIdx = 0; loadedRung = null; lastErr = '';
      sendRung();
    },
    cancel: () => { lastReq = null; llm.postMessage({ type: 'cancel' }); tts.postMessage({ type: 'cancel' }); },
    // Hard abort: tear down + respawn the LLM worker so an in-flight (possibly stuck)
    // model download is actually cancelled. Used by the stall watchdog's "cancel" action.
    reset: () => { lastReq = null; rungs = []; rungIdx = 0; activeKey = null; loadedRung = null; try { llm.terminate(); } catch {} startLLM(); try { tts.postMessage({ type: 'cancel' }); } catch {} },
  };
}
