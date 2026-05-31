// llm.js — Transformers.js text-generation with token streaming and a
// swappable model / dtype / device (auto-detects WebGPU, falls back to wasm).
import { pipeline, env, TextStreamer } from '@huggingface/transformers';

export const LLM_MODELS = {
  '135m': { id: 'HuggingFaceTB/SmolLM2-135M-Instruct', label: 'SmolLM2 · 135M (fast)' },
  '360m': { id: 'HuggingFaceTB/SmolLM2-360M-Instruct', label: 'SmolLM2 · 360M (smarter)' },
};

// Probe for a real GPU adapter; fall back to wasm when WebGPU is unavailable.
export async function resolveDevice(pref) {
  if (pref === 'wasm') return 'wasm';
  try { const a = await navigator.gpu?.requestAdapter?.(); return a ? 'webgpu' : 'wasm'; }
  catch { return 'wasm'; }
}

// int8 weights (q8/int8/uint8) are numerically broken on the WebGPU backend and
// emit gibberish — use a GPU-safe precision there instead.
const gpuSafeDtype = (dtype) => (['q8', 'int8', 'uint8'].includes(dtype) ? 'q4f16' : dtype);

export function createLLM({ onProgress }) {
  let gen = null, loading = null, key = '', usedDevice = '', usedDtype = '';

  async function ensure({ modelKey, dtype, device }) {
    const id = (LLM_MODELS[modelKey] || LLM_MODELS['135m']).id;
    const dev = await resolveDevice(device);
    const eff = dev === 'webgpu' ? gpuSafeDtype(dtype) : dtype;
    const wantKey = `${id}|${eff}|${dev}`;
    if (gen && key === wantKey) return { gen, device: usedDevice, dtype: usedDtype };
    if (loading && key === wantKey) return loading;

    if (gen && key !== wantKey) { try { await gen.dispose?.(); } catch {} gen = null; }
    key = wantKey;
    const build = (d, dt) => pipeline('text-generation', id, { dtype: dt, device: d, progress_callback: onProgress });
    const settle = (g, d, dt) => { gen = g; usedDevice = d; usedDtype = dt; return { gen, device: d, dtype: dt }; };
    loading = build(dev, eff)
      .then((g) => settle(g, dev, eff))
      .catch((e) => {
        if (dev === 'wasm') throw e;
        console.warn('WebGPU pipeline failed, falling back to wasm:', e?.message || e);
        key = `${id}|${dtype}|wasm`;
        return build('wasm', dtype).then((g) => settle(g, 'wasm', dtype));
      })
      .finally(() => { loading = null; });
    return loading;
  }

  // Streams decoded text pieces via onToken; resolves with the cleaned full reply.
  async function generate(messages, opts, onToken) {
    const { gen: g } = await ensure(opts);
    const prompt = g.tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true });
    let full = '';
    const streamer = new TextStreamer(g.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (piece) => {
        if (!piece) return;
        full += piece;
        // hide chat-template end markers if any slip through
        const clean = full.split('<|im_end|>')[0].split('<|im_start|>')[0];
        onToken?.(piece.split('<|im_end|>')[0], clean);
      },
    });
    await g(prompt, {
      max_new_tokens: opts.maxTokens ?? 220,
      temperature: 0.5,
      repetition_penalty: 1.15,
      return_full_text: false,
      streamer,
    });
    return (full.split('<|im_end|>')[0].split('<|im_start|>')[0].trim()) || '…';
  }

  return { ensure, generate, get loaded() { return !!gen; }, get busy() { return !!loading; } };
}

export { env };
