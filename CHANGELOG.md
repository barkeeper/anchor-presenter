# Changelog

## 2026-05-31

- Combine 3 projects into 1: the Transformers.js browser chat ("test llm.html"), Kokoro TTS speech (tts.rocks engine), and the three.js WebGPU morph-targets face — so the LLM speaks its replies with an animated face that follows the spoken text.

- Add an online/offline slider at the top and a dark/light mode setting. Online loads models from the web; offline loads all models, files and LLMs from the project directory so it works 100% without internet when switched to offline.

- "now look at the full project and give me 10 improvements that would make it better, I will pick which ones to implement" — proposed 10 improvements.

- "do them all, report back when all are finished" — implemented all 10: streaming token→speech, phoneme viseme lip-sync, Whisper push-to-talk voice input, in-app offline cache button, PWA + service worker, WebGPU LLM with wasm fallback, heuristic emotion-matched face, live captions + conversation memory, cursor gaze + saccades + speaking head-turn, and a settings drawer (voice/rate/model/precision/device) + stop button + retry + CSP/SRI.

- "btw also kill the dev server on port 5173, and restart it with this project" — killed the existing node server on 5173 and restarted it serving this project.
