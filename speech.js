// speech.js — Kokoro streaming voice with gapless playback, phoneme→viseme
// timeline, live captions and audio metering. Owns the Web Audio graph and
// drives the face's mouth (amplitude) + viseme (shape) every frame.
import { TextSplitterStream } from 'kokoro-js';

// espeak/IPA char → coarse viseme bucket
const VMAP = {};
const put = (chars, v) => chars.split('').forEach((c) => (VMAP[c] = v));
put('aɑɒʌæɐ', 'AA');
put('eɛ', 'EH');
put('iɪɨyjɪ', 'EE');
put('oɔ', 'OH');
put('uʊwʉ', 'OO');
put('fv', 'FV');
put('mbp', 'MBP');
put('l', 'L');
put('szʃʒʧʤ', 'S');
put('rɹɾ', 'R');

function phonemesToVisemes(ph) {
  const seq = [];
  for (const ch of (ph || '')) {
    if ('ˈˌːˑ.,!?;:()"\''.includes(ch)) { if (seq[seq.length - 1] !== 'sil') seq.push('sil'); continue; }
    if (ch === ' ') { if (seq[seq.length - 1] !== 'sil') seq.push('sil'); continue; }
    const v = VMAP[ch] || 'MID';
    if (seq[seq.length - 1] !== v) seq.push(v);
  }
  return seq.length ? seq : ['MID'];
}

export function createSpeech({ face, onCaption, onState, onError }) {
  const AC = new (window.AudioContext || window.webkitAudioContext)();
  const analyser = AC.createAnalyser();
  analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.6;
  const master = AC.createGain();
  analyser.connect(master); master.connect(AC.destination);
  const timeBuf = new Float32Array(analyser.fftSize);

  let tts = null;
  let session = null;          // current speaking session
  let muted = false;
  master.gain.value = 1;

  const setMuted = (m) => { muted = !!m; master.gain.value = m ? 0 : 1; };
  const attachTTS = (t) => { tts = t; };
  const resume = () => AC.resume().catch(() => {});

  function scheduleClip(s, text, phonemes, audio) {
    const buf = AC.createBuffer(1, audio.audio.length, audio.sampling_rate);
    buf.getChannelData(0).set(audio.audio);
    const src = AC.createBufferSource(); src.buffer = buf; src.connect(analyser);
    const start = Math.max(AC.currentTime + 0.06, s.nextTime);
    src.start(start);
    s.nextTime = start + buf.duration;
    s.lastEnd = s.nextTime;
    s.srcs.push(src);
    s.clips.push({ start, end: start + buf.duration, dur: buf.duration, text: text.trim(), words: text.trim().split(/\s+/), vis: phonemesToVisemes(phonemes) });
    if (!s.started) { s.started = true; onState?.('speaking'); face?.setSpeaking(true); }
  }

  function start({ voice, speed }) {
    cancel();
    const splitter = new TextSplitterStream();
    const s = { cancelled: false, started: false, done: false, clips: [], srcs: [], nextTime: 0, lastEnd: 0, splitter, lastCaption: -1 };
    session = s;
    resume();
    const stream = tts.stream(splitter, { voice, speed });
    s.consume = (async () => {
      try {
        for await (const { text, phonemes, audio } of stream) {
          if (s.cancelled) break;
          scheduleClip(s, text, phonemes, audio);
        }
      } catch (e) { if (!s.cancelled) onError?.(e); }
      finally { s.done = true; }
    })();
    return {
      push: (t) => { try { splitter.push(t); } catch {} },
      close: () => { try { splitter.close(); } catch {} },
      cancel,
      get done() { return s.done; },
    };
  }

  // speak a complete string (non-LLM path, e.g. re-speak)
  function speakText(text, opts) { const c = start(opts); c.push(text); c.close(); return c; }

  function cancel() {
    if (!session) return;
    session.cancelled = true;
    for (const src of session.srcs) { try { src.stop(); } catch {} }
    try { session.splitter.close(); } catch {}
    session = null;
    face?.setSpeaking(false); face?.setMouth(0); face?.setViseme('sil');
    onCaption?.(null, -1); onState?.('idle');
  }

  // per-frame: amplitude → mouth, active clip → viseme + caption
  function tick() {
    requestAnimationFrame(tick);
    analyser.getFloatTimeDomainData(timeBuf);
    let sum = 0; for (let i = 0; i < timeBuf.length; i++) sum += timeBuf[i] * timeBuf[i];
    const level = Math.min(1, Math.max(0, (Math.sqrt(sum / timeBuf.length) - 0.006) * 9));
    face?.setMouth(level);

    const s = session;
    if (!s) return;
    const t = AC.currentTime;
    const clip = s.clips.find((c) => t >= c.start && t < c.end);
    if (clip) {
      const p = (t - clip.start) / clip.dur;
      face?.setViseme(clip.vis[Math.min(clip.vis.length - 1, Math.floor(p * clip.vis.length))]);
      const wi = Math.min(clip.words.length - 1, Math.floor(p * clip.words.length));
      if (clip.text !== s.lastCaptionText || wi !== s.lastCaption) {
        s.lastCaptionText = clip.text; s.lastCaption = wi;
        onCaption?.(clip.text, wi);
      }
    } else {
      face?.setViseme('sil');
    }
    // finished: consumer done, queue drained, audio past the end
    if (s.done && t > s.lastEnd + 0.05) {
      session = null;
      face?.setSpeaking(false); face?.setMouth(0); face?.setViseme('sil');
      onCaption?.(null, -1); onState?.('idle');
    }
  }
  tick();

  return { start, speakText, cancel, setMuted, attachTTS, resume, analyser, setFace(f) { face = f; }, get speaking() { return !!session; } };
}
