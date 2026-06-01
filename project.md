# Project Log — ANCHOR (local in-browser AI presenter)

Single-page web app: chat → LLM → Kokoro TTS → VRM talking head, 100% in-browser.

---

## ✅ RESOLVED — "Could not load any LLM" dead-end (2026-06-01)

**Symptom:** clicking "send" yielded `Error: Could not load any LLM. Last error: …` —
originally `Aborted()`, later (current code) `no available backend found. ERR: [webgpu] Error: Failed to get GPU adapter.`

**Verified root cause — ORT backend contamination in the worker.** When the LLM worker
has no usable WebGPU adapter, the first attempt (user's model on `webgpu`) fails *and
poisons onnxruntime-web's global backend state for the rest of that worker's life*. The
fallback then requests `device:'wasm'`, but ORT **still only attempts the webgpu EP** and
reports "no available backend found" — so the safety net never ran. Result: a hard
dead-end on any machine where the **worker** can't get an adapter (even if the main
thread can).

**How we proved it (tools/, all on a GPU-less headless box):**
- `tools/llm-diag.mjs` — drives the page, reports `navigator.gpu.requestAdapter()` on BOTH
  the main thread and inside the worker (worker posts `{type:'env'}` → `window.__llmEnv`),
  then attempts a real generation. Showed the wasm fallback failing with a *webgpu* error.
- `tools/wasm-only-probe.mjs` — seeds `localStorage` to force `device=wasm` + the small
  model BEFORE boot, so the very first ORT attempt is wasm (nothing to contaminate it).
  Result: **`LIVE (wasm loaded + speaking)`** → CPU/WASM inference works fine on its own.

**This disproved an earlier belief:** doc previously claimed Qwen3's GroupQueryAttention
can't run on transformers.js v3 WASM. **False** — Qwen3-0.6B q8 runs on the WASM EP. The
real reason the old wasm fallback "aborted" was that it fell back with the *1.7B* model,
which doesn't fit the WASM heap. The fallback now uses the small 0.6B q8.

**The fix (llm-worker.js):**
- Probe `navigator.gpu.requestAdapter()` once at init → `workerGpuOk`. (Also posted to the
  page as the `env` diagnostic.)
- `useWebGPU(pref) = pref==='webgpu' && workerGpuOk`. If the worker got no adapter we NEVER
  attempt a webgpu session — webgpu can't work here anyway, and attempting it is exactly
  what poisoned the wasm backend. We go straight to a **clean** wasm load of the small model.
- Re-introducing the worker-side pre-flight is safe (the doc had removed it fearing it
  "lies"): if `requestAdapter()` is null in the worker, ORT's webgpu can't get one either,
  so we lose no working GPU case — we only avoid the contaminating attempt.
- Also fixed a latent dedup bug: the `gen && llmKey === wantKey` guard compared a model
  *key* against a stored model *id*, so it never matched and always reloaded.

**Outcome:** with defaults (`webgpu`/1.7B) on a no-adapter box, load is now
`LIVE (loaded + speaking)` via the small CPU model instead of the dead-end.

**Still worth doing (not blocking):**
- ~~respawn the worker pinned to wasm if webgpu-with-adapter still fails~~ — **done** (see
  improvements below): `llm-worker.js` tags a total load failure `code:'load-failed'`, and
  `infer.js` respawns the worker once pinned to wasm and replays the request.
- Verify on a **real-GPU** machine that the worker gets `adapter OK` and 1.7B runs on the
  GPU (the headless CI box has no GPU, so this path is unverified here). Check the
  `[llm-worker env]` console line: worker should say `adapter OK`.

**To debug, in browser DevTools:**
- `window.__llmEnv` — `{gpu, coi, sab}` as seen *inside the worker*.
- `self.crossOriginIsolated` must be `true`; `typeof SharedArrayBuffer` must be `'function'`.
- `await navigator.gpu?.requestAdapter()` on the main thread — compare against the worker's.

---

## Improvements batch (2026-06-01)

Nine improvements landed in one pass (user picked 1,2,3,5,6,7,8,9,10 from a list of 10;
skipped #4 prefers-reduced-motion). Verified headlessly where possible (boot smoke clean,
LLM still reaches `LIVE`, rare clip still drives the rig).

