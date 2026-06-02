// ============================================================
// app.js — ANCHOR orchestrator.
// Heavy inference (LLM + Kokoro) runs in a Web Worker so the main thread stays
// free to render the face in sync with audio. This file wires the worker, the
// audio/face player, voice input, captions, persistence, settings, the service
// worker, and the WEB/LOCAL + theme controls.
// ============================================================
import { env } from '@huggingface/transformers';   // configured for the main-thread STT instance
import { createFace } from './face.js';
import { createSpeech } from './speech.js';
import { createInference, LLM_MODELS } from './infer.js';
import { createSTT } from './stt.js';
import { detectMood } from './emotion.js';
import { loadHistory, saveHistory, clearHistory } from './persist.js';

const CFG = window.__ANCHOR__;
const A = CFG.assets;
const TTS_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICES = [
  { id: 'af_heart', label: 'Heart · US ♀' }, { id: 'af_bella', label: 'Bella · US ♀' },
  { id: 'af_nicole', label: 'Nicole · US ♀' }, { id: 'am_michael', label: 'Michael · US ♂' },
  { id: 'am_fenrir', label: 'Fenrir · US ♂' }, { id: 'am_puck', label: 'Puck · US ♂' },
  { id: 'bf_emma', label: 'Emma · UK ♀' }, { id: 'bm_george', label: 'George · UK ♂' },
];
const DTYPE_FILE = { q8: 'model_quantized.onnx', q4f16: 'model_q4f16.onnx', fp16: 'model_fp16.onnx', fp32: 'model.onnx' };
const SYSTEM = {
  role: 'system',
  content: 'You are Anchor, a friendly AI assistant shown as an on-screen presenter. You are an AI: you have no job, boss, or personal life, so never invent personal stories or events. Answer the user\'s message directly and stay on topic. Reply in one or two short, plain spoken sentences (no markdown, lists, headings or emoji) so it sounds natural read aloud.',
};
// Few-shot exemplars anchor the tiny 135M model to concise, on-topic, no-persona replies.
const FEWSHOT = [
  { role: 'user', content: 'Hi, how are you?' },
  { role: 'assistant', content: "Hi! I'm doing well, thanks for asking. What can I help you with today?" },
  { role: 'user', content: 'What is the capital of France?' },
  { role: 'assistant', content: 'The capital of France is Paris.' },
  { role: 'user', content: 'Tell me a fun fact.' },
  { role: 'assistant', content: 'Honey never spoils — archaeologists have found pots of it in ancient tombs that are still edible.' },
];

const DEFAULT_MODEL = 'gemma-4-e2b';
const storedModel = localStorage.getItem('anchor.model');
const settings = {
  voice: localStorage.getItem('anchor.voice') || 'af_heart',
  speed: +(localStorage.getItem('anchor.speed') || 1),
  // migrate retired SmolLM2 keys → current default
  model: (storedModel && LLM_MODELS[storedModel]) ? storedModel : DEFAULT_MODEL,
  // q4f16 is the WebGPU sweet spot for sub-2B models; q8 falls back automatically on WASM
  dtype: localStorage.getItem('anchor.dtype') || 'q4f16',
  // default to WebGPU when nothing's been chosen yet (worker falls back to wasm if unavailable)
  device: (localStorage.getItem('anchor.device') === 'wasm') ? 'wasm' : 'webgpu',
  muted: localStorage.getItem('anchor.muted') === '1',
};
// write the resolved defaults back so the dropdowns stay in sync after a refresh
localStorage.setItem('anchor.model', settings.model);
localStorage.setItem('anchor.dtype', settings.dtype);
localStorage.setItem('anchor.device', settings.device);

