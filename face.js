// ============================================================
// face.js — three.js WebGPU talking head (Face Cap morph targets).
// Layered, procedural performance: viseme mouth shapes (driven by speech.js)
// + audio-amplitude openness + emotion/mood + gaze (cursor + saccades) +
// blinks + breathing/sway + speaking head-turn. No baked clip.
// ============================================================
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// viseme -> mouth morph weights (at full openness; scaled by audio level)
const VISEMES = {
  sil: { mouthClose: 0.12 },
  MID: { jawOpen: 0.4, mouthStretchLeft: 0.15, mouthStretchRight: 0.15 },
  AA:  { jawOpen: 1.0 },
  EH:  { jawOpen: 0.45, mouthStretchLeft: 0.4, mouthStretchRight: 0.4 },
  EE:  { jawOpen: 0.18, mouthStretchLeft: 0.7, mouthStretchRight: 0.7, mouthSmileLeft: 0.25, mouthSmileRight: 0.25 },
  OH:  { jawOpen: 0.55, mouthFunnel: 0.5 },
  OO:  { jawOpen: 0.18, mouthFunnel: 0.65, mouthPucker: 0.7 },
  FV:  { jawOpen: 0.12, mouthUpperUpLeft: 0.4, mouthUpperUpRight: 0.4, mouthLowerDownLeft: 0.2, mouthLowerDownRight: 0.2 },
  MBP: { mouthClose: 0.9 },
  L:   { jawOpen: 0.4, mouthUpperUpLeft: 0.15, mouthUpperUpRight: 0.15 },
  S:   { jawOpen: 0.12, mouthStretchLeft: 0.35, mouthStretchRight: 0.35 },
  R:   { jawOpen: 0.3, mouthFunnel: 0.35, mouthPucker: 0.2 },
};

// mood -> upper-face / expression weights (scaled by intensity)
const MOODS = {
  neutral:  { mouthSmileLeft: 0.08, mouthSmileRight: 0.08 },
  joy:      { mouthSmileLeft: 0.5, mouthSmileRight: 0.5, cheekSquintLeft: 0.35, cheekSquintRight: 0.35, eyeSquintLeft: 0.12, eyeSquintRight: 0.12, browInnerUp: 0.1 },
  sad:      { browInnerUp: 0.5, mouthFrownLeft: 0.4, mouthFrownRight: 0.4, mouthShrugLower: 0.2, eyeSquintLeft: 0.1, eyeSquintRight: 0.1 },
  anger:    { browDownLeft: 0.6, browDownRight: 0.6, noseSneerLeft: 0.3, noseSneerRight: 0.3, mouthPressLeft: 0.4, mouthPressRight: 0.4 },
  surprise: { browInnerUp: 0.5, browOuterUpLeft: 0.5, browOuterUpRight: 0.5, eyeWideLeft: 0.6, eyeWideRight: 0.6 },
  curious:  { browOuterUpLeft: 0.5, browInnerUp: 0.2, eyeWideLeft: 0.15, eyeWideRight: 0.15 },
};

