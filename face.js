// ============================================================
// face.js — VRoid VRM talking head (three.js WebGL + @pixiv/three-vrm).
// Body motion comes from pixiv's VRMA Motion Pack (loaded via three-vrm-animation):
// boots with VRMA_01 "Show full body" (the walk-in/reveal), then cycles the other
// clips on AFK gaps. Lip-sync, blinks, mood and gaze stay procedural via the VRM
// expression manager and lookAt target, so speech still drives the face on top of
// whatever body clip is playing. Same public API as before.
// ============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { createVRMAnimationClip, VRMAnimationLoaderPlugin, VRMLookAtQuaternionProxy } from '@pixiv/three-vrm-animation';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

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

// pixiv VRMA Motion Pack — credit: "Animation credits to pixiv Inc.'s VRoid Project"
// (terms in assets/vrma/Readme_VRMA_MotionPack_EN.txt)
const VRMA_BASE = './assets/vrma/';
const VRMA_INTRO = 'VRMA_01.vrma';                   // "Show full body" — the walk-in
const VRMA_IDLE  = [                                  // pool we cycle through when AFK
  'VRMA_02.vrma', // Greeting
  'VRMA_03.vrma', // Peace sign
  'VRMA_04.vrma', // Shoot
  'VRMA_05.vrma', // Spin
  'VRMA_06.vrma', // Model pose
  'VRMA_07.vrma', // Squat
];
// Rare clips — "showstopper" dances. Cycled with no-repeats (each plays before any
// repeats), gated to fire no more often than RARE_MIN_GAP_MS.
const VRMA_RARE = [
  'OtonaBlue.vrma',
  'BabyYou.vrma',
  'TocaToca.vrma',
  'RareDance_3.vrma',
  'RareDance_5.vrma',
];
const RARE_MIN_GAP_MS = 3 * 60 * 1000;               // never sooner than 3 min apart
const RARE_MAX_GAP_MS = 6 * 60 * 1000;               // upper bound on the random gap

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
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; // small blur — 0.5 exceeds the 20-sample cap and warns
  const key = new THREE.DirectionalLight(0xfff4e6, 2.2); key.position.set(1.4, 2.2, 2.4); scene.add(key);
  const rim = new THREE.DirectionalLight(0xbfe3ff, 1.0); rim.position.set(-1.8, 1.2, -1.6); scene.add(rim);
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  // ---- loader (registered for both VRM and VRMA) ----
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

  // ---- load VRM ----
  const gltf = await loader.loadAsync(modelUrl);
  const vrm = gltf.userData.vrm;
  try { VRMUtils.removeUnnecessaryVertices?.(gltf.scene); } catch {}
  try { (VRMUtils.combineSkeletons || VRMUtils.removeUnnecessaryJoints)?.(gltf.scene); } catch {} // combineSkeletons replaces the deprecated removeUnnecessaryJoints
  try { VRMUtils.rotateVRM0?.(vrm); } catch {}                 // normalize VRM0 to face -Z like VRM1
  vrm.scene.traverse((o) => { o.frustumCulled = false; });
  vrm.scene.rotation.y = Math.PI;                              // turn to face the camera (+Z)
  scene.add(vrm.scene);

  const expr = vrm.expressionManager;

  // lookAt needs a quaternion proxy in the scene graph for VRMA clips to drive it
  if (vrm.lookAt) {
    const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
    proxy.name = 'lookAtQuaternionProxy';
    vrm.scene.add(proxy);
  }

  // lookAt target rides the camera so the eyes meet the viewer (+ cursor gaze)
  const lookTarget = new THREE.Object3D(); camera.add(lookTarget); lookTarget.position.set(0, 0, -3);
  if (vrm.lookAt) vrm.lookAt.target = lookTarget;

  // prime the rig so bone world positions are valid before framing
  vrm.update(0);
  scene.updateMatrixWorld(true);

  // ---- framing on full body (head to toe) — measured once at rest ----
  let bodyCenterY = 0.85, bodyHeight = 1.7;
  {
    const box = new THREE.Box3().setFromObject(vrm.scene);
    if (isFinite(box.max.y) && isFinite(box.min.y)) {
      bodyHeight = Math.max(box.max.y - box.min.y, 1.2);
      bodyCenterY = (box.max.y + box.min.y) / 2;
    }
  }
  // Fixed full-body framing — measured once, never zooms during animations.
  function reframe() {
    const aspect = Math.max(w / h, 0.0001);
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const padding = 1.18;
    const distV = (bodyHeight * padding) / (2 * Math.tan(vFov / 2));
    const distH = (bodyHeight * padding * 0.45) / (2 * Math.tan(vFov / 2) * aspect);
    const dist = Math.max(distV, distH);
    camera.position.set(0, bodyCenterY, dist);
    camera.lookAt(0, bodyCenterY, 0);
    camera.updateProjectionMatrix();
  }
  reframe();

  // ---- load VRMA clips (intro + idle pool + optional rare pool) ----
  async function loadClip(file) {
    const g = await loader.loadAsync(VRMA_BASE + file);
    const anim = g.userData.vrmAnimations?.[0];
    if (!anim) throw new Error(`No animation in ${file}`);
    const clip = createVRMAnimationClip(anim, vrm);
    clip.name = file.replace(/\.vrma$/i, ''); // they're all "Clip" otherwise — name for status/debug
    return clip;
  }
  // Best-effort: missing/optional clips just get skipped, they don't break boot.
  async function tryLoad(file) { try { return await loadClip(file); } catch (e) { console.warn(`[face] skipping ${file}: ${e?.message || e}`); return null; } }
  const introClip = await loadClip(VRMA_INTRO);
  const idleClips = await Promise.all(VRMA_IDLE.map(loadClip));
  const rareClips = (await Promise.all(VRMA_RARE.map(tryLoad))).filter(Boolean);

  const mixer = new THREE.AnimationMixer(vrm.scene);
  let currentAction = null;

  function playClip(clip, { fade = 0.5, loop = false } = {}) {
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = true;
    if (currentAction && currentAction !== action) {
      action.play();
      currentAction.crossFadeTo(action, fade, false);
    } else {
      action.play();
    }
    currentAction = action;
    return action;
  }

  // Shuffled queue of rare clips — each plays once before any repeats. Reshuffled
  // (without putting the last-played one first) once the queue empties.
  function fyShuffle(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [r[i], r[j]] = [r[j], r[i]]; } return r; }
  let rareQueue = fyShuffle(rareClips);
  let lastRare = null;
  function nextRareClip() {
    if (!rareQueue.length) {
      rareQueue = fyShuffle(rareClips);
      // make sure the first one isn't the same as the last we played
      if (rareClips.length > 1 && rareQueue[0] === lastRare) rareQueue.push(rareQueue.shift());
    }
    const clip = rareQueue.shift(); lastRare = clip; return clip;
  }

  // queue next clip when the current one finishes
  let nextQueuedAt = 0;
  let queuedClip = null;
  let nextRareAt = performance.now() + RARE_MIN_GAP_MS + Math.random() * (RARE_MAX_GAP_MS - RARE_MIN_GAP_MS);
  mixer.addEventListener('finished', (e) => {
    // Only react when the CURRENTLY-active clip ends. A manually-triggered dance crossfades
    // out the previous idle, whose LoopOnce action may then fire 'finished' mid-fade — without
    // this guard it would queue an idle that overrides the dance ~1s later.
    if (e.action !== currentAction) return;
    const now = performance.now();
    let pick;
    if (rareClips.length && now >= nextRareAt) {
      pick = nextRareClip();
      nextRareAt = now + RARE_MIN_GAP_MS + Math.random() * (RARE_MAX_GAP_MS - RARE_MIN_GAP_MS);
    } else {
      // pick a random idle clip, avoiding repeating the one we just played
      do { pick = idleClips[(Math.random() * idleClips.length) | 0]; }
      while (idleClips.length > 1 && pick === currentAction?.getClip());
    }
    queuedClip = pick;
    nextQueuedAt = now + 1200 + Math.random() * 2000; // small breather between clips
  });

  // boot with the intro
  playClip(introClip, { fade: 0 });

  // expose a small probe so the rare clip can be inspected / triggered from devtools:
  //   window.__face.status()    → { rareLoaded, secondsUntilRare, currentClip }
  //   window.__face.playRare()  → fire the rare clip immediately
  try {
    window.__face = {
      status: () => ({
        rareLoaded: rareClips.length > 0,
        secondsUntilRare: Math.max(0, Math.round((nextRareAt - performance.now()) / 1000)),
        currentClip: currentAction?.getClip()?.name || null,
        idleCount: idleClips.length,
      }),
      playRare: () => { if (!rareClips.length) return 'no rare clip loaded'; queuedClip = null; const c = nextRareClip(); playClip(c, { fade: 0.4 }); return `playing: ${c.name || '(unnamed)'}`; },
      // debug: current mouth expression weights, so a test can verify lip-sync is driving them.
      sampleMouth: () => { const o = {}; for (const m of MOUTH) o[m] = +((expr?.getValue?.(m)) ?? 0).toFixed(3); return o; },
      // debug: sample a few humanoid bone rotations so a test can detect whether a clip
      // is actually driving the rig (motion) vs. loaded-but-inert (no retargeted tracks).
      sampleBones: () => {
        const out = {};
        for (const n of ['hips', 'spine', 'leftUpperArm', 'rightUpperArm', 'leftLowerLeg', 'head']) {
          const node = vrm.humanoid?.getNormalizedBoneNode?.(n);
          if (node) out[n] = [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w].map((v) => +v.toFixed(4));
        }
        return out;
      },
    };
  } catch {}

  // ---- expressions state (mouth/blink/gaze/mood, applied on top of VRMA) ----
  let level = 0, openS = 0;
  let visCur = {}, visTarget = {};
  let moodCur = {}, moodTarget = {};
  let speaking = false;
  const gaze = { x: 0, y: 0, tx: 0, ty: 0, sx: 0, sy: 0 };
  let nextSaccade = performance.now() + 900;
  let blink = 0, nextBlink = performance.now() + 1800 + Math.random() * 2400;

  const clock = new THREE.Clock(); clock.getDelta();
  let running = true;

  const setExpr = (name, v) => { try { expr?.setValue(name, v); } catch {} };
  const blendObj = (cur, tgt, k) => { const keys = new Set([...Object.keys(cur), ...Object.keys(tgt)]); for (const key of keys) cur[key] = lerp(cur[key] || 0, tgt[key] || 0, k); };

  function frame() {
    if (!running) return;
    requestAnimationFrame(frame); // schedule the next frame FIRST so a thrown body can't kill the loop
    try {
    const dt = Math.min(clock.getDelta(), 0.05);
    const now = performance.now();

    // ---- body animation (VRMA mixer) ----
    mixer.update(dt);
    if (queuedClip && now >= nextQueuedAt) {
      playClip(queuedClip, { fade: 0.6 });
      queuedClip = null;
    }

    // ---- mouth visemes ----
    openS = lerp(openS, level, level > openS ? 0.5 : 0.3);
    blendObj(visCur, visTarget, 0.4);
    const acc = {}; for (const m of MOUTH) acc[m] = 0;
    // Mouth openness is gated purely by live audio amplitude (no constant base): when the
    // voice stops, openS → 0 and the mouth fully closes, even if a viseme shape lingers.
    const gate = Math.min(1, openS * 1.4);
    for (const m in visCur) if (acc[m] !== undefined) acc[m] += visCur[m] * gate;
    for (const m of MOUTH) setExpr(m, clamp01(acc[m]));

    // ---- mood ----
    blendObj(moodCur, moodTarget, 0.05);
    for (const e of EMOS) setExpr(e, clamp01(moodCur[e] || 0));

    // ---- blink (state machine: idle → close→open → schedule next) ----
    if (blink === 0 && now > nextBlink) {
      blink = 0.001;
      nextBlink = now + 2400 + Math.random() * 3200;
    }
    if (blink > 0) {
      blink += dt * 7;
      if (blink >= 1) blink = 0;
    }
    setExpr('blink', clamp01(Math.sin(blink * Math.PI) * (1 - (moodCur.happy || 0) * 0.6)));

    // ---- gaze (saccades + cursor target → lookAt) ----
    if (now > nextSaccade) {
      gaze.sx = (Math.random() * 2 - 1) * 0.25;
      gaze.sy = (Math.random() * 2 - 1) * 0.15;
      nextSaccade = now + 1200 + Math.random() * 2400;
      setTimeout(() => { gaze.sx = 0; gaze.sy = 0; }, 90 + Math.random() * 140);
    }
    gaze.x = lerp(gaze.x, gaze.tx + gaze.sx, 0.12);
    gaze.y = lerp(gaze.y, gaze.ty + gaze.sy, 0.12);
    lookTarget.position.set(gaze.x * 1.6, gaze.y * 1.1, -3);

    vrm.update(dt);   // bone updates, expressions, lookAt, spring physics

    renderer.render(scene, camera);
    } catch (e) { // a transient GPU/context hiccup (e.g. under heavy LLM-on-GPU load) must not freeze the avatar
      if (!frame._warned) { frame._warned = true; console.warn('[face] frame error (recovering):', e?.message || e); }
    }
  }
  requestAnimationFrame(frame);

  function resize() { const s = size(); if (s.w === w && s.h === h) return; w = s.w; h = s.h; camera.aspect = w / h; renderer.setSize(w, h, false); reframe(); }

  return {
    setMouth(v) { level = clamp01(v); },
    setViseme(id) { visTarget = VISEME_VRM[id] || {}; },
    setMood(mood, intensity = 0.6) { const baseM = MOOD_VRM[mood] || {}; const scaled = {}; for (const e in baseM) scaled[e] = baseM[e] * (0.4 + intensity * 0.7); moodTarget = scaled; },
    setGazeTarget(x, y) { gaze.tx = Math.max(-1, Math.min(1, x)); gaze.ty = Math.max(-1, Math.min(1, y)); },
    // when speech stops, force the mouth fully shut: zero the amplitude AND clear the viseme
    // target + current shapes (the viseme term has a 0.25 base, so a lingering visCur would
    // otherwise hold the mouth ~25% open).
    setSpeaking(on) { speaking = !!on; if (!on) { level = 0; openS = 0; visTarget = {}; visCur = {}; } },
    // trigger a showstopper dance on demand (UI button); returns the clip name (e.g. "BabyYou")
    // so the caller can play the matching music, or null if no rare clips are loaded.
    playRare() { if (!rareClips.length) return null; queuedClip = null; const c = nextRareClip(); playClip(c, { fade: 0.4 }); return c.name || null; },
    hasRare() { return rareClips.length > 0; },
    resize,
    dispose() { running = false; try { mixer.stopAllAction(); } catch {} try { VRMUtils.deepDispose?.(vrm.scene); } catch {} renderer.dispose(); },
  };
}