// main-thread transformers env (used only by Whisper STT) — worker configures its own
env.allowLocalModels = CFG.mode === 'offline';
env.allowRemoteModels = CFG.mode === 'online';
if (CFG.mode === 'offline') env.localModelPath = A.modelBase;
env.backends.onnx.wasm.wasmPaths = A.wasm;
// single-threaded WASM works without SharedArrayBuffer / COOP+COEP — see llm-worker.js
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  led: $('led'), status: $('status'), banner: $('banner'), llmId: $('llmId'), ttsId: $('ttsId'), devTag: $('devTag'),
  chat: $('chat'), input: $('input'), send: $('send'), stopBtn: $('stopBtn'), micBtn: $('micBtn'), reset: $('reset'), preload: $('preload'),
  modeSwitch: $('modeSwitch'), themeBtn: $('themeBtn'), settingsBtn: $('settingsBtn'), installBtn: $('installBtn'), muteBtn: $('muteBtn'), danceBtn: $('danceBtn'),
  voice: $('voice'), voiceSel: $('voiceSel'), onair: $('onair'), onairTxt: $('onairTxt'), caption: $('caption'),
  faceCanvas: $('face'), faceFallback: $('faceFallback'), wave: $('wave'),
  overlay: $('overlay'), ring: $('ring'), ovTitle: $('ovTitle'), ovLine: $('ovLine'), ovPct: $('ovPct'), ovFile: $('ovFile'), ovBytes: $('ovBytes'), ovHint: $('ovHint'), ovCancel: $('ovCancel'),
  settingsPanel: $('settingsPanel'), speed: $('speed'), speedVal: $('speedVal'), modelSel: $('modelSel'), dtypeSel: $('dtypeSel'), deviceSel: $('deviceSel'),
  cacheBtn: $('cacheBtn'), cacheHint: $('cacheHint'), clearBtn: $('clearBtn'), srAnnouncer: $('srAnnouncer'),
};
const announce = (msg) => { if (el.srAnnouncer) el.srAnnouncer.textContent = msg; };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Auto-dismiss the notice banner ~15s after it's shown (or its text last changed), so a
// transient warning like "Download canceled…" doesn't stick around. Watching the element
// means every place that shows the banner gets this for free.
let bannerTimer = null;
const armBannerAutoHide = () => { clearTimeout(bannerTimer); if (!el.banner.hidden) bannerTimer = setTimeout(() => { el.banner.hidden = true; }, 15000); };
new MutationObserver(armBannerAutoHide).observe(el.banner, { attributes: true, attributeFilter: ['hidden'], childList: true, characterData: true, subtree: true });

el.ttsId.textContent = 'Kokoro-82M';
el.modeSwitch.dataset.mode = CFG.mode;
for (const v of VOICES) for (const sel of [el.voice, el.voiceSel]) { const o = document.createElement('option'); o.value = v.id; o.textContent = v.label; sel.appendChild(o); }
for (const k in LLM_MODELS) { if (LLM_MODELS[k].fallback) continue; const o = document.createElement('option'); o.value = k; o.textContent = LLM_MODELS[k].label; el.modelSel.appendChild(o); }
el.voice.value = el.voiceSel.value = settings.voice; el.speed.value = settings.speed; el.speedVal.textContent = settings.speed.toFixed(2) + '×';
el.modelSel.value = settings.model; el.dtypeSel.value = settings.dtype; el.deviceSel.value = settings.device;
el.llmId.textContent = LLM_MODELS[settings.model].id.split('/').pop();

if (CFG.requestedOffline && CFG.offlineMissing) {
  el.banner.hidden = false;
  el.banner.innerHTML = 'Offline assets not found — staying on <b>WEB</b>. Run <code>powershell -File tools/fetch-offline.ps1</code> for LOCAL mode.';
}

// ---------- state ----------
let busy = false, face = null, recording = false, deferredPrompt = null;
let pending = null;   // { bubble, userText, first, moodLen } — LLM generation lifecycle
let reveal = null;    // { bubble, first, full } — chat bubble revealed in lockstep with speech
let danceAudio = null, danceTimer = null;   // dance music player (declared early — applyMute uses it)
let history = loadHistory();

