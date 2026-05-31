// ============================================================
// face.js — VRoid VRM talking head (three.js WebGL + @pixiv/three-vrm).
// Lip-sync + emotion via VRM expressions, cursor gaze via VRM lookAt, blinks,
// spring-bone physics, and a procedural idle that breathes, sways and throws in
// occasional flourish gestures. Same public API as before so app/speech are
// unchanged: setMouth/setViseme/setMood/setGazeTarget/setSpeaking/resize/dispose.
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

// viseme id -> VRM mouth expression weights (aa/ih/ou/ee/oh)
const VISEME_VRM = {
  sil: {}, MID: { aa: 0.35 }, AA: { aa: 1.0 }, EH: { aa: 0.55, ee: 0.3 },
  EE: { ee: 0.9, ih: 0.25 }, IH: { ih: 0.7 }, OH: { oh: 0.95 }, OO: { ou: 0.95 },
  FV: { ih: 0.35 }, MBP: {}, L: { aa: 0.35 }, S: { ih: 0.45 }, R: { ou: 0.45 },
};
const MOUTH = ['aa', 'ih', 'ou', 'ee', 'oh'];
// mood -> VRM emotion expression
const MOOD_VRM = { neutral: {}, joy: { happy: 1 }, sad: { sad: 1 }, anger: { angry: 1 }, surprise: { surprised: 1 }, curious: { relaxed: 0.7 } };
const EMOS = ['happy', 'sad', 'angry', 'surprised', 'relaxed'];

// idle flourish gestures — additive bone rotation offsets (radians), eased in/out.
const GESTURES = [
  { dur: 2.6, bones: { head: { z: 0.16 }, neck: { z: 0.05 }, chest: { y: 0.05 } } },                       // head tilt
  { dur: 3.2, bones: { rightUpperArm: { z: 0.55, x: -0.25 }, rightLowerArm: { y: 0.7 }, head: { y: -0.06 } }, osc: { bone: 'rightLowerArm', axis: 'y', amp: 0.22, freq: 6 } }, // little wave
  { dur: 2.8, bones: { leftUpperArm: { z: -0.5, x: -0.3 }, leftLowerArm: { y: -0.5 }, chest: { y: -0.05 } } }, // present / gesture out
  { dur: 1.9, bones: { leftShoulder: { z: -0.12 }, rightShoulder: { z: 0.12 }, head: { x: 0.06 } } },        // shrug
  { dur: 3.0, bones: { spine: { z: 0.08 }, hips: { y: 0.06 }, head: { z: -0.05 } } },                         // lean
  { dur: 2.4, bones: { head: { x: -0.08 }, chest: { x: -0.03 }, leftUpperArm: { z: -0.15 }, rightUpperArm: { z: 0.15 } } }, // look up, open up
];

