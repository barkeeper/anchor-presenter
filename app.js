// ============================================================
// app.js — ANCHOR
// Chat (Transformers.js · SmolLM2) → speech (Kokoro TTS) → a 3D
// Face Cap head whose mouth follows the spoken audio in real time.
// One Transformers.js instance is shared by the LLM and Kokoro so
// the WEB/LOCAL switch swaps every asset source in one place.
// ============================================================
import { pipeline, env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';
import { createFace } from './face.js';

const CFG = window.__ANCHOR__;
const ASSETS = CFG.assets;

const LLM_ID = 'HuggingFaceTB/SmolLM2-135M-Instruct';
const TTS_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DTYPE  = 'q8';

// Curated voices — these are the ones vendored for offline use.
const VOICES = [
  { id: 'af_heart',   label: 'Heart · US ♀' },
  { id: 'af_bella',   label: 'Bella · US ♀' },
  { id: 'af_nicole',  label: 'Nicole · US ♀' },
  { id: 'am_michael', label: 'Michael · US ♂' },
  { id: 'am_fenrir',  label: 'Fenrir · US ♂' },
  { id: 'am_puck',    label: 'Puck · US ♂' },
  { id: 'bf_emma',    label: 'Emma · UK ♀' },
  { id: 'bm_george',  label: 'George · UK ♂' },
];

const SYSTEM = {
  role: 'system',
  content: 'You are Anchor, a warm, concise on-screen presenter. Reply in plain spoken sentences (no markdown, lists or emoji) so your words sound natural when read aloud. Keep answers brief unless asked for detail.',
};

// ---- transformers env: one place decides web vs local ----
env.allowLocalModels  = CFG.mode === 'offline';
env.allowRemoteModels = CFG.mode === 'online';
if (CFG.mode === 'offline') env.localModelPath = ASSETS.modelBase;
env.backends.onnx.wasm.wasmPaths = ASSETS.wasm;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  led: $('led'), status: $('status'), banner: $('banner'),
  llmId: $('llmId'), ttsId: $('ttsId'),
  chat: $('chat'), input: $('input'), send: $('send'), reset: $('reset'), preload: $('preload'),
  modeSwitch: $('modeSwitch'), themeBtn: $('themeBtn'), muteBtn: $('muteBtn'),
  voice: $('voice'), onair: $('onair'), onairTxt: $('onairTxt'),
  faceCanvas: $('face'), faceFallback: $('faceFallback'), wave: $('wave'),
  overlay: $('overlay'), ring: $('ring'), ovTitle: $('ovTitle'), ovLine: $('ovLine'),
  ovPct: $('ovPct'), ovFile: $('ovFile'), ovBytes: $('ovBytes'), ovHint: $('ovHint'),
};
el.llmId.textContent = LLM_ID.split('/').pop();
el.ttsId.textContent = 'Kokoro-82M';
el.modeSwitch.dataset.mode = CFG.mode;
for (const v of VOICES) { const o = document.createElement('option'); o.value = v.id; o.textContent = v.label; el.voice.appendChild(o); }
el.voice.value = localStorage.getItem('anchor.voice') || 'af_heart';

if (CFG.requestedOffline && CFG.offlineMissing) {
  el.banner.hidden = false;
  el.banner.innerHTML = 'Offline assets not found — staying on <b>WEB</b>. Run <code>powershell -File tools/fetch-offline.ps1</code> to enable LOCAL mode.';
}

// ---------- state ----------
let llm = null, llmLoading = null;
let tts = null, ttsLoading = null;
let face = null;
let history = [];
let busy = false;
let muted = localStorage.getItem('anchor.muted') === '1';

// ---------- audio graph ----------
const AC = new (window.AudioContext || window.webkitAudioContext)();
const analyser = AC.createAnalyser();
analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.6;
const master = AC.createGain();
master.gain.value = muted ? 0 : 1;
analyser.connect(master); master.connect(AC.destination);
const timeBuf = new Float32Array(analyser.fftSize);
const freqBuf = new Uint8Array(analyser.frequencyBinCount);
let currentSpeak = null;