// ---------- progress overlay ----------
const fmtBytes = (n) => { if (!Number.isFinite(n) || n <= 0) return '0 B'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0, v = n; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`; };
const fileMap = new Map();
const agg = () => { let l = 0, t = 0, n = 0; for (const v of fileMap.values()) { n++; l += v.loaded || 0; if (v.total > 0) t += v.total; } return { l, t, n }; };
const resetProgress = () => { fileMap.clear(); lastPct = 0; };

// ---- download stall watchdog: if no progress for STALL_MS, tell the user (instead of a
// frozen-looking overlay) and offer to cancel a stuck download. ----
const STALL_MS = 20000;
const OV_HINT_DEFAULT = 'First run downloads model weights and caches them in the browser.';
let lastProgressAt = 0, stallTimer = null, downloading = false;
function markProgress() { lastProgressAt = performance.now(); if (downloading) { el.ovHint.textContent = OV_HINT_DEFAULT; el.ovCancel.hidden = true; } }
function startStallWatch() {
  downloading = true; markProgress();
  if (stallTimer) return;
  stallTimer = setInterval(() => {
    if (downloading && performance.now() - lastProgressAt > STALL_MS) {
      el.ovHint.textContent = 'This is taking longer than expected — your connection may be slow or interrupted. It will keep trying.';
      el.ovCancel.hidden = false;
    }
  }, 3000);
}
function stopStallWatch() { downloading = false; if (stallTimer) { clearInterval(stallTimer); stallTimer = null; } el.ovCancel.hidden = true; el.ovHint.textContent = OV_HINT_DEFAULT; }

let lastPct = 0, lastPaint = 0;
const showOverlay = (on) => { el.overlay.classList.toggle('show', !!on); el.overlay.setAttribute('aria-hidden', on ? 'false' : 'true'); if (!on) { stopStallWatch(); lastPct = 0; } };
// explicit painter — used by the offline-cache flow, which supplies its own numbers
function setProgress(pct, line, file, loaded, total) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  el.ring.style.setProperty('--p', `${p}%`); $('barFill').style.setProperty('--w', `${p}%`); el.ovPct.textContent = `${p}%`;
  if (line) el.ovLine.textContent = line; if (file) el.ovFile.textContent = file;
  el.ovBytes.textContent = (Number.isFinite(loaded) && total > 0) ? `${fmtBytes(loaded)} / ${fmtBytes(total)}` : '—';
}
// Throttled, AGGREGATE, MONOTONIC painter for model downloads. The model arrives as many
// concurrent shards; painting each file's name/bytes on every event made the popup flicker
// and the % jump backward. Instead show one steady total, repainted at most ~8×/sec.
function paintProgress(force) {
  const now = performance.now();
  if (!force && now - lastPaint < 120) return;
  lastPaint = now;
  const { l, t, n } = agg();
  let pct = t > 0 ? (l / t) * 100 : lastPct;
  pct = Math.max(lastPct, Math.min(100, pct)); // never jump backward as new shards register
  lastPct = pct;
  const p = Math.round(pct);
  el.ring.style.setProperty('--p', `${p}%`); $('barFill').style.setProperty('--w', `${p}%`); el.ovPct.textContent = `${p}%`;
  el.ovLine.textContent = 'downloading model weights…';
  el.ovFile.textContent = `${n} file${n === 1 ? '' : 's'}`;
  el.ovBytes.textContent = t > 0 ? `${fmtBytes(l)} / ${fmtBytes(t)}` : fmtBytes(l);
}
function progress(title, info) {
  const st = info?.status, file = info?.file || '';
  if (st === 'initiate' || st === 'download') {
    if (file && !fileMap.has(file)) fileMap.set(file, { loaded: 0, total: 0 });
    el.ovTitle.textContent = `loading ${title}…`; showOverlay(true); startStallWatch(); setLED('busy'); setStatus('downloading'); paintProgress();
  } else if (st === 'progress') {
    if (file) fileMap.set(file, { loaded: info.loaded, total: info.total });
    el.ovTitle.textContent = `loading ${title}…`; showOverlay(true); startStallWatch(); markProgress(); setLED('busy'); setStatus('downloading'); paintProgress();
  } else if (st === 'done') {
    markProgress();
    if (file && fileMap.has(file)) { const v = fileMap.get(file); fileMap.set(file, { loaded: v.total || v.loaded, total: v.total || v.loaded }); }
    paintProgress(true);
  } else if (st === 'ready') {
    stopStallWatch(); lastPct = 100;
    el.ovPct.textContent = '100%'; el.ring.style.setProperty('--p', '100%'); $('barFill').style.setProperty('--w', '100%');
    el.ovLine.textContent = 'ready'; el.ovFile.textContent = ''; el.ovBytes.textContent = '';
    setTimeout(() => showOverlay(false), 220);
  }
}
const makeProgress = (title) => (info) => progress(title, info);   // for stt.js

// ---------- UI helpers ----------
const setLED = (m) => { el.led.className = 'led' + (m ? ' ' + m : ''); };
const setStatus = (t) => { el.status.textContent = t; };
const scrollBottom = () => { el.chat.scrollTop = el.chat.scrollHeight; };
function setOnAir(mode) {
  el.onair.classList.remove('live', 'think');
  if (mode === 'live') { el.onair.classList.add('live'); el.onairTxt.textContent = 'ON AIR'; }
  else if (mode === 'think') { el.onair.classList.add('think'); el.onairTxt.textContent = 'THINKING'; }
  else el.onairTxt.textContent = 'STANDBY';
}
function addMsg(role, content) {
  const row = document.createElement('div'); row.className = `msg ${role}`;
  const who = document.createElement('div'); who.className = 'msg__role'; who.textContent = role === 'assistant' ? 'AI' : role === 'user' ? 'YOU' : 'SYS';
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  if (content instanceof Node) bubble.appendChild(content); else bubble.textContent = content;
  row.append(who, bubble); el.chat.appendChild(row); scrollBottom(); return bubble;
}
const typingNode = () => { const s = document.createElement('span'); s.className = 'typing'; s.innerHTML = '<span></span><span></span><span></span>'; return s; };
function renderError(bubble, lastText, e) {
  bubble.innerHTML = ''; bubble.append('Error: ' + (e ?? 'unknown') + ' ');
  const r = document.createElement('button'); r.className = 'btn btn--ghost btn--tiny'; r.textContent = 'retry';
  r.onclick = () => { bubble.closest('.msg').remove(); sendMessage(lastText); };
  bubble.append(r);
}
function restoreChat() {
  el.chat.innerHTML = '';
  if (!history.length) addMsg('system', `Local in-browser presenter · ${CFG.mode.toUpperCase()} mode. Type or hit 🎙 — first run downloads & caches the models.`);
  else for (const m of history) addMsg(m.role, m.content);
}
// Keep as many whole recent turns as fit a character budget (a rough token proxy), instead
// of a blunt fixed window — long chats stay coherent without overflowing the small model.
const HISTORY_CHAR_BUDGET = 6000;
function getMessages() {
  const recent = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const len = (history[i].content || '').length + 8; // +8 ≈ role/format overhead per turn
    if (recent.length && used + len > HISTORY_CHAR_BUDGET) break;
    recent.unshift(history[i]); used += len;
  }
  return [SYSTEM, ...FEWSHOT, ...recent];
}
function updateDevTag(device, dtype) { el.devTag.hidden = false; el.devTag.textContent = dtype ? `${device} ${dtype}` : device; }
function updateLoadedModelHud(modelKey, device) {
  if (!modelKey || !LLM_MODELS[modelKey]) return;
  el.llmId.textContent = LLM_MODELS[modelKey].id.split('/').pop();
  // when the worker had to fall back from the user's selection, show a small notice that
  // is honest about WHERE it's running (GPU vs CPU) — the 0.6B label says "CPU-friendly"
  // but it may well be on the GPU.
  if (modelKey !== settings.model) {
    const where = device === 'webgpu' ? 'your GPU (WebGPU)' : 'CPU';
    el.banner.hidden = false;
    el.banner.innerHTML = `<b>${LLM_MODELS[settings.model].label}</b> didn’t fit; running <b>${LLM_MODELS[modelKey].label}</b> on <b>${where}</b> instead.`;
  } else {
    el.banner.hidden = true;   // requested model loaded — clear any prior fallback notice
  }
}

// ---------- modules ----------
const speech = createSpeech({ face: null, onCaption, onState, onSpoken });
speech.setMuted(settings.muted);
// debug hooks for the sync test (lip-sync / caption / audio vs. chat text)
window.__diag = {
  speaking: () => speech.speaking,
  audioRMS: () => { try { const a = speech.analyser, buf = new Float32Array(a.fftSize); a.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); } catch { return 0; } },
  caption: () => ({ text: el.caption.textContent || '', active: el.caption.querySelector('.now')?.textContent || '' }),
  bubble: () => { const b = [...document.querySelectorAll('.msg.assistant .bubble')].pop(); return b?.textContent || ''; },
  fullReply: () => reveal?.full || '',
  dance: () => danceAudio ? { src: danceAudio.src, paused: danceAudio.paused, volume: danceAudio.volume, muted: danceAudio.muted } : null,
  muted: () => settings.muted,
};
const stt = createSTT({ assets: A, offline: CFG.mode === 'offline', onProgress: makeProgress('speech recognizer') });
const PROG_TITLE = { llm: 'language model', tts: 'voice model' };
const inference = createInference({
  assets: A, offline: CFG.mode === 'offline',
  onProgress: (phase, info) => progress(PROG_TITLE[phase] || 'model', info),
  onLoaded: (device, dtype, modelKey) => { updateDevTag(device, dtype); updateLoadedModelHud(modelKey, device); },
  onEnv: (e) => { window.__llmEnv = e; },   // env details available via window.__llmEnv (no console noise)
  onToken: (clean) => {
    if (!pending) return;
    // Accumulate the reply but DON'T dump it into the bubble — the bubble is revealed by
    // onSpoken in sync with the voice (the LLM races far ahead of the TTS otherwise).
    if (reveal) reveal.full = clean;
    const grew = clean.length - pending.moodLen;
    if ((grew > 16 && /[.!?](\s|$)/.test(clean.slice(-2))) || grew > 100) { const m = detectMood(clean); face?.setMood(m.mood, m.intensity); pending.moodLen = clean.length; }
  },
  onAudio: (chunk) => speech.enqueue(chunk),
  onSpeechEnd: () => { speech.end(); },
  onDone: (reply) => {
    if (!pending) return;
    if (reveal) reveal.full = reply;
    announce('Anchor said: ' + reply); history.push({ role: 'assistant', content: reply }); saveHistory(history);
    const m = detectMood(reply); face?.setMood(m.mood, m.intensity);
    setStatus('ready'); setLED('ready'); setBusy(false); pending = null;
    // If nothing is being spoken (TTS off/failed), show the full reply now; otherwise let the
    // speech-synced reveal play out and finalize in onState('idle').
    if (reveal && !speech.speaking) { reveal.bubble.textContent = reply; reveal = null; }
  },
  onError: (errMsg) => { console.error('infer:', errMsg); if (pending) { renderError(pending.bubble, pending.userText, errMsg); pending = null; } else { setStatus('error'); } reveal = null; speech.cancel(); setOnAir('idle'); setLED('err'); setBusy(false); showOverlay(false); },
});

// Reveal the chat bubble word-by-word as the voice speaks them (keeps text + audio + face in sync).
function onSpoken(text) {
  if (!reveal || !text) return;
  if (reveal.first) { reveal.bubble.textContent = ''; reveal.first = false; }
  reveal.bubble.textContent = text; scrollBottom();
}

function onState(state) {
  if (state === 'speaking') { setOnAir('live'); el.stopBtn.hidden = false; }
  else {
    setOnAir('idle'); el.stopBtn.hidden = true; el.caption.classList.remove('show');
    // speech finished (or was cancelled) — make sure the full reply is shown.
    if (reveal) { reveal.bubble.textContent = reveal.full; reveal = null; }
  }
}
function onCaption(text, wi) {
  if (!text) { el.caption.classList.remove('show'); el.caption.innerHTML = ''; return; }
  el.caption.classList.add('show');
  el.caption.innerHTML = text.split(/\s+/).map((w, i) => `<span class="${i < wi ? 'said' : i === wi ? 'now' : ''}">${esc(w)}</span>`).join(' ');
}

// kokoro fetches voice .bin from a fixed HF URL via the "kokoro-voices" Cache.
// In LOCAL mode, seed that cache (shared with the worker) from the on-disk voices.
async function maybeSeedVoices() {
  if (CFG.mode !== 'offline' || !('caches' in window)) return;
  try {
    const cache = await caches.open('kokoro-voices');
    for (const v of VOICES) {
      const url = `https://huggingface.co/${TTS_ID}/resolve/main/voices/${v.id}.bin`;
      if (await cache.match(url)) continue;
      const r = await fetch(`${A.modelBase}${TTS_ID}/voices/${v.id}.bin`);
      if (r.ok) await cache.put(url, new Response(await r.arrayBuffer(), { headers: { 'content-type': 'application/octet-stream' } }));
    }
  } catch (e) { console.warn('voice seed failed', e); }
}

