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

export function createLLM({ onProgress }) {
  let gen = null, loading = null, key = '';

  async function ensure({ modelKey, dtype, device }) {
    const id = (LLM_MODELS[modelKey] || LLM_MODELS['135m']).id;
    const dev = await resolveDevice(device);
    const wantKey = `${id}|${dtype}|${dev}`;
    if (gen && (key === wantKey || key === `${id}|${dtype}|wasm`)) return { gen, device: dev };
    if (loading && key === wantKey) return loading;

    if (gen && key !== wantKey) { try { await gen.dispose?.(); } catch {} gen = null; }
    key = wantKey;
    const build = (d) => pipeline('text-generation', id, { dtype, device: d, progress_callback: onProgress });
    loading = build(dev)
      .catch((e) => {
        if (dev === 'wasm') throw e;
        console.warn('WebGPU pipeline failed, falling back to wasm:', e?.message || e);
        key = `${id}|${dtype}|wasm`;
        return build('wasm').then((g) => ({ g, used: 'wasm' }));
      })
      .then((r) => { gen = r.g || r; return { gen, device: r.used || dev }; })
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