// ---------- UI helpers ----------
const fmtBytes = (n) => {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const setLED = (m) => { el.led.className = 'led' + (m ? ' ' + m : ''); };
const setStatus = (t) => { el.status.textContent = t; };
const scrollBottom = () => { el.chat.scrollTop = el.chat.scrollHeight; };
function setOnAir(mode) {
  el.onair.classList.remove('live', 'think');
  if (mode === 'live')  { el.onair.classList.add('live');  el.onairTxt.textContent = 'ON AIR'; }
  else if (mode === 'think') { el.onair.classList.add('think'); el.onairTxt.textContent = 'THINKING'; }
  else el.onairTxt.textContent = 'STANDBY';
}
function addMsg(role, content) {
  const row = document.createElement('div');
  row.className = `msg ${role}`;
  const who = document.createElement('div'); who.className = 'msg__role';
  who.textContent = role === 'assistant' ? 'AI' : role === 'user' ? 'YOU' : 'SYS';
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  if (content instanceof Node) bubble.appendChild(content); else bubble.textContent = content;
  row.append(who, bubble); el.chat.appendChild(row); scrollBottom();
  return bubble;
}
function typingNode() {
  const s = document.createElement('span'); s.className = 'typing';
  s.innerHTML = '<span></span><span></span><span></span>'; return s;
}
function resetChat() {
  history = []; el.chat.innerHTML = '';
  addMsg('system', `Local in-browser presenter · ${CFG.mode.toUpperCase()} mode. Send a message — first run downloads & caches the models.`);
}
function recentMessages() {
  const MAX_TURNS = 6;
  return [SYSTEM, ...history.slice(-MAX_TURNS * 2)];
}

// ---------- progress overlay ----------
const fileMap = new Map();
function overallPct() {
  let l = 0, t = 0;
  for (const v of fileMap.values()) if (v.total > 0) { l += v.loaded || 0; t += v.total; }
  return t > 0 ? (l / t) * 100 : 0;
}
function showOverlay(on) { el.overlay.classList.toggle('show', !!on); el.overlay.setAttribute('aria-hidden', on ? 'false' : 'true'); }
function setProgress(pct, line, file, loaded, total) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  el.ring.style.setProperty('--p', `${p}%`);
  el.overlay.querySelector('#barFill').style.setProperty('--w', `${p}%`);
  el.ovPct.textContent = `${p}%`;
  if (line) el.ovLine.textContent = line;
  if (file) el.ovFile.textContent = file;
  el.ovBytes.textContent = (Number.isFinite(loaded) && total > 0) ? `${fmtBytes(loaded)} / ${fmtBytes(total)}` : '—';
}
function makeProgress(title) {
  return (info) => {
    const st = info?.status, file = info?.file || '';
    if (st === 'initiate' || st === 'download') {
      el.ovTitle.textContent = title; showOverlay(true); setLED('busy'); setStatus('downloading');
      setProgress(overallPct(), `fetching ${file || 'files'}`, file);
    } else if (st === 'progress') {
      if (file) fileMap.set(file, { loaded: info.loaded, total: info.total });
      el.ovTitle.textContent = title; showOverlay(true); setLED('busy'); setStatus('downloading');
      setProgress(overallPct(), `downloading ${file}`, file, info.loaded, info.total);
    } else if (st === 'done') {
      if (file && fileMap.has(file)) { const v = fileMap.get(file); fileMap.set(file, { loaded: v.total ?? v.loaded, total: v.total ?? v.loaded }); }
      setProgress(overallPct(), `unpacking ${file}`, file);
    } else if (st === 'ready') {
      setProgress(100, 'ready', info.model || '');
      setTimeout(() => showOverlay(false), 220);
    }
  };
}