// ---------- the main loop ----------
// Note: the mic stays enabled while busy so the user can barge in (interrupt) the avatar.
function setBusy(on) { busy = !!on; el.send.disabled = busy || !el.input.value.trim(); el.reset.disabled = busy; el.preload.disabled = busy; }

async function sendMessage(raw) {
  const text = (raw ?? '').trim();
  if (!text || busy) return;
  stopDanceMusic(); speech.cancel(); inference.cancel(); setOnAir('idle'); setBusy(true);
  addMsg('user', text); history.push({ role: 'user', content: text }); saveHistory(history);
  const bubble = addMsg('assistant', typingNode());
  setOnAir('think'); setStatus('thinking'); setLED('busy');
  pending = { bubble, userText: text, first: true, moodLen: 0 };
  reveal = { bubble, first: true, full: '' };
  resetProgress();
  await maybeSeedVoices();
  await inference.ready;
  speech.begin();
  inference.generate({ messages: getMessages(), opts: { modelKey: settings.model, dtype: settings.dtype, device: settings.device, maxTokens: 160 }, ttsId: TTS_ID, voice: settings.voice, speed: settings.speed });
}

// ---------- waveform ----------
const waveCtx = el.wave.getContext('2d');
const freqBuf = new Uint8Array(speech.analyser.frequencyBinCount);
function drawWave() {
  requestAnimationFrame(drawWave);
  const c = el.wave, dpr = Math.min(window.devicePixelRatio, 2), w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
  waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0); waveCtx.clearRect(0, 0, w, h);
  speech.analyser.getByteFrequencyData(freqBuf);
  const css = getComputedStyle(document.documentElement);
  const amber = css.getPropertyValue('--amber').trim() || '#f0a93b', teal = css.getPropertyValue('--teal').trim() || '#46d6c0';
  const bars = 48, step = Math.floor(freqBuf.length / bars), bw = w / bars;
  for (let i = 0; i < bars; i++) { const v = freqBuf[i * step] / 255, bh = Math.max(2, v * h); waveCtx.fillStyle = i % 2 ? teal : amber; waveCtx.globalAlpha = 0.3 + v * 0.7; waveCtx.fillRect(i * bw + 1, h - bh, bw - 2, bh); }
  waveCtx.globalAlpha = 1;
}

