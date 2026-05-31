// speech.js — audio player + face driver. Receives ready-made audio chunks from
// the inference worker, plays them back gaplessly, builds a phoneme→viseme
// timeline, drives the face mouth (amplitude) + viseme (shape) and emits live
// captions. No model inference here, so the render loop never stalls.

const VMAP = {};
const put = (chars, v) => chars.split('').forEach((c) => (VMAP[c] = v));
put('aɑɒʌæɐ', 'AA'); put('eɛ', 'EH'); put('iɪɨyjɪ', 'EE'); put('oɔ', 'OH');
put('uʊwʉ', 'OO'); put('fv', 'FV'); put('mbp', 'MBP'); put('l', 'L');
put('szʃʒʧʤ', 'S'); put('rɹɾ', 'R');

function phonemesToVisemes(ph) {
  const seq = [];
  for (const ch of (ph || '')) {
    if (' ˈˌːˑ.,!?;:()"\''.includes(ch)) { if (seq[seq.length - 1] !== 'sil') seq.push('sil'); continue; }
    const v = VMAP[ch] || 'MID';
    if (seq[seq.length - 1] !== v) seq.push(v);
  }
  return seq.length ? seq : ['MID'];
}

export function createSpeech({ face, onCaption, onState }) {
  const AC = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = AC.createAnalyser();
  analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.6;
  const master = AC.createGain();
  analyser.connect(master); master.connect(AC.destination);
  const timeBuf = new Float32Array(analyser.fftSize);

  let session = null, muted = false;
  master.gain.value = 1; // app calls setMuted() with the saved preference

  const begin = () => { cancel(); session = { clips: [], srcs: [], nextTime: 0, lastEnd: 0, started: false, ended: false, lastCaption: -1, lastCaptionText: '' }; AC.resume().catch(() => {}); };

  function enqueue(chunk) {
    if (!session) begin();
    const s = session;
    const buf = AC.createBuffer(1, chunk.audio.length, chunk.sr);
    buf.getChannelData(0).set(chunk.audio);
    const src = AC.createBufferSource(); src.buffer = buf; src.connect(analyser);
    const start = Math.max(AC.currentTime + 0.08, s.nextTime);
    src.start(start);
    s.nextTime = start + buf.duration; s.lastEnd = s.nextTime; s.srcs.push(src);
    const text = (chunk.text || '').trim();
    s.clips.push({ start, end: start + buf.duration, dur: buf.duration, text, words: text.split(/\s+/), vis: phonemesToVisemes(chunk.phonemes) });
    if (!s.started) { s.started = true; onState?.('speaking'); face?.setSpeaking(true); }
  }

  const end = () => { if (session) session.ended = true; };

  function cancel() {
    if (!session) return;
    for (const src of session.srcs) { try { src.stop(); } catch {} }
    session = null;
    face?.setSpeaking(false); face?.setMouth(0); face?.setViseme('sil');
    onCaption?.(null, -1); onState?.('idle');
  }

  function tick() {
    requestAnimationFrame(tick);
    analyser.getFloatTimeDomainData(timeBuf);
    let sum = 0; for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
    face?.setMouth(Math.min(1, Math.max(0, (Math.sqrt(sum / timeBuf.length) - 0.006) * 9)));

    const s = session; if (!s) return;
    const t = AC.currentTime;
    const clip = s.clips.find((c) => t >= c.start && t < c.end);
    if (clip) {
      const p = (t - clip.start) / clip.dur;
      face?.setViseme(clip.vis[Math.min(clip.vis.length - 1, Math.floor(p * clip.vis.length))]);
      const wi = Math.min(clip.words.length - 1, Math.floor(p * clip.words.length));
      if (clip.text !== s.lastCaptionText || wi !== s.lastCaption) { s.lastCaptionText = clip.text; s.lastCaption = wi; onCaption?.(clip.text, wi); }
    } else { face?.setViseme('sil'); }

    if (s.ended && t > s.lastEnd + 0.05) {
      session = null;
      face?.setSpeaking(false); face?.setMouth(0); face?.setViseme('sil');
      onCaption?.(null, -1); onState?.('idle');
    }
  }
  tick();

  return {
    begin, enqueue, end, cancel,
    setMuted(m) { muted = !!m; master.gain.value = m ? 0 : 1; },
    setFace(f) { face = f; },
    analyser,
    get speaking() { return !!session; },
  };
}
