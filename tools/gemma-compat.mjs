// gemma-compat.mjs — verify transformers.js (the app's pinned 3.8.1) can load Gemma-3-1B's
// tokenizer + apply its chat template, and whether a `system` role throws (→ foldSystem needed).
// Light: tokenizer/config only, no model weights.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://127.0.0.1:5173/index.html';
const MODEL = process.argv[3] || 'onnx-community/gemma-3-1b-it-ONNX';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader'] });
const p = await b.newPage({ viewport: { width: 1200, height: 800 } });
await p.goto(url, { waitUntil: 'load' });
await p.waitForFunction(() => document.querySelectorAll('#voice option').length > 0, undefined, { timeout: 60000 });

const result = await p.evaluate(async (MODEL) => {
  const out = { model: MODEL, version: '', tokenizerLoaded: false, archSupported: null, systemRoleThrows: null, foldedOk: false, sample: '', error: '' };
  try {
    const t = await import('@huggingface/transformers');
    out.version = t.env?.version || '?';
    // does this transformers.js know the model's architecture? (config → model class)
    try { const cfg = await t.AutoConfig.from_pretrained(MODEL); out.modelType = cfg?.model_type || cfg?.['model_type'] || '?'; out.archSupported = true; }
    catch (e) { out.archSupported = false; out.archErr = String(e?.message || e).slice(0, 140); }
    const tok = await t.AutoTokenizer.from_pretrained(MODEL);
    out.tokenizerLoaded = true;
    const withSystem = [{ role: 'system', content: 'You are Anchor.' }, { role: 'user', content: 'Hi there' }];
    try { tok.apply_chat_template(withSystem, { tokenize: false, add_generation_prompt: true }); out.systemRoleThrows = false; }
    catch (e) { out.systemRoleThrows = true; out.systemErr = String(e?.message || e).slice(0, 120); }
    // folded (system merged into first user turn)
    const folded = [{ role: 'user', content: 'You are Anchor.\n\nHi there' }];
    const s = tok.apply_chat_template(folded, { tokenize: false, add_generation_prompt: true });
    out.foldedOk = typeof s === 'string' && s.length > 0;
    out.sample = (s || '').slice(0, 160);
  } catch (e) { out.error = String(e?.message || e).slice(0, 200); }
  return out;
}, MODEL);
console.log(JSON.stringify(result, null, 2));
await b.close();