// ---------- voice input (hold-to-talk + click-to-toggle + barge-in) ----------
// micState: 'idle' → 'starting' (async getUserMedia/model) → 'on' → back to 'idle'.
// releaseWanted handles a hold that's released before recording has finished starting.
let micState = 'idle', releaseWanted = false, micPressAt = 0;

async function micStart() {
  if (micState !== 'idle') return;
  // barge-in: cut off whatever the avatar is currently generating/saying.
  stopDanceMusic(); speech.cancel(); inference.cancel(); setOnAir('idle'); pending = null; setBusy(false);
  micState = 'starting'; releaseWanted = false;
  try { stt.ensure(); await stt.startRecording(); }
  catch (e) {
    console.error(e); micState = 'idle'; el.micBtn.classList.remove('rec');
    el.banner.hidden = false; el.banner.textContent = 'Microphone unavailable or permission denied.';
    setStatus('idle'); setLED(''); return;
  }
  micState = 'on'; recording = true; el.micBtn.classList.add('rec'); setStatus('listening'); setLED('busy');
  if (releaseWanted) micStop();                 // released during 'starting' → stop now
}
async function micStop() {
  if (micState === 'starting') { releaseWanted = true; return; }
  if (micState !== 'on') return;
  micState = 'idle'; recording = false; el.micBtn.classList.remove('rec'); setStatus('transcribing'); setLED('busy');
  try {
    const t = await stt.stopAndTranscribe();
    if (t) { setStatus('ready'); setLED('ready'); sendMessage(t); }
    else { setStatus('idle'); setLED(''); }     // empty/non-speech/hallucination → quietly ignore
  } catch (e) { console.error(e); setStatus('stt error'); setLED('err'); }
}
// A press while recording stops it (toggle off). Otherwise start; on release, a long
// hold ends it (push-to-talk) while a quick tap leaves it on (click-to-toggle).
function micPressStart() { if (micState === 'on' || micState === 'starting') { micPressAt = 0; micStop(); return; } micPressAt = performance.now(); micStart(); }
function micPressEnd() { if (!micPressAt) return; const held = performance.now() - micPressAt; micPressAt = 0; if (held >= 400) micStop(); /* else: quick tap → stays on as a toggle */ }

