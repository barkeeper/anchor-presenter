// stt.js — push-to-talk voice input. Records the mic, resamples to 16 kHz mono,
// and transcribes locally with Whisper (Transformers.js).
import { pipeline } from '@huggingface/transformers';

export const STT_MODEL = 'onnx-community/whisper-tiny.en';

export function createSTT({ onProgress }) {
  let asr = null, loading = null;
  let stream = null, recorder = null, chunks = [];

  async function ensure() {
    if (asr) return asr;
    if (loading) return loading;
    loading = pipeline('automatic-speech-recognition', STT_MODEL, { dtype: 'q8', progress_callback: onProgress })
      .then((p) => { asr = p; return p; })
      .finally(() => { loading = null; });
    return loading;
  }

  async function startRecording() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.start();
  }

  // stop, decode, resample to 16k mono, transcribe -> text
  async function stopAndTranscribe() {
    if (!recorder) return '';
    const blob = await new Promise((res) => { recorder.onstop = () => res(new Blob(chunks, { type: recorder.mimeType })); recorder.stop(); });
    stream?.getTracks().forEach((t) => t.stop());
    stream = null; recorder = null;

    const arr = await blob.arrayBuffer();
    const tmp = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await tmp.decodeAudioData(arr);
    tmp.close();

    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
    const rendered = await off.startRendering();
    const data = rendered.getChannelData(0);

    const model = await ensure();
    const out = await model(data); // whisper-tiny.en is English-only (no language/task tokens)
    return (out?.text || '').trim();
  }

  return { ensure, startRecording, stopAndTranscribe, get loaded() { return !!asr; } };
}
