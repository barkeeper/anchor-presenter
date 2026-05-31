// ============================================================
// app.js — ANCHOR orchestrator.
// Wires: LLM (streaming) → Kokoro streaming voice → viseme/emotion face,
// plus voice input (Whisper), captions, persistence, settings, a service
// worker for offline caching, and the WEB/LOCAL + theme controls.
// ============================================================
import { KokoroTTS } from 'kokoro-js';
import { createFace } from './face.js';
import { createSpeech } from './speech.js';
import { createLLM, LLM_MODELS, env } from './llm.js';
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
const DTYPE_FILE = { q8: 'model_quantized.onnx', fp16: 'model_fp16.onnx', q4f16: 'model_q4f16.onnx', fp32: 'model.onnx' };
const SYSTEM = {
  role: 'system',
  content: 'You are Anchor, a warm, concise on-screen presenter. Reply in plain spoken sentences (no markdown, lists or emoji) so your words sound natural read aloud. Keep answers brief unless asked for detail.',
};

const settings = {
  voice: localStorage.getItem('anchor.voice') || 'af_heart',
  speed: +(localStorage.getItem('anchor.speed') || 1),
  model: localStorage.getItem('anchor.model') || '135m',
  dtype: localStorage.getItem('anchor.dtype') || 'q8',
  device: localStorage.getItem('anchor.device') || 'auto',
  muted: localStorage.getItem('anchor.muted') === '1',
};

// transformers env — one place decides web vs local
env.allowLocalModels = CFG.mode === 'offline';
env.allowRemoteModels = CFG.mode === 'online';
if (CFG.mode === 'offline') env.localModelPath = A.modelBase;
env.backends.onnx.wasm.wasmPaths = A.wasm;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  led: $('led'), status: $('status'), banner: $('banner'), llmId: $('llmId'), ttsId: $('ttsId'), devTag: $('devTag'),
  chat: $('chat'), input: $('input'), send: $('send'), stopBtn: $('stopBtn'), micBtn: $('micBtn'), reset: $('reset'), preload: $('preload'),
  modeSwitch: $('modeSwitch'), themeBtn: $('themeBtn'), settingsBtn: $('settingsBtn'), installBtn: $('installBtn'), muteBtn: $('muteBtn'),
  voice: $('voice'), onair: $('onair'), onairTxt: $('onairTxt'), caption: $('caption'),
  faceCanvas: $('face'), faceFallback: $('faceFallback'), wave: $('wave'),
  overlay: $('overlay'), ring: $('ring'), ovTitle: $('ovTitle'), ovLine: $('ovLine'), ovPct: $('ovPct'), ovFile: $('ovFile'), ovBytes: $('ovBytes'), ovHint: $('ovHint'),
  settingsPanel: $('settingsPanel'), speed: $('speed'), speedVal: $('speedVal'), modelSel: $('modelSel'), dtypeSel: $('dtypeSel'), deviceSel: $('deviceSel'),
  cacheBtn: $('cacheBtn'), cacheHint: $('cacheHint'), clearBtn: $('clearBtn'),
};
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

el.ttsId.textContent = 'Kokoro-82M';
el.modeSwitch.dataset.mode = CFG.mode;
for (const v of VOICES) { const o = document.createElement('option'); o.value = v.id; o.textContent = v.label; el.voice.appendChild(o); }
for (const k in LLM_MODELS) { const o = document.createElement('option'); o.value = k; o.textContent = LLM_MODELS[k].label; el.modelSel.appendChild(o); }
el.voice.value = settings.voice; el.speed.value = settings.speed; el.speedVal.textContent = settings.speed.toFixed(2) + '×';
el.modelSel.value = settings.model; el.dtypeSel.value = settings.dtype; el.deviceSel.value = settings.device;
el.llmId.textContent = LLM_MODELS[settings.model].id.split('/').pop();

if (CFG.requestedOffline && CFG.offlineMissing) {
  el.banner.hidden = false;
  el.banner.innerHTML = 'Offline assets not found — staying on <b>WEB</b>. Run <code>powershell -File tools/fetch-offline.ps1</code> for LOCAL mode.';
}

// ---------- state ----------
let busy = false, face = null, recording = false, deferredPrompt = null;
let tts = null, ttsLoading = null;
let history = loadHistory();