1. **WebGPU worker respawn** — `llm-worker.js` tags total load failure `code:'load-failed'`;
   `infer.js` now owns the LLM worker's lifecycle (`makeLLM`/`startLLM`/`respawnWasm`) and,
   on that code, terminates + respawns the worker once pinned to `device:'wasm'` and replays
   the last request (`lastReq`). Escapes any poisoned ORT state. One retry per user request.
2. **STT off the main thread** — new `stt-worker.js` runs Whisper inference; `stt.js` is now a
   thin client that still records + resamples to 16 kHz (AudioContext is main-thread only) and
   ships the PCM (zero-copy transfer) to the worker. Transcription no longer janks the face.
3. **Hold-to-talk + click-to-toggle + barge-in** — `app.js` mic is a small state machine
   (`micStart`/`micStop`/`micPressStart`/`micPressEnd`), pointer + spacebar (push-to-talk).
   Starting a recording cancels the avatar's current speech/generation. Mic stays enabled
   while busy so the user can interrupt.
5. **Whisper hallucination filter** — `stt.js` drops clips that are too short/quiet (duration
   < 0.3s or RMS < 0.005) and a `PHANTOMS` set catches transcripts that reduce to a known
   silence-hallucination ("thank you", "you", "thanks for watching", …).
6. **Single-source shell list** — `shell-files.json` is the one app-shell manifest, fetched by
   BOTH `sw.js` (install) and `app.js` (`buildPrecacheList`, now async). Fixes prior drift
   (e.g. the new `stt-worker.js` would have been missed offline).
7. **Dynamic camera framing** — `face.js` `setCamera(wide, x)`; the loop eases the camera wider
   and pans to follow the hips during a rare dance (which can roam), then settles back to the
   tight resting frame. `rareActive`/`queuedIsRare` track when a rare clip is on screen.
8. **SW stale-while-revalidate** — `sw.js` serves large static same-origin assets
   (`vrm/vrma/img/font…`) from cache instantly and revalidates in the background; **code stays
   network-first** so dev edits still show immediately. Cache bumped to `anchor-v11`.
   (True build-stamped auto-versioning still needs a build step — left as one manual knob.)
9. **A11y announcer + mood debounce** — dropped `aria-live` from `#chat` (was token-spam),
   added a visually-hidden `#srAnnouncer` (`.sr-only`) that announces the final reply once.
   Mood now updates on sentence boundaries (or a long run) instead of every 28 chars.
10. **Context budgeting** — `getMessages()` keeps as many whole recent turns as fit a
    ~6000-char budget (token proxy) instead of a blunt last-12 window.

### Second batch (2026-06-01) — user picked 11, 12, 13

11. **Model-download resilience** — workers (`llm`/`tts`/`stt`) now retry transient network
    failures once (`TRANSIENT` regex; backend/OOM errors are not retried). `app.js` has a
    **stall watchdog**: after 20s with no progress the overlay swaps its hint to a
    "slow/interrupted connection" message and reveals a **cancel** button (`#ovCancel`).
    Cancel calls `inference.reset()` — a new method that terminates + respawns the LLM worker
    so a stuck download is actually aborted — then resets the UI.
12. **Preconnect / dns-prefetch** in `<head>` for `cdn.jsdelivr.net`, `huggingface.co`,
    `cdn-lfs.huggingface.co` so first-run lib/model downloads start sooner.
13. **Dances in the UI** — a header **Dance** button (`#danceBtn`) calls a new
    `face.playRare()` exposed on the `createFace()` return object (no longer DevTools-only).
    Clips are now **named from their filename** in `loadClip` (were all `"Clip"`), so
    `__face.status().currentClip` is meaningful. Verified: clicking the button switches
    `currentClip` to a rare clip (e.g. `BabyYou`).

New diagnostic tools (headless, swiftshader): `tools/llm-diag.mjs`, `tools/wasm-only-probe.mjs`,
`tools/rare-probe.mjs`, `tools/rare-motion-probe.mjs`, `tools/smoke-load.mjs`, `tools/dance-btn-probe.mjs`.

---

## REAL root cause of `Aborted()` (from the user's machine, 2026-06-01)