// ---------- model loading ----------
async function ensureLLM() {
  if (llm) return llm;
  if (llmLoading) return llmLoading;
  fileMap.clear(); showOverlay(true); el.ovTitle.textContent = 'loading language model…';
  el.ovHint.textContent = CFG.mode === 'offline' ? 'Reading model weights from disk.' : 'First run downloads weights, then caches in-browser.';
  setProgress(0, 'preparing', '—');
  llmLoading = pipeline('text-generation', LLM_ID, { dtype: DTYPE, progress_callback: makeProgress('loading language model…') })
    .then((g) => { llm = g; setStatus('ready'); setLED('ready'); return g; })
    .catch((e) => { console.error(e); setStatus('llm error'); setLED('err'); showOverlay(false); throw e; })
    .finally(() => { llmLoading = null; });
  return llmLoading;
}
async function ensureTTS() {
  if (tts) return tts;
  if (ttsLoading) return ttsLoading;
  fileMap.clear(); showOverlay(true); el.ovTitle.textContent = 'loading voice model…';
  setProgress(0, 'preparing', '—');
  ttsLoading = KokoroTTS.from_pretrained(TTS_ID, { dtype: DTYPE, device: 'wasm', progress_callback: makeProgress('loading voice model…') })
    .then((t) => { tts = t; setStatus('ready'); setLED('ready'); return t; })
    .catch((e) => { console.error(e); setStatus('tts error'); setLED('err'); showOverlay(false); throw e; })
    .finally(() => { ttsLoading = null; });
  return ttsLoading;
}

// ---------- speech ----------
function chunkText(text) {
  const parts = text.replace(/\s+/g, ' ').trim().match(/[^.!?…]+[.!?…]+|\S+$|[^.!?…]+$/g) || [];
  const out = []; let buf = '';
  for (const p of parts) {
    if ((buf + ' ' + p).trim().length > 180 && buf) { out.push(buf.trim()); buf = p; }
    else buf = (buf + ' ' + p).trim();
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
function stopSpeaking() {
  if (currentSpeak) { currentSpeak.cancelled = true; try { currentSpeak.src?.stop(); } catch {} currentSpeak = null; }
  face?.setSpeaking(false);
}
function playClip(audio, token) {
  return new Promise((resolve) => {
    const buf = AC.createBuffer(1, audio.audio.length, audio.sampling_rate);
    buf.getChannelData(0).set(audio.audio);
    const src = AC.createBufferSource(); src.buffer = buf; src.connect(analyser);
    token.src = src; src.onended = () => resolve(); src.start();
  });
}
async function speak(text) {
  const chunks = chunkText(text);
  if (!chunks.length) return;
  await ensureTTS();
  try { await AC.resume(); } catch {}
  const voice = el.voice.value;
  const token = { cancelled: false, src: null };
  stopSpeaking(); currentSpeak = token;
  setOnAir('live'); face?.setSpeaking(true);
  let gen = tts.generate(chunks[0], { voice });
  for (let i = 0; i < chunks.length; i++) {
    let audio;
    try { audio = await gen; } catch (e) { console.error(e); break; }
    if (token.cancelled) break;
    gen = (i + 1 < chunks.length) ? tts.generate(chunks[i + 1], { voice }) : null;
    await playClip(audio, token);
    if (token.cancelled) break;
  }
  if (currentSpeak === token) { currentSpeak = null; face?.setSpeaking(false); setOnAir('idle'); }
}

// ---------- meter loop (audio → mouth + waveform) ----------
function meter() {
  requestAnimationFrame(meter);
  analyser.getFloatTimeDomainData(timeBuf);
  let sum = 0; for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
  const rms = Math.sqrt(sum / timeBuf.length);
  const level = Math.min(1, Math.max(0, (rms - 0.006) * 9));
  face?.setMouth(level);
  drawWave();
}
function drawWave() {
  const c = el.wave, ctx = c.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio, 2);
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  analyser.getByteFrequencyData(freqBuf);
  const css = getComputedStyle(document.documentElement);
  const amber = css.getPropertyValue('--amber').trim() || '#f0a93b';
  const teal = css.getPropertyValue('--teal').trim() || '#46d6c0';
  const bars = 48, step = Math.floor(freqBuf.length / bars);
  const bw = w / bars;
  for (let i = 0; i < bars; i++) {
    const v = freqBuf[i * step] / 255;
    const bh = Math.max(2, v * h);
    ctx.fillStyle = i % 2 ? teal : amber;
    ctx.globalAlpha = 0.35 + v * 0.65;
    ctx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
  }
  ctx.globalAlpha = 1;
}

// ---------- chat ----------
function setBusy(on) {
  busy = !!on;
  el.send.disabled = busy || !el.input.value.trim();
  el.reset.disabled = busy;
  el.preload.disabled = busy || !!llm || !!llmLoading;
}
async function sendMessage(raw) {
  const text = (raw ?? '').trim();
  if (!text || busy) return;
  stopSpeaking();
  setBusy(true);
  addMsg('user', text); history.push({ role: 'user', content: text });
  const bubble = addMsg('assistant', typingNode());
  setOnAir('think'); setStatus('thinking'); setLED('busy');
  try {
    const gen = await ensureLLM();
    const prompt = gen.tokenizer.apply_chat_template(recentMessages(), { tokenize: false, add_generation_prompt: true });
    const out = await gen(prompt, { max_new_tokens: 220, temperature: 0.5, repetition_penalty: 1.15, return_full_text: false });
    let reply = out[0].generated_text;
    if (reply.includes('<|im_end|>')) reply = reply.split('<|im_end|>')[0];
    if (reply.includes('<|im_start|>')) reply = reply.split('<|im_start|>')[0];
    reply = reply.trim() || '…';
    bubble.textContent = reply;
    history.push({ role: 'assistant', content: reply });
    scrollBottom();
    setStatus('ready'); setLED('ready');
    speak(reply);   // fire-and-forget: face starts talking as audio arrives
  } catch (e) {
    console.error(e);
    bubble.textContent = 'Error: ' + (e?.message ?? String(e));
    setStatus('error'); setLED('err'); setOnAir('idle');
  } finally {
    setBusy(false); el.input.focus();
  }
}

// ---------- events ----------
el.input.addEventListener('input', () => { el.send.disabled = busy || !el.input.value.trim(); });
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const t = el.input.value; el.input.value = ''; el.send.disabled = true; sendMessage(t); }
});
el.send.addEventListener('click', () => { const t = el.input.value; el.input.value = ''; el.send.disabled = true; sendMessage(t); });
el.preload.addEventListener('click', async () => { if (busy) return; setBusy(true); try { await ensureLLM(); } finally { setBusy(false); el.input.focus(); } });
el.reset.addEventListener('click', () => { if (busy) return; stopSpeaking(); setOnAir('idle'); resetChat(); el.send.disabled = !el.input.value.trim(); });
el.voice.addEventListener('change', () => localStorage.setItem('anchor.voice', el.voice.value));