export async function createFace({ canvas, modelUrl }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const size = () => ({ w: canvas.clientWidth || 1, h: canvas.clientHeight || 1 });
  let { w, h } = size();
  renderer.setSize(w, h, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, w / h, 0.1, 30);
  scene.add(camera);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.5).texture;
  const key = new THREE.DirectionalLight(0xfff4e6, 2.2); key.position.set(1.4, 2.2, 2.4); scene.add(key);
  const rim = new THREE.DirectionalLight(0xbfe3ff, 1.0); rim.position.set(-1.8, 1.2, -1.6); scene.add(rim);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  // ---- load VRM ----
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(modelUrl);
  const vrm = gltf.userData.vrm;
  try { VRMUtils.removeUnnecessaryVertices?.(gltf.scene); } catch {}
  try { VRMUtils.removeUnnecessaryJoints?.(gltf.scene); } catch {}
  try { VRMUtils.rotateVRM0?.(vrm); } catch {}                 // normalize VRM0 to face -Z like VRM1
  vrm.scene.traverse((o) => { o.frustumCulled = false; });
  vrm.scene.rotation.y = Math.PI;                              // turn to face the camera (+Z)
  scene.add(vrm.scene);

  const humanoid = vrm.humanoid;
  const expr = vrm.expressionManager;
  const bone = (n) => humanoid?.getNormalizedBoneNode?.(n) || null;

  // relaxed A-pose rest offsets (VRM loads in T-pose)
  const REST = {
    leftUpperArm: { z: -1.18, x: 0.12 }, rightUpperArm: { z: 1.18, x: 0.12 },
    leftLowerArm: { y: -0.18 }, rightLowerArm: { y: 0.18 },
  };
  const ANIM_BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
    'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'];
  const base = {};
  for (const n of ANIM_BONES) { const r = REST[n] || {}; base[n] = { x: r.x || 0, y: r.y || 0, z: r.z || 0 }; const b = bone(n); if (b) b.rotation.set(base[n].x, base[n].y, base[n].z); }

  // lookAt target rides the camera so the eyes meet the viewer (+ cursor gaze)
  const lookTarget = new THREE.Object3D(); camera.add(lookTarget); lookTarget.position.set(0, 0, -3);
  if (vrm.lookAt) vrm.lookAt.target = lookTarget;

  // prime the rig so normalized bone world positions are valid before framing
  vrm.update(0);
  scene.updateMatrixWorld(true);

  // ---- framing on head + shoulders ----
  const headBone = bone('head');
  function reframe() {
    const hp = new THREE.Vector3();
    if (headBone) headBone.getWorldPosition(hp);
    const eyeY = (headBone && hp.y > 0.3) ? hp.y : 1.35;
    camera.position.set(0, eyeY - 0.03, 0.92);
    camera.lookAt(0, eyeY - 0.18, 0);
    camera.updateProjectionMatrix();
  }
  reframe();

  // ---- state ----
  let level = 0, openS = 0;
  let visCur = {}, visTarget = {};
  let moodCur = {}, moodTarget = {}, moodTiltT = 0, moodTilt = 0;
  let speaking = false;
  const gaze = { x: 0, y: 0, tx: 0, ty: 0, sx: 0, sy: 0 };
  let nextSaccade = performance.now() + 900;
  let blink = 0, nextBlink = performance.now() + 1200 + Math.random() * 2500;
  let gesture = null, gestureT = 0, nextGesture = performance.now() + 3000 + Math.random() * 4000;
  const clock = new THREE.Clock(); clock.getDelta();
  let running = true;

  const setExpr = (name, v) => { try { expr?.setValue(name, v); } catch {} };
  const blendObj = (cur, tgt, k) => { const keys = new Set([...Object.keys(cur), ...Object.keys(tgt)]); for (const key of keys) cur[key] = lerp(cur[key] || 0, tgt[key] || 0, k); };

  function frame() {
    if (!running) return;
    const t = clock.getElapsedTime();
    const dt = Math.min(clock.getDelta(), 0.05);
    const now = performance.now();

    // ---- expressions: mouth (viseme*amplitude) ----
    openS = lerp(openS, level, level > openS ? 0.5 : 0.3);
    blendObj(visCur, visTarget, 0.4);
    const acc = {}; for (const m of MOUTH) acc[m] = 0;
    for (const m in visCur) if (acc[m] !== undefined) acc[m] += visCur[m] * (0.25 + 0.75 * openS);
    for (const m of MOUTH) setExpr(m, clamp01(acc[m]));

    // ---- expressions: mood ----
    blendObj(moodCur, moodTarget, 0.05);
    moodTilt = lerp(moodTilt, moodTiltT, 0.04);
    for (const e of EMOS) setExpr(e, clamp01(moodCur[e] || 0));

    // ---- blink (skip while a big smile already closes the eyes) ----
    if (now > nextBlink) { blink = 1; nextBlink = now + 200; }
    if (blink > 0 && now > nextBlink - 110) blink = Math.max(0, blink - dt * 9);
    if (blink === 0 && now > nextBlink && now < nextBlink + 30) nextBlink = now + 1600 + Math.random() * 3400;
    setExpr('blink', clamp01(Math.sin(Math.min(blink, 1) * Math.PI) * (1 - (moodCur.happy || 0) * 0.6)));

    // ---- gaze: saccades + cursor, fed to lookAt ----
    if (now > nextSaccade) { gaze.sx = (Math.random() * 2 - 1) * 0.25; gaze.sy = (Math.random() * 2 - 1) * 0.15; nextSaccade = now + 600 + Math.random() * 2000; setTimeout(() => { gaze.sx = 0; gaze.sy = 0; }, 90 + Math.random() * 140); }
    gaze.x = lerp(gaze.x, gaze.tx + gaze.sx, 0.12);
    gaze.y = lerp(gaze.y, gaze.ty + gaze.sy, 0.12);
    lookTarget.position.set(gaze.x * 1.6, gaze.y * 1.1, -3);

    // ---- body: rest pose + idle life + gesture ----
    if (now > nextGesture && !gesture) { gesture = GESTURES[(Math.random() * GESTURES.length) | 0]; gestureT = 0; }
    let gw = 0, gosc = 0;
    if (gesture) {
      gestureT += dt / gesture.dur;
      if (gestureT >= 1) { gesture = null; nextGesture = now + (speaking ? 5000 : 3500) + Math.random() * (speaking ? 6000 : 5000); }
      else { gw = Math.sin(gestureT * Math.PI); gw = easeInOut(gw); if (gesture?.osc) gosc = Math.sin(t * gesture.osc.freq) * gesture.osc.amp * gw; }
    }
    const breath = Math.sin(t * 0.9), sway = Math.sin(t * 0.5), sway2 = Math.sin(t * 0.37);
    const idle = {
      hips: { y: sway * 0.04, z: sway2 * 0.015 },
      spine: { x: breath * 0.02, z: sway * 0.02 },
      chest: { x: breath * 0.03 },
      upperChest: { x: breath * 0.02 },
      neck: { z: sway2 * 0.03 },
      head: { x: Math.sin(t * 0.6) * 0.03 - gaze.y * 0.12, y: sway2 * 0.04 + gaze.x * 0.18, z: Math.sin(t * 0.45) * 0.03 + moodTilt },
      leftUpperArm: { x: Math.sin(t * 0.7) * 0.04, z: Math.sin(t * 0.5) * 0.03 },
      rightUpperArm: { x: Math.sin(t * 0.7 + 1) * 0.04, z: Math.sin(t * 0.5 + 1) * 0.03 },
      leftLowerArm: {}, rightLowerArm: {}, leftShoulder: {}, rightShoulder: {},
    };
    for (const n of ANIM_BONES) {
      const b = bone(n); if (!b) continue;
      const id = idle[n] || {}, g = (gesture && gw) ? (gesture.bones[n] || {}) : {};
      let rx = base[n].x + (id.x || 0) + (g.x || 0) * gw;
      let ry = base[n].y + (id.y || 0) + (g.y || 0) * gw;
      let rz = base[n].z + (id.z || 0) + (g.z || 0) * gw;
      if (gesture?.osc && gesture.osc.bone === n) rz += (gesture.osc.axis === 'z' ? gosc : 0), ry += (gesture.osc.axis === 'y' ? gosc : 0);
      // speaking adds gentle head/torso emphasis tied to the voice
      if (speaking) { if (n === 'head') { rx += openS * 0.05; ry += Math.sin(t * 2.2) * 0.02; } if (n === 'chest') rx += openS * 0.02; }
      b.rotation.set(rx, ry, rz);
    }

    vrm.update(dt);   // applies expressions, lookAt and spring-bone physics
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function resize() { const s = size(); if (s.w === w && s.h === h) return; w = s.w; h = s.h; camera.aspect = w / h; renderer.setSize(w, h, false); reframe(); }

  return {
    setMouth(v) { level = clamp01(v); },
    setViseme(id) { visTarget = VISEME_VRM[id] || {}; },
    setMood(mood, intensity = 0.6) { const baseM = MOOD_VRM[mood] || {}; const scaled = {}; for (const e in baseM) scaled[e] = baseM[e] * (0.4 + intensity * 0.7); moodTarget = scaled; moodTiltT = mood === 'curious' ? 0.1 : mood === 'sad' ? -0.04 : 0; },
    setGazeTarget(x, y) { gaze.tx = Math.max(-1, Math.min(1, x)); gaze.ty = Math.max(-1, Math.min(1, y)); },
    setSpeaking(on) { speaking = !!on; if (!on) level = 0; },
    resize,
    dispose() { running = false; try { VRMUtils.deepDispose?.(vrm.scene); } catch {} renderer.dispose(); },
  };
}