Got actual console output from the user's real (GPU) machine — it **disproved** the SAB/COI
hypothesis:
```
[llm-worker env] WebGPU adapter: adapter OK · crossOriginIsolated: true · SharedArrayBuffer: function
ort-wasm-simd-threaded.jsep.mjs Aborted()  ← at e._OrtCreateSession
[llm-worker] load failed for qwen3-1.7b q4f16 webgpu — Aborted().
[llm-worker] load failed for qwen3-0.6b q8 wasm   — Aborted().
```
So the GPU works and isolation is fine. **Qwen3-1.7B q4f16 (~1.3 GB) aborts at WebGPU
`OrtCreateSession`** — almost certainly exceeds the GPU's `maxStorageBufferBindingSize`.
That `abort()` poisons the worker's ORT runtime, so the same-worker wasm fallback aborts too.

**Fix — cross-worker fallback ladder.** Because a webgpu abort kills the whole worker, the
fallback can't live inside it. `llm-worker.js` `ensureLLM` now does ONE attempt. `infer.js`
owns the ladder and runs each rung in a FRESH worker: user's model on GPU → **0.6B on the
same GPU** (fits where 1.7B didn't) → 0.6B on CPU/wasm. So a 1.7B-too-big GPU now gets the
0.6B accelerated on the GPU instead of dropping all the way to CPU. (GPU rungs unverified on
the headless box — no GPU here; no-GPU path still reaches `LIVE`.)

Other fixes same day: emoji stripped before chat+TTS (`stripEmoji` in llm-worker — Kokoro was
speaking "smiling face with smiling eyes"); responsive flex layout so the notice banner no
longer pushes the panels out of bounds (`styles.css`); the 5 rare VRMA clips confirmed valid
(real motion: BabyYou 180° hips/~100° arms/20s, etc.) via `tools/inspect-vrma*.mjs`.

## Added a middle model — Qwen2.5-1.5B (2026-06-02)

1.7B q4f16 aborts WebGPU `OrtCreateSession` on common GPUs because its token-embedding tensor
(vocab 151936 × hidden **2048** ≈ 156 MB at q4f16) exceeds the typical 128 MiB WebGPU
per-buffer binding limit. Qwen3 has no size between 0.6B and 1.7B, so added
**`onnx-community/Qwen2.5-1.5B-Instruct`** (hidden **1536** → embedding ≈ 117 MB, under the
limit; and it uses ChatML `<|im_start|>/<|im_end|>` so it's a drop-in for the existing
sanitize/sentinel logic). Now the **default**. `GPU_ORDER = [1.7b, 1.5b, 0.6b]` drives the
ladder largest→smallest, so a card that can't run 1.7B auto-lands on the biggest model it CAN
run. Banner now names the actually-loaded model + device (was hardcoded "0.6B"). GPU rungs
still unverified here (no GPU); no-GPU path reaches `LIVE`.

## WebGPU max-buffer override + coding models (2026-06-02)

User has a 12 GB GPU but 1.7B AND 1.5B abort while 0.6B loads → it's the **per-buffer
binding limit** (`maxStorageBufferBindingSize`), NOT VRAM. WebGPU's default is ~128–256 MB
even on big cards, and the Qwen 152k-token embedding exceeds it. **Fix:** in `llm-worker.js`
init, request a GPU device with the **adapter's real max limits** and hand it to ORT
(`env.backends.onnx.webgpu.{adapter,device}`) so big models fit. The worker now also reports
`maxStorageBufferMB` (logged by app.js) so we can see the card's true limit.

Models swapped to coders per user request (smart + coding): **Qwen2.5-Coder-1.5B (default)**
and **3B**, plus Qwen3-0.6B as the tiny CPU fallback. `GPU_ORDER = [coder-3b, coder-1.5b,
0.6b]`. Small-vocab alternatives (Phi-3.5, DeepSeek-Coder, StableLM) are gated/404 for
transformers.js, so the coders + buffer override is the path. GPU override UNVERIFIED here
(no GPU); no-GPU path reaches `LIVE`.

**Open tension:** the presenter system prompt forces 1–2 short spoken sentences, no
markdown/code (maxTokens 160) — which muzzles a coding model. Needs a "coding mode" (relax
prompt, raise tokens) if the user wants actual code output.

## transformers.js 3.8.1 → 4.2.0 upgrade for Gemma 4 (2026-06-02)

User wanted Gemma 4. Verified the chain with cheap probes (`tools/gemma4-arch.mjs`):
- transformers.js **3.8.1 throws `Unsupported model type: gemma4`** (fails fast, before any
  weight download). **4.2.0 supports it** (proceeds to fetch `decoder_model_merged_q4f16` +
  `embed_tokens` — loads as plain text-generation; the vision/audio encoders aren't fetched).
- 4.x ships only the ORT wasm *loader* (`.mjs`) in its dist, NOT the `.wasm` binary — that
  lives in `onnxruntime-web@1.26.0-dev.20260416-b7804b056c/dist/` (this is the "4.x not
  jsdelivr-friendly" gotcha). So `wasm` URL points there now.

Changes: `index.html` CDN `transformers` → `@4.2.0`, `wasm` → the onnxruntime-web 1.26 dist.
Model lineup → **gemma-4-e2b** (`onnx-community/gemma-4-E2B-it-ONNX`, default) + hidden
qwen3-0.6b fallback. SW cache → `anchor-v12`. Worker already handles Gemma turn-sentinels
(STOP regex) + system-role fold.

**Verified here (no-GPU box):** boot clean on 4.2.0; end-to-end `LIVE` — LLM (qwen3-0.6b
wasm) + Kokoro TTS both work on 4.x. Kokoro logs a benign `style_text_to_speech_2 → EncoderOnly`
fallback warning but speaks fine. **Unverified (needs the user's GPU):** Gemma-4-E2B actually
loading on WebGPU (buffer fit for its 262k-vocab embedding) and the device max-buffer override
under ORT 1.26. **LOCAL mode is now stale** (vendored 3.8.1) — online/WEB only until re-vendored.

## UX batch (2026-06-02)

- **Download popup solid** — `app.js` paints the overlay throttled (~8×/sec), AGGREGATE
  (total bytes + file count), MONOTONIC % (Gemma arrives as many shards; per-file repaint
  flickered + % jumped backward). `resetProgress()` resets the monotonic baseline.
- **Mouth closes after speech** — `face.js` mouth openness is now gated purely by live audio
  amplitude (`visCur * min(1, openS*1.4)`, no 0.25 base); `setSpeaking(false)` zeroes
  `level/openS/visCur/visTarget`. Verified: mouth samples → 0 after speech (was stuck open
  after the 4.x TTS change).
- **Text ↔ voice sync** — chat bubble no longer dumps the full LLM reply ahead of the voice.
  `speech.js` emits `onSpoken(cumulativeSpokenText)`; `app.js` reveals the bubble from that
  (`reveal` ctx), finalizing the full text on `onState('idle')`. Verified: at speech start
  bubble=2 chars vs full=181, then 12 gradual steps.
- **Renamed ANCHOR → SAKURA** (top-bar h1, `<title>`, manifest name/short_name). Sigil stays
  錨. **Favicon** → new `icons/favicon.svg` (the 錨 sign on dark). Moved the LLM/TTS "Loaded
  models" meta from the chat header into the Settings drawer; **reset → "reset chat"**.

## Dance music (2026-06-02)

User dropped 5 mp3s in `music/`. Renamed each to match its dance clip → `music/<ClipName>.mp3`
(`OtonaBlue/BabyYou/TocaToca` certain by title; `RareDance_3` ← 可愛くてごめん and
`RareDance_5` ← 青空のラプソディ are best-guesses by duration — swap the two files if wrong).
`face.playRare()` now returns the clip name; `app.js` `playDance()` plays the dance + its
track on the ✦ button only (idle auto-dances stay silent). Music stops on new prompt / stop /
reset / mic. SW SWR now caches `mp3|svg`; tracks added to `shell-files.json`. Verified with
`tools/dance-music-probe.mjs`: clip==track, playing, for all clips.

## Architecture

```
┌────────────────────────────────────────────────────────┐
│ index.html      — bootstrap, import map, SW register  │
├────────────────────────────────────────────────────────┤
│ app.js (main)   — UI, settings, chat, env probe       │
│   │                                                    │
│   ├── speech.js    — caption + face glue              │
│   ├── stt.js       — Whisper (main thread)            │
│   ├── face.js      — VRM/VRMA/expressions (main)      │
│   └── infer.js     — bridge to LLM/TTS workers        │
│                                                        │
│ llm-worker.js   — Qwen3 via transformers.js + ORT     │
│ tts-worker.js   — Kokoro-82M                          │
│                                                        │
│ sw.js           — offline cache + COOP/COEP injection │
└────────────────────────────────────────────────────────┘
```

---

## File-by-file summary of session work

### `face.js` — VRM character & animation
- Switched body animation from procedural sin-wave gestures to **VRMA mocap clips** via `@pixiv/three-vrm-animation`.
- **Intro:** plays `VRMA_01.vrma` ("Show full body" from pixiv pack) once on load — the walk-in.
- **Idle pool:** cycles `VRMA_02..07` (Greeting, Peace sign, Shoot, Spin, Model pose, Squat).
- **Rare pool:** 5 dance clips in `assets/vrma/` — `OtonaBlue`, `BabyYou`, `TocaToca`, `RareDance_3`, `RareDance_5` (mojibake-named originals from `OneDrive/vrma/vrma.zip`). Plays one every 5–9 min using a Fisher-Yates shuffle queue so all five cycle before any repeats, and the first clip after each reshuffle won't be the one just played.
- **Expressions on top of body anim:** mouth visemes (lip-sync), blinks, mood (happy/sad/etc.), gaze (eyes follow cursor + saccades) all driven via `expressionManager.setValue` and `lookAt` target — independent of whatever VRMA clip is playing, so speech keeps working.
- **Blink fix:** old code had a 30 ms reschedule window that `dt` could jump over → blink fired every frame. Rewrote as proper state machine: idle → close+open over ~140 ms → schedule next 2.4–5.6 s.
- **Clock fix:** `clock.getElapsedTime()` internally calls `getDelta()`, so calling them in the wrong order returned ~0 for `dt`. Now reads `dt` first, then `t = clock.elapsedTime`.
- **Full-body framing:** measured VRM bounding box once at boot, camera distance fits the whole body (head to toe), centered on body center. Doesn't follow her sideways during walk-in.
- **Debug hooks:** `window.__face.status()` returns `{rareLoaded, secondsUntilRare, currentClip, idleCount}`. `window.__face.playRare()` triggers a rare clip immediately.

### `app.js` — main thread
- **Defaults:** `model='qwen3-1.7b'`, `device='webgpu'`, `dtype='q4f16'`. Resolved values are written back to localStorage so the dropdowns stay in sync.
- **Migration:** stale `'135m'`/`'360m'` (old SmolLM2) entries in localStorage get reset to the current default.
- **Environment probe:** at boot, checks `navigator.gpu.requestAdapter()` on the main thread (where it's reliably exposed) and `crossOriginIsolated`. Shows a banner if WebGPU is unavailable or COI isn't engaged.
- **HUD update on fallback:** if the LLM worker falls back from the user's selection (e.g. 1.7B → 0.6B WASM), the `#llmId` badge updates and a banner explains why.
- **Threaded WASM workaround:** `env.backends.onnx.wasm.numThreads = 1` and `proxy = false` for the main-thread transformers.js env (used by Whisper STT).

### `index.html` — boot
- Updated `@huggingface/transformers` CDN URL to `3.8.1` (both the JS bundle and the WASM dir — they must match).
- Added `@pixiv/three-vrm-animation@3.4.5` to the import map (CDN + offline path).
- **Auto-COI reload:** after registering the SW, if `crossOriginIsolated` is still false, soft-reloads once (`location.reload()` — through the SW, not via Ctrl+Shift+R which bypasses it). Guarded by `sessionStorage['coi-reload']` so it never loops.
- Settings panel now shows Compute dropdown defaulted to WebGPU (was "auto") and Precision options annotated with size hints.

### `llm-worker.js`
- `MODELS` = `{ 'qwen3-1.7b': 'onnx-community/Qwen3-1.7B-ONNX', 'qwen3-0.6b': 'onnx-community/Qwen3-0.6B-ONNX' }`.
- Fallback ladder in `ensureLLM`: tries the user-selected combo first; if it throws (Aborted / no backend / OOM), tries `qwen3-0.6b` `q8` on `wasm`. Reports which combo it's *currently trying* via progress channel; sends `modelKey` in the `loaded` message so the HUD can reflect the actual model that loaded.
- Disabled transformers.js's built-in browser cache (`env.useBrowserCache = false`) — it was double-consuming response streams and causing Aborted.
- Disabled threaded WASM (`numThreads = 1`, `proxy = false`).
- `apply_chat_template` called with `enable_thinking: false` so Qwen3 doesn't emit a `<think>...</think>` reasoning preamble before the streaming reply.
- `sanitize()` regex strips any stray `<think>...</think>` blocks and the `<|im_start|>`/`<|im_end|>` chat sentinels.

### `tts-worker.js`
- Same `numThreads = 1` / `proxy = false` workaround. No model changes.

### `infer.js`
- `LLM_MODELS` only contains the Qwen3 entries.
- Forwards `modelKey` from the worker's `loaded` event so the UI can show the actually-loaded model.

### `sw.js`
- Cache key bumped to `anchor-v10` over the session (started at v3). Each bump documents what changed in the inline comment.
- **`withCOI()`** wrapper: injects `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: credentialless` on every same-origin response so the page becomes `crossOriginIsolated` (required for SharedArrayBuffer / threaded WASM).
- `SHELL` precaches `assets/face-bg.jpg` (the anime background).
- `app.js`'s `buildPrecacheList()` now also includes all VRMA files (the 7 pixiv pack + 5 rare dance clips).

### `styles.css`
- Added `.panel.viewport` background: a vertical darkening gradient over `assets/face-bg.jpg` (the torii/mountain scene). The VRM canvas already has `alpha: true` so the backdrop shows through naturally.

### `assets/vrma/` — animation library
| File | Source | Use |
|---|---|---|
| `VRMA_01..07.vrma` | pixiv VRoid Project (credit required) | intro + idle pool |
| `Readme_VRMA_MotionPack_EN.txt` | pixiv | terms — credit "Animation credits to pixiv Inc.'s VRoid Project" |
| `OtonaBlue.vrma` | user-provided pack | rare |
| `BabyYou.vrma` | user-provided pack | rare |
| `TocaToca.vrma` | user-provided pack | rare |
| `RareDance_3.vrma` | user-provided pack (Japanese name lost in zip encoding) | rare |
| `RareDance_5.vrma` | user-provided pack (Japanese name lost in zip encoding) | rare |

### `tools/unity-anim-to-vrma.mjs` — Unity converter (still useful)
Standalone Node script that converts a Unity humanoid `AnimationClip` (`.anim` YAML) into a `.vrma` file.
- Parses Mecanim muscle curves by name (Spine/Chest/Neck/Head/Arms/Hands/Legs/Feet).
- Applies Unity's default muscle min/max ranges to convert normalized `[-1,1]` muscle values into bone Euler rotations.
- Also handles `RootT` (root translation → hips position), `RootQ` (root rotation → hips rotation), and `LeftFootT/Q`/`RightFootT/Q`/`LeftHandT/Q`/`RightHandT/Q` (IK targets via two-bone analytic IK).
- Outputs a glTF binary with `VRMC_vrm_animation` extension and a proper humanoid bone hierarchy.
- **Quality:** approximate — without the source avatar's per-muscle calibration and `humanScale`, scale and extreme poses may differ. Was used to convert `LoliKamiRequiem.unitypackage` (subsequently removed in favor of the 5-clip VRMA pack).
- Usage: `node tools/unity-anim-to-vrma.mjs path/to/input.anim path/to/output.vrma`

### `tools/vrm-shot.mjs` — pre-existing smoke test
Sends a prompt and screenshots the face panel. Useful for verifying the LLM→TTS→face pipeline end-to-end.

---

## How to test things

```
# dev server (Python or any static server on :5173)
python -m http.server 5173

# smoke test: load page, send a prompt, screenshot face
node tools/vrm-shot.mjs

# convert any other Unity .anim
node tools/unity-anim-to-vrma.mjs source.anim assets/vrma/MyClip.vrma
```

In DevTools:
- `__face.status()` — rare-clip armed? countdown?
- `__face.playRare()` — fire a rare clip now
- `self.crossOriginIsolated` — should be `true`
- `await navigator.gpu?.requestAdapter()` — should return a `GPUAdapter`

If the LLM error returns: close the tab entirely (don't hard-refresh — Ctrl+Shift+R bypasses the SW) and reopen.

---

## Credits

- **VRoid model** — Zelená Terra / "Little Black Dress #6" by BEAMER3K (https://hub.vroid.com/en/characters/6508184899432541268/models/2853061186142051617)
- **VRMA Motion Pack (intro + idle)** — pixiv VRoid Project — credit phrase required: *"Animation credits to pixiv Inc.'s VRoid Project"*
- **Rare dance clips** — user-supplied (VRChat-community VRMA pack)