export async function createFace({ canvas, modelUrl, basisPath }) {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  await renderer.init();

  const size = () => ({ w: canvas.clientWidth || 1, h: canvas.clientHeight || 1 });
  let { w, h } = size();
  renderer.setSize(w, h, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, w / h, 0.1, 20);

  const env = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(env, 0.02).texture;
  const key = new THREE.DirectionalLight(0xfff2dd, 1.1); key.position.set(1.2, 1.4, 2.2); scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fe9ff, 0.55); rim.position.set(-1.6, 0.6, -1.4); scene.add(rim);

  const ktx2 = await new KTX2Loader().setTranscoderPath(basisPath).detectSupport(renderer);
  const gltf = await new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder).loadAsync(modelUrl);

  const root = gltf.scene.children[0];
  scene.add(root);
  const head = root.getObjectByName('mesh_2');
  const dict = head.morphTargetDictionary || {};
  const infl = head.morphTargetInfluences || [];

  const find = (name) => { for (const k in dict) if (k === name || k.endsWith('.' + name)) return dict[k]; return -1; };
  const NAMES = ['jawOpen', 'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthSmileLeft', 'mouthSmileRight',
    'mouthFrownLeft', 'mouthFrownRight', 'mouthStretchLeft', 'mouthStretchRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
    'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthShrugLower',
    'cheekSquintLeft', 'cheekSquintRight', 'noseSneerLeft', 'noseSneerRight',
    'eyeBlinkLeft', 'eyeBlinkRight', 'eyeSquintLeft', 'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight',
    'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft', 'eyeLookDownLeft',
    'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpRight', 'eyeLookDownRight',
    'browInnerUp', 'browDownLeft', 'browDownRight', 'browOuterUpLeft', 'browOuterUpRight'];
  const idx = {}; for (const n of NAMES) idx[n] = find(n);

  // framing — fit the head from the front
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const sz = box.getSize(new THREE.Vector3());
  function reframe() {
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const dist = Math.max((sz.y * 1.3) / (2 * Math.tan(fov / 2)), (sz.x * 1.3) / (2 * Math.tan(fov / 2)) / camera.aspect);
    camera.position.set(center.x, center.y + sz.y * 0.02, center.z + dist);
    camera.lookAt(center.x, center.y, center.z);
    camera.updateProjectionMatrix();
  }
  reframe();

  // ---- state ----
  let level = 0, openS = 0;                   // audio openness (target + smoothed)
  let visCur = {}, visTarget = { ...VISEMES.sil };
  let moodCur = {}, moodTarget = { ...MOODS.neutral }, moodTilt = 0, moodTiltT = 0;
  let speaking = false;
  const gaze = { x: 0, y: 0, tx: 0, ty: 0, sx: 0, sy: 0 };  // smoothed + target + saccade
  let nextSaccade = performance.now() + 900;
  let blink = 0, nextBlink = performance.now() + 1500 + Math.random() * 2500;
  const clock = new THREE.Clock(); clock.getDelta();
  let running = true;

  const blendObj = (cur, tgt, k) => { const keys = new Set([...Object.keys(cur), ...Object.keys(tgt)]); for (const key of keys) cur[key] = lerp(cur[key] || 0, tgt[key] || 0, k); };

  function frame() {
    if (!running) return;
    const t = clock.getElapsedTime();
    const dt = Math.min(clock.getDelta(), 0.05);

    // smooth openness (quick attack / slower release) + viseme + mood
    openS = lerp(openS, level, level > openS ? 0.55 : 0.3);
    const open = openS;
    blendObj(visCur, visTarget, 0.35);
    blendObj(moodCur, moodTarget, 0.06);
    moodTilt = lerp(moodTilt, moodTiltT, 0.05);

    // saccades + gaze smoothing
    const now = performance.now();
    if (now > nextSaccade) {
      gaze.sx = (Math.random() * 2 - 1) * 0.18; gaze.sy = (Math.random() * 2 - 1) * 0.12;
      nextSaccade = now + 500 + Math.random() * 1800;
      setTimeout(() => { gaze.sx = 0; gaze.sy = 0; }, 90 + Math.random() * 120);
    }
    gaze.x = lerp(gaze.x, gaze.tx + gaze.sx, 0.15);
    gaze.y = lerp(gaze.y, gaze.ty + gaze.sy, 0.15);

    // blinks
    if (now > nextBlink) { blink = 1; nextBlink = now + 220; }
    if (blink > 0 && now > nextBlink - 120) blink = Math.max(0, blink - dt * 9);
    if (blink === 0 && now > nextBlink && now < nextBlink + 30) nextBlink = now + 1800 + Math.random() * 3200;
    const bl = Math.sin(Math.min(blink, 1) * Math.PI);

    // ---- accumulate weights ----
    const W = {};
    const add = (n, v) => { if (v) W[n] = (W[n] || 0) + v; };
    // mood (upper face + expression)
    for (const n in moodCur) add(n, moodCur[n]);
    // viseme mouth, scaled by openness (jaw tracks audio; others partly)
    for (const n in visCur) {
      const v = visCur[n];
      if (n === 'jawOpen') add(n, v * open);
      else if (n === 'mouthClose') add(n, v * (0.5 + 0.5 * (1 - open)));
      else add(n, v * (0.4 + 0.6 * open));
    }
    // idle brow life
    add('browInnerUp', 0.04 + Math.sin(t * 0.7) * 0.02);
    // blink (+ a touch of squint from mood already in W)
    add('eyeBlinkLeft', bl); add('eyeBlinkRight', bl);
    // gaze
    const gx = Math.max(-0.6, Math.min(0.6, gaze.x)), gy = Math.max(-0.5, Math.min(0.5, gaze.y));
    if (gx > 0) { add('eyeLookOutRight', gx); add('eyeLookInLeft', gx); }
    else { add('eyeLookOutLeft', -gx); add('eyeLookInRight', -gx); }
    if (gy > 0) { add('eyeLookUpLeft', gy); add('eyeLookUpRight', gy); }
    else { add('eyeLookDownLeft', -gy); add('eyeLookDownRight', -gy); }

    // write
    for (const n of NAMES) { const i = idx[n]; if (i >= 0) infl[i] = clamp01(W[n] || 0); }

    // living motion + face the viewer a bit more while speaking
    const swayY = Math.sin(t * 0.45) * (speaking ? 0.025 : 0.05) + gx * 0.06;
    root.rotation.y = swayY + (speaking ? Math.sin(t * 2.1) * 0.01 : 0);
    root.rotation.x = Math.sin(t * 0.6) * 0.02 - gy * 0.05 + (speaking ? open * 0.03 : 0);
    root.rotation.z = moodTilt;
    root.position.y = Math.sin(t * 1.1) * 0.004;

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function resize() {
    const s = size(); if (s.w === w && s.h === h) return;
    w = s.w; h = s.h; camera.aspect = w / h; renderer.setSize(w, h, false); reframe();
  }

  return {
    setMouth(v) { level = clamp01(v); },
    setViseme(id) { visTarget = VISEMES[id] || VISEMES.sil; },
    setMood(mood, intensity = 0.6) {
      const base = MOODS[mood] || MOODS.neutral; const scaled = {};
      for (const n in base) scaled[n] = base[n] * (0.4 + intensity * 0.8);
      moodTarget = scaled;
      moodTiltT = mood === 'curious' ? 0.08 : mood === 'sad' ? -0.03 : 0;
    },
    setGazeTarget(x, y) { gaze.tx = Math.max(-1, Math.min(1, x)); gaze.ty = Math.max(-1, Math.min(1, y)); },
    setSpeaking(on) { speaking = !!on; if (!on) level = 0; },
    resize,
    dispose() { running = false; renderer.dispose(); },
  };
}