// ---------- offline caching (service worker) ----------
function llmFileList() {
  const files = ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'vocab.json', 'merges.txt'];
  const out = [];
  for (const key of Object.keys(LLM_MODELS)) {
    const id = LLM_MODELS[key].id, base = `https://huggingface.co/${id}/resolve/main/`;
    // small model gets q8 (the WASM-safe fallback); user-selected model gets their dtype
    const dtypeFile = (key === settings.model) ? (DTYPE_FILE[settings.dtype] || DTYPE_FILE.q8) : DTYPE_FILE.q8;
    out.push(...files.map((f) => base + f), base + 'onnx/' + dtypeFile);
  }
  return out;
}
async function buildPrecacheList() {
  // app-shell list is shared with the service worker via shell-files.json (single source).
  let shell = ['./', './index.html', './app.js', './styles.css', './manifest.webmanifest'];
  try { const r = await fetch('./shell-files.json', { cache: 'no-store' }); if (r.ok) shell = await r.json(); } catch {}
  const core = CFG.mode === 'online' ? 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.core.js' : './vendor/three/build/three.core.js';
  const libs = [A.three, core, A.vrm, A.vrmAnim, A.transformers, A.kokoro, A.phonemizer, A.face,
    A.addons + 'environments/RoomEnvironment.js', A.addons + 'loaders/GLTFLoader.js', A.addons + 'loaders/KTX2Loader.js',
    A.addons + 'libs/ktx-parse.module.js', A.addons + 'libs/zstddec.module.js', A.addons + 'libs/meshopt_decoder.module.js',
    A.addons + 'math/ColorSpaces.js', A.addons + 'utils/BufferGeometryUtils.js', A.addons + 'utils/WorkerPool.js',
    A.basis + 'basis_transcoder.js', A.basis + 'basis_transcoder.wasm', A.wasm + 'ort-wasm-simd-threaded.jsep.wasm', A.wasm + 'ort-wasm-simd-threaded.jsep.mjs'];
  const tts = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx', ...VOICES.map((v) => `voices/${v.id}.bin`)].map((f) => `https://huggingface.co/${TTS_ID}/resolve/main/${f}`);
  const whisper = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/encoder_model.onnx', 'onnx/decoder_model_merged.onnx'].map((f) => `https://huggingface.co/onnx-community/whisper-tiny.en/resolve/main/${f}`);
  return [...shell, ...libs, ...llmFileList(), ...tts, ...whisper].filter((u, i, a) => u && a.indexOf(u) === i);
}
async function cacheForOffline() {
  el.cacheBtn.disabled = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    const urls = await buildPrecacheList();
    fileMap.clear(); showOverlay(true); el.ovTitle.textContent = 'caching for offline…'; el.ovHint.textContent = 'Downloading libraries + current models into the browser cache.'; setProgress(0, 'starting', `${urls.length} files`);
    const onMsg = (e) => {
      const d = e.data || {};
      if (d.type === 'precache-progress') setProgress((d.done / d.total) * 100, `cached ${d.done}/${d.total}`, d.url?.split('/').slice(-1)[0] || '');
      else if (d.type === 'precache-done') { setProgress(100, `cached ${d.ok}/${d.total} files`, ''); setTimeout(() => showOverlay(false), 600); navigator.serviceWorker.removeEventListener('message', onMsg); el.cacheBtn.disabled = false; el.cacheBtn.textContent = 'Cached ✓ — works offline'; }
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: 'precache', urls });
  } catch (e) { console.error(e); showOverlay(false); el.cacheBtn.disabled = false; el.cacheHint.textContent = 'Caching failed: ' + e.message; }
}