// ---------- progress overlay ----------
const fmtBytes = (n) => { if (!Number.isFinite(n) || n <= 0) return '0 B'; const u = ['B', 'KB', 'MB', 'GB']; let i = 0, v = n; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`; };
const fileMap = new Map();
const overallPct = () => { let l = 0, t = 0; for (const v of fileMap.values()) if (v.total > 0) { l += v.loaded || 0; t += v.total; } return t > 0 ? (l / t) * 100 : 0; };
const showOverlay = (on) => { el.overlay.classList.toggle('show', !!on); el.overlay.setAttribute('aria-hidden', on ? 'false' : 'true'); };
function setProgress(pct, line, file, loaded, total) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  el.ring.style.setProperty('--p', `${p}%`); $('barFill').style.setProperty('--w', `${p}%`); el.ovPct.textContent = `${p}%`;
  if (line) el.ovLine.textContent = line; if (file) el.ovFile.textContent = file;
  el.ovBytes.textContent = (Number.isFinite(loaded) && total > 0) ? `${fmtBytes(loaded)} / ${fmtBytes(total)}` : '—';
}
function makeProgress(title) {
  return (info) => {
    const st = info?.status, file = info?.file || '';
    if (st === 'initiate' || st === 'download') { el.ovTitle.textContent = `loading ${title}…`; showOverlay(true); setLED('busy'); setStatus('downloading'); setProgress(overallPct(), `fetching ${file}`, file); }
    else if (st === 'progress') { if (file) fileMap.set(file, { loaded: info.loaded, total: info.total }); el.ovTitle.textContent = `loading ${title}…`; showOverlay(true); setLED('busy'); setStatus('downloading'); setProgress(overallPct(), `downloading ${file}`, file, info.loaded, info.total); }
    else if (st === 'done') { if (file && fileMap.has(file)) { const v = fileMap.get(file); fileMap.set(file, { loaded: v.total ?? v.loaded, total: v.total ?? v.loaded }); } setProgress(overallPct(), `unpacking ${file}`, file); }
    else if (st === 'ready') { setProgress(100, 'ready', info.model || ''); setTimeout(() => showOverlay(false), 220); }
  };
}

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
  bubble.innerHTML = ''; bubble.append('Error: ' + (e?.message ?? String(e)) + ' ');
  const r = document.createElement('button'); r.className = 'btn btn--ghost btn--tiny'; r.textContent = 'retry';
  r.onclick = () => { bubble.closest('.msg').remove(); sendMessage(lastText); };
  bubble.append(r);
}
function restoreChat() {
  el.chat.innerHTML = '';
  if (!history.length) addMsg('system', `Local in-browser presenter · ${CFG.mode.toUpperCase()} mode. Type or hit 🎙 — first run downloads & caches the models.`);
  else for (const m of history) addMsg(m.role, m.content);
}
const getMessages = () => [SYSTEM, ...history.slice(-12)];
function updateDevTag(device, dtype) { el.devTag.hidden = false; el.devTag.textContent = dtype ? `${device} ${dtype}` : device; }

// ---------- modules ----------
const speech = createSpeech({ face: null, onCaption, onState, onError: (e) => console.error('speech', e) });
speech.setMuted(settings.muted);
const llm = createLLM({ onProgress: makeProgress('language model') });
const stt = createSTT({ onProgress: makeProgress('speech recognizer') });

function onState(state) {
  if (state === 'speaking') { setOnAir('live'); el.stopBtn.hidden = false; }
  else { setOnAir('idle'); el.stopBtn.hidden = true; el.caption.classList.remove('show'); }
}
function onCaption(text, wi) {
  if (!text) { el.caption.classList.remove('show'); el.caption.innerHTML = ''; return; }
  el.caption.classList.add('show');
  el.caption.innerHTML = text.split(/\s+/).map((w, i) => `<span class="${i < wi ? 'said' : i === wi ? 'now' : ''}">${esc(w)}</span>`).join(' ');
}

// kokoro-js fetches voice .bin files from a fixed HF URL (with a "kokoro-voices"
// Cache layer) instead of localModelPath. In LOCAL mode, pre-seed that cache
// from the on-disk voices so speech works with no network.
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

async function ensureTTS() {
  if (tts) return tts;
  if (ttsLoading) return ttsLoading;
  await maybeSeedVoices();
  fileMap.clear(); showOverlay(true); el.ovTitle.textContent = 'loading voice model…'; setProgress(0, 'preparing', '—');
  ttsLoading = KokoroTTS.from_pretrained(TTS_ID, { dtype: 'q8', device: 'wasm', progress_callback: makeProgress('voice model') })
    .then((t) => { tts = t; speech.attachTTS(t); setStatus('ready'); setLED('ready'); return t; })
    .catch((e) => { console.error(e); setStatus('tts error'); setLED('err'); showOverlay(false); throw e; })
    .finally(() => { ttsLoading = null; });
  return ttsLoading;
}

// ---------- the main loop: chat → stream → speak → emote ----------
function setBusy(on) { busy = !!on; el.send.disabled = busy || !el.input.value.trim(); el.reset.disabled = busy; el.preload.disabled = busy || llm.loaded || llm.busy; el.micBtn.disabled = busy; }

async function sendMessage(raw) {
  const text = (raw ?? '').trim();
  if (!text || busy) return;
  speech.cancel(); setOnAir('idle'); setBusy(true);
  addMsg('user', text); history.push({ role: 'user', content: text }); saveHistory(history);
  const bubble = addMsg('assistant', typingNode());
  setOnAir('think'); setStatus('thinking'); setLED('busy');
  const opts = { modelKey: settings.model, dtype: settings.dtype, device: settings.device, maxTokens: 220 };
  try {
    await ensureTTS();
    const { device, dtype } = await llm.ensure(opts); updateDevTag(device, dtype);
    const ctrl = speech.start({ voice: settings.voice, speed: settings.speed });
    let first = true, moodLen = 0;
    const reply = await llm.generate(getMessages(), opts, (piece, clean) => {
      if (first) { bubble.textContent = ''; first = false; }
      bubble.textContent = clean; scrollBottom();
      ctrl.push(piece);
      if (clean.length - moodLen > 28) { const m = detectMood(clean); face?.setMood(m.mood, m.intensity); moodLen = clean.length; }
    });
    ctrl.close();
    const m = detectMood(reply); face?.setMood(m.mood, m.intensity);
    bubble.textContent = reply;
    history.push({ role: 'assistant', content: reply }); saveHistory(history);
    setStatus('ready'); setLED('ready');
  } catch (e) { console.error(e); renderError(bubble, text, e); setStatus('error'); setLED('err'); speech.cancel(); setOnAir('idle'); }
  finally { setBusy(false); el.input.focus(); }
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

// ---------- voice input ----------
async function micToggle() {
  if (busy) return;
  if (!recording) {
    try { await stt.ensure(); } catch (e) { console.error(e); setStatus('stt error'); return; }
    try { await stt.startRecording(); recording = true; el.micBtn.classList.add('rec'); setStatus('listening'); setLED('busy'); }
    catch (e) { console.error(e); el.banner.hidden = false; el.banner.textContent = 'Microphone access denied or unavailable.'; }
  } else {
    recording = false; el.micBtn.classList.remove('rec'); setStatus('transcribing'); setLED('busy');
    try { const text = await stt.stopAndTranscribe(); setStatus('ready'); setLED('ready'); if (text) sendMessage(text); }
    catch (e) { console.error(e); setStatus('stt error'); setLED('err'); }
  }
}

// ---------- service worker / offline caching ----------
function llmFileList() {
  const id = LLM_MODELS[settings.model].id, base = `https://huggingface.co/${id}/resolve/main/`;
  return ['config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'vocab.json', 'merges.txt', `onnx/${DTYPE_FILE[settings.dtype] || DTYPE_FILE.q8}`].map((f) => base + f);
}
function buildPrecacheList() {
  const shell = ['./', './index.html', './app.js', './face.js', './speech.js', './llm.js', './stt.js', './emotion.js', './persist.js', './styles.css', './manifest.webmanifest', './vendor/stub-empty.js'];
  const libs = [A.three, A.threeCore || (CFG.mode === 'online' ? 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.core.js' : './vendor/three/build/three.core.js'), A.transformers, A.kokoro, A.phonemizer, A.face,
    A.addons + 'environments/RoomEnvironment.js', A.addons + 'loaders/GLTFLoader.js', A.addons + 'loaders/KTX2Loader.js',
    A.addons + 'libs/ktx-parse.module.js', A.addons + 'libs/zstddec.module.js', A.addons + 'libs/meshopt_decoder.module.js',
    A.addons + 'math/ColorSpaces.js', A.addons + 'utils/BufferGeometryUtils.js', A.addons + 'utils/WorkerPool.js',
    A.basis + 'basis_transcoder.js', A.basis + 'basis_transcoder.wasm', A.wasm + 'ort-wasm-simd-threaded.jsep.wasm', A.wasm + 'ort-wasm-simd-threaded.jsep.mjs'];
  const tts = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx', ...VOICES.map((v) => `voices/${v.id}.bin`)].map((f) => `https://huggingface.co/${TTS_ID}/resolve/main/${f}`);
  const whisper = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'].map((f) => `https://huggingface.co/onnx-community/whisper-tiny.en/resolve/main/${f}`);
  // only cache remote (http) urls explicitly; local files are same-origin and cached by the shell entries
  return [...shell, ...libs, ...llmFileList(), ...tts, ...whisper].filter((u, i, a) => u && a.indexOf(u) === i);
}
async function cacheForOffline() {
  el.cacheBtn.disabled = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    const urls = buildPrecacheList();
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
el.stopBtn.addEventListener('click', () => { speech.cancel(); setOnAir('idle'); });
el.micBtn.addEventListener('click', micToggle);
el.preload.addEventListener('click', async () => { if (busy) return; setBusy(true); try { const { device, dtype } = await llm.ensure({ modelKey: settings.model, dtype: settings.dtype, device: settings.device }); updateDevTag(device, dtype); } catch (e) { console.error(e); } finally { setBusy(false); } });
el.reset.addEventListener('click', () => { if (busy) return; speech.cancel(); setOnAir('idle'); history = []; clearHistory(); restoreChat(); el.send.disabled = !el.input.value.trim(); });

el.voice.addEventListener('change', () => { settings.voice = el.voice.value; localStorage.setItem('anchor.voice', settings.voice); });
el.speed.addEventListener('input', () => { settings.speed = +el.speed.value; el.speedVal.textContent = settings.speed.toFixed(2) + '×'; localStorage.setItem('anchor.speed', settings.speed); });
el.modelSel.addEventListener('change', () => { settings.model = el.modelSel.value; localStorage.setItem('anchor.model', settings.model); el.llmId.textContent = LLM_MODELS[settings.model].id.split('/').pop(); });
el.dtypeSel.addEventListener('change', () => { settings.dtype = el.dtypeSel.value; localStorage.setItem('anchor.dtype', settings.dtype); });
el.deviceSel.addEventListener('change', () => { settings.device = el.deviceSel.value; localStorage.setItem('anchor.device', settings.device); });
el.cacheBtn.addEventListener('click', cacheForOffline);
el.clearBtn.addEventListener('click', () => { history = []; clearHistory(); restoreChat(); });

el.muteBtn.addEventListener('click', () => { settings.muted = !settings.muted; speech.setMuted(settings.muted); localStorage.setItem('anchor.muted', settings.muted ? '1' : '0'); el.muteBtn.querySelector('.muteglyph').dataset.muted = settings.muted ? '1' : '0'; });
el.muteBtn.querySelector('.muteglyph').dataset.muted = settings.muted ? '1' : '0';
el.themeBtn.addEventListener('click', () => { const n = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', n); localStorage.setItem('anchor.theme', n); });
el.settingsBtn.addEventListener('click', () => openSettings(!el.settingsPanel.classList.contains('open')));
el.settingsPanel.querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', () => openSettings(false)));
el.modeSwitch.addEventListener('click', () => switchMode(CFG.mode === 'online' ? 'offline' : 'online'));
el.modeSwitch.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.modeSwitch.click(); } });

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; el.installBtn.hidden = false; });
el.installBtn.addEventListener('click', async () => { if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; el.installBtn.hidden = true; } });
window.addEventListener('resize', () => face?.resize());

// gaze: eyes follow the cursor over the viewport
el.faceCanvas.addEventListener('pointermove', (e) => { const r = el.faceCanvas.getBoundingClientRect(); face?.setGazeTarget(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1)); });
el.faceCanvas.addEventListener('pointerleave', () => face?.setGazeTarget(0, 0));

// ---------- boot ----------
restoreChat(); setStatus('idle'); setLED(''); setBusy(false); el.input.focus(); drawWave();
(async () => {
  try { face = await createFace({ canvas: el.faceCanvas, modelUrl: A.face, basisPath: A.basis }); speech.setFace(face); }
  catch (e) { console.error('Face init failed:', e); el.faceFallback.hidden = false; el.faceFallback.innerHTML = 'The animated face needs WebGPU (or WebGL2).<br/>Chat & voice still work — try a recent Chrome/Edge.'; }
})();
