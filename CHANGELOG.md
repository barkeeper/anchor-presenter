# Changelog

## 2026-05-31

- Combine 3 projects into 1: the Transformers.js browser chat ("test llm.html"), Kokoro TTS speech (tts.rocks engine), and the three.js WebGPU morph-targets face — so the LLM speaks its replies with an animated face that follows the spoken text.

- Add an online/offline slider at the top and a dark/light mode setting. Online loads models from the web; offline loads all models, files and LLMs from the project directory so it works 100% without internet when switched to offline.

- "now look at the full project and give me 10 improvements that would make it better, I will pick which ones to implement" — proposed 10 improvements.

- "do them all, report back when all are finished" — implemented all 10: streaming token→speech, phoneme viseme lip-sync, Whisper push-to-talk voice input, in-app offline cache button, PWA + service worker, WebGPU LLM with wasm fallback, heuristic emotion-matched face, live captions + conversation memory, cursor gaze + saccades + speaking head-turn, and a settings drawer (voice/rate/model/precision/device) + stop button + retry + CSP/SRI.

- "btw also kill the dev server on port 5173, and restart it with this project" — killed the existing node server on 5173 and restarted it serving this project.

- "When I chat to the model now ... it responds with [gibberish] ... it worked before" — fixed: the WebGPU backend ran int8 (q8) weights and emitted garbage. The LLM now uses q4f16 on WebGPU (q8 on wasm).

- "it takes a longgggg time before the text is being spoken ... and [the reply] is not what I would expect" — split inference into TWO parallel workers (LLM ‖ TTS) so the first sentence is synthesized while the model keeps generating: warm time-to-first-audio dropped to ~2.4s. Also anchored the tiny 135M model with few-shot examples + a stronger prompt + lower temperature so it stops confabulating a human persona. (For higher answer quality, switch to the 360M model in Settings.)

- "The face does not animate at all ... only at point 8 does the face move and the karaoke text show" / "it speaks everything up to point 8 fine, THEN the face starts talking" — fixed: on-device inference on the main thread was starving the render loop, so the face/captions only caught up at the end while audio played. Moved BOTH the LLM and Kokoro into a Web Worker (sharing one transformers instance) so the main thread stays free and the face animates in sync with speech. Also made the LLM default to CPU so the GPU stays dedicated to the 3D face.

- "can you also allow me to change the voice in settings?" — added a Voice selector to the Settings drawer, kept in sync with the viewport HUD selector and persisted.