// ---------- mode / theme / settings ----------
function switchMode(target) {
  if (target === CFG.mode) return;
  if (target === 'offline') {
    fetch('./vendor/transformers/transformers.min.js', { method: 'HEAD', cache: 'no-store' })
      .then((r) => { if (r.ok) { localStorage.setItem('anchor.mode', 'offline'); location.reload(); } else throw new Error('missing'); })
      .catch(() => { el.banner.hidden = false; el.banner.innerHTML = 'LOCAL assets not downloaded. Run <code>powershell -File tools/fetch-offline.ps1</code> first, or use “Cache everything for offline” to keep WEB mode working offline.'; });
  } else { localStorage.setItem('anchor.mode', 'online'); location.reload(); }
}
const openSettings = (on) => { el.settingsPanel.classList.toggle('open', on); el.settingsPanel.setAttribute('aria-hidden', on ? 'false' : 'true'); };

// ---------- events ----------
el.input.addEventListener('input', () => { el.send.disabled = busy || !el.input.value.trim(); });
el.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const t = el.input.value; el.input.value = ''; el.send.disabled = true; sendMessage(t); } });
el.send.addEventListener('click', () => { const t = el.input.value; el.input.value = ''; el.send.disabled = true; sendMessage(t); });
el.stopBtn.addEventListener('click', () => { stopDanceMusic(); speech.cancel(); inference.cancel(); setOnAir('idle'); });
el.micBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); micPressStart(); });
el.micBtn.addEventListener('pointerup', (e) => { e.preventDefault(); micPressEnd(); });
el.micBtn.addEventListener('pointerleave', () => { if (micPressAt) micPressEnd(); });
el.micBtn.addEventListener('pointercancel', () => { if (micPressAt) micPressEnd(); });
// Spacebar = pure push-to-talk (hold to speak), but only when not typing in the composer.
let spaceHeld = false;
window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !spaceHeld && !e.repeat && document.activeElement !== el.input) { spaceHeld = true; e.preventDefault(); micStart(); } });
window.addEventListener('keyup', (e) => { if (e.code === 'Space' && spaceHeld) { spaceHeld = false; e.preventDefault(); micStop(); } });
el.preload.addEventListener('click', async () => { if (busy) return; resetProgress(); await inference.ready; inference.load({ opts: { modelKey: settings.model, dtype: settings.dtype, device: settings.device }, ttsId: TTS_ID }); });
el.reset.addEventListener('click', () => { if (busy) return; stopDanceMusic(); speech.cancel(); inference.cancel(); setOnAir('idle'); history = []; clearHistory(); restoreChat(); el.send.disabled = !el.input.value.trim(); });

const setVoice = (v) => { settings.voice = v; localStorage.setItem('anchor.voice', v); el.voice.value = v; el.voiceSel.value = v; };
el.voice.addEventListener('change', () => setVoice(el.voice.value));
el.voiceSel.addEventListener('change', () => setVoice(el.voiceSel.value));
el.speed.addEventListener('input', () => { settings.speed = +el.speed.value; el.speedVal.textContent = settings.speed.toFixed(2) + '×'; localStorage.setItem('anchor.speed', settings.speed); });
el.modelSel.addEventListener('change', () => { settings.model = el.modelSel.value; localStorage.setItem('anchor.model', settings.model); el.llmId.textContent = LLM_MODELS[settings.model].id.split('/').pop(); });
el.dtypeSel.addEventListener('change', () => { settings.dtype = el.dtypeSel.value; localStorage.setItem('anchor.dtype', settings.dtype); });
el.deviceSel.addEventListener('change', () => { settings.device = el.deviceSel.value; localStorage.setItem('anchor.device', settings.device); });
el.cacheBtn.addEventListener('click', cacheForOffline);
el.clearBtn.addEventListener('click', () => { history = []; clearHistory(); restoreChat(); });