el.muteBtn.addEventListener('click', () => {
  muted = !muted; master.gain.value = muted ? 0 : 1;
  localStorage.setItem('anchor.muted', muted ? '1' : '0');
  el.muteBtn.querySelector('.muteglyph').dataset.muted = muted ? '1' : '0';
});
el.muteBtn.querySelector('.muteglyph').dataset.muted = muted ? '1' : '0';

el.themeBtn.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('anchor.theme', next);
});

function switchMode(target) {
  if (target === CFG.mode) return;
  if (target === 'offline') {
    fetch('./vendor/transformers/transformers.min.js', { method: 'HEAD', cache: 'no-store' })
      .then((r) => {
        if (r.ok) { localStorage.setItem('anchor.mode', 'offline'); location.reload(); }
        else throw new Error('missing');
      })
      .catch(() => {
        el.banner.hidden = false;
        el.banner.innerHTML = 'LOCAL assets not downloaded yet. Run <code>powershell -File tools/fetch-offline.ps1</code> first.';
      });
  } else {
    localStorage.setItem('anchor.mode', 'online'); location.reload();
  }
}
el.modeSwitch.addEventListener('click', () => switchMode(CFG.mode === 'online' ? 'offline' : 'online'));
el.modeSwitch.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.modeSwitch.click(); } });

window.addEventListener('resize', () => face?.resize());

// ---------- boot ----------
resetChat(); setStatus('idle'); setLED(''); setBusy(false); el.input.focus();
meter();

(async () => {
  try {
    face = await createFace({ canvas: el.faceCanvas, modelUrl: ASSETS.face, basisPath: ASSETS.basis });
  } catch (e) {
    console.error('Face init failed:', e);
    el.faceFallback.hidden = false;
    el.faceFallback.innerHTML = 'The animated face needs WebGPU (or WebGL2).<br/>Chat & voice still work — try a recent Chrome/Edge.';
  }
})();