// Mute applies to BOTH the presenter voice and the dance music, and swaps the speaker icon.
function applyMute() {
  speech.setMuted(settings.muted);
  if (danceAudio) danceAudio.muted = settings.muted;
  el.muteBtn.querySelector('.muteglyph').textContent = settings.muted ? 'volume_off' : 'volume_up';
}
el.muteBtn.addEventListener('click', () => { settings.muted = !settings.muted; localStorage.setItem('anchor.muted', settings.muted ? '1' : '0'); applyMute(); });
applyMute();
// ---------- dance + music (✦ button) ----------
// Each rare dance has a matching track in ./music/<ClipName>.mp3. Pressing ✦ plays a dance
// AND its song together; the music plays only on this button (not the idle auto-dances).
const DANCE_MUSIC_DELAY_MS = 1200; // let the dance get moving before the track kicks in
const DANCE_MUSIC_VOLUME = 0.6;    // 60%
function stopDanceMusic() {
  if (danceTimer) { clearTimeout(danceTimer); danceTimer = null; }
  if (danceAudio) { try { danceAudio.pause(); danceAudio.src = ''; } catch {} danceAudio = null; }
}
function playDance() {
  const clip = face?.playRare?.();   // returns the clip name, e.g. "BabyYou", or null
  if (!clip) { el.banner.hidden = false; el.banner.textContent = 'Dance clips are still loading or unavailable.'; return; }
  stopDanceMusic();
  speech.cancel();                   // don't let the song overlap the avatar's voice
  danceTimer = setTimeout(() => {
    danceTimer = null;
    danceAudio = new Audio(`./music/${encodeURIComponent(clip)}.mp3`);
    danceAudio.volume = DANCE_MUSIC_VOLUME;
    danceAudio.muted = settings.muted;   // respect the mute toggle
    danceAudio.play().catch((e) => console.warn('dance music failed:', e?.message || e));
  }, DANCE_MUSIC_DELAY_MS);
}
el.danceBtn.addEventListener('click', playDance);
el.ovCancel.addEventListener('click', () => { inference.reset(); showOverlay(false); speech.cancel(); setOnAir('idle'); pending = null; setBusy(false); setStatus('idle'); setLED(''); el.banner.hidden = false; el.banner.textContent = 'Download canceled. Press send to try again.'; });
const updateThemeIcon = () => { el.themeBtn.querySelector('.material-symbols-outlined').textContent = document.documentElement.getAttribute('data-theme') === 'light' ? 'light_mode' : 'dark_mode'; };
el.themeBtn.addEventListener('click', () => { const n = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', n); localStorage.setItem('anchor.theme', n); updateThemeIcon(); });
updateThemeIcon();
el.settingsBtn.addEventListener('click', () => openSettings(!el.settingsPanel.classList.contains('open')));
el.settingsPanel.querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', () => openSettings(false)));
el.modeSwitch.addEventListener('click', () => switchMode(CFG.mode === 'online' ? 'offline' : 'online'));
el.modeSwitch.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.modeSwitch.click(); } });

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; el.installBtn.hidden = false; });
el.installBtn.addEventListener('click', async () => { if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; el.installBtn.hidden = true; } });
window.addEventListener('resize', () => face?.resize());
el.faceCanvas.addEventListener('pointermove', (e) => { const r = el.faceCanvas.getBoundingClientRect(); face?.setGazeTarget(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1)); });
el.faceCanvas.addEventListener('pointerleave', () => face?.setGazeTarget(0, 0));

// ---------- environment probe ----------
// Qwen3 uses GroupQueryAttention which transformers.js v3.x can only run on WebGPU.
// We pre-flight WebGPU on the main thread (where it's reliably exposed) and warn the
// user if WebGPU truly isn't available — otherwise the LLM worker would just abort
// later with the cryptic "Aborted()" message.
(async () => {
  const coi = self.crossOriginIsolated;
  let gpuOk = false, gpuReason = '';
  if (!navigator.gpu) { gpuReason = 'navigator.gpu missing — needs Chrome/Edge 113+, Firefox 141+, or Safari 26+'; }
  else {
    try { const a = await navigator.gpu.requestAdapter(); gpuOk = !!a; if (!a) gpuReason = 'requestAdapter() returned null — GPU may be disabled (chrome://gpu) or in a denylist'; }
    catch (e) { gpuReason = 'requestAdapter() threw: ' + (e?.message || e); }
  }
  if (settings.device === 'webgpu' && !gpuOk) {
    el.banner.hidden = false;
    el.banner.innerHTML = `WebGPU isn't available on this device, so <b>${LLM_MODELS[settings.model].label}</b> can't run on the GPU. Falling back to the small CPU model (<b>${LLM_MODELS['qwen3-0.6b'].label}</b>) — chat & voice still work, just smaller and slower. <br><small>Reason: ${gpuReason}.</small>`;
  } else if (!coi) {
    // The auto-reload in index.html should have caught this on first navigation. If
    // we're still here without COI, headers genuinely aren't applying — most likely
    // the SW is being bypassed (some extensions / DevTools "Bypass for network").
    el.banner.hidden = false;
    el.banner.innerHTML = `Page isn't cross-origin isolated, so the LLM can't use SharedArrayBuffer. <br><small>Try: close this tab and open it again (don't hard-refresh — Chrome bypasses the service worker on Ctrl+Shift+R). If DevTools is open, uncheck <b>Application → Service Workers → Bypass for network</b>.</small>`;
  }
})();

// ---------- boot ----------
restoreChat(); setStatus('idle'); setLED(''); setBusy(false); el.input.focus(); drawWave(); maybeSeedVoices();
(async () => {
  try { face = await createFace({ canvas: el.faceCanvas, modelUrl: A.face, basisPath: A.basis }); speech.setFace(face); }
  catch (e) { console.error('Face init failed:', e); el.faceFallback.hidden = false; el.faceFallback.innerHTML = 'The animated face needs WebGPU (or WebGL2).<br/>Chat & voice still work — try a recent Chrome/Edge.'; }
})();
