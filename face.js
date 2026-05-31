// ============================================================
// face.js — three.js WebGPU talking head (Face Cap morph targets)
// Procedurally driven: jaw/lips follow live audio amplitude,
// plus idle blinks, breathing and gentle sway. No baked clip.
// ============================================================
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const lerp = (a, b, t) => a + (b - a) * t;

export async function createFace({ canvas, modelUrl, basisPath }) {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  await renderer.init();

  const size = () => ({ w: canvas.clientWidth || 1, h: canvas.clientHeight || 1 });
  let { w, h } = size();
  renderer.setSize(w, h, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, w / h, 0.1, 20);

  const env = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(env, 0.02).texture;

  renderer.toneMappingExposure = 1.0;
  // a touch of key + rim light on top of the IBL
  const key = new THREE.DirectionalLight(0xfff2dd, 1.1); key.position.set(1.2, 1.4, 2.2); scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fe9ff, 0.55); rim.position.set(-1.6, 0.6, -1.4); scene.add(rim);

  const ktx2 = await new KTX2Loader().setTranscoderPath(basisPath).detectSupport(renderer);

  const gltf = await new GLTFLoader()
    .setKTX2Loader(ktx2)
    .setMeshoptDecoder(MeshoptDecoder)
    .loadAsync(modelUrl);

  const root = gltf.scene.children[0];
  scene.add(root);

  const head = root.getObjectByName('mesh_2');
  const dict = head.morphTargetDictionary || {};
  const infl = head.morphTargetInfluences || [];

  // resolve ARKit blendshape indices (keys look like "blendShape1.jawOpen")
  const find = (name) => {
    for (const k in dict) if (k === name || k.endsWith('.' + name)) return dict[k];
    return -1;
  };
  const idx = {
    jawOpen:       find('jawOpen'),
    mouthClose:    find('mouthClose'),
    mouthFunnel:   find('mouthFunnel'),
    mouthPucker:   find('mouthPucker'),
    mouthSmileL:   find('mouthSmileLeft'),
    mouthSmileR:   find('mouthSmileRight'),
    mouthStretchL: find('mouthStretchLeft'),
    mouthStretchR: find('mouthStretchRight'),
    blinkL:        find('eyeBlinkLeft'),
    blinkR:        find('eyeBlinkRight'),
    browInner:     find('browInnerUp'),
    browOuterL:    find('browOuterUpLeft'),
    browOuterR:    find('browOuterUpRight'),
  };
  const set = (i, v) => { if (i >= 0) infl[i] = v; };

  // framing — fit the whole head from the front, robust to model scale
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const sz = box.getSize(new THREE.Vector3());
  function reframe() {
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const fitH = (sz.y * 1.3) / (2 * Math.tan(fov / 2));
    const fitW = (sz.x * 1.3) / (2 * Math.tan(fov / 2)) / camera.aspect;
    const dist = Math.max(fitH, fitW);
    camera.position.set(center.x, center.y + sz.y * 0.02, center.z + dist);
    camera.lookAt(center.x, center.y, center.z);
    camera.updateProjectionMatrix();
  }
  reframe();

  // ---- animation state ----
  let mouth = 0, mouthTarget = 0;     // 0..1 driven by audio
  let speaking = false;
  let blink = 0, nextBlink = performance.now() + 1500 + Math.random() * 2500;
  const clock = new THREE.Clock();
  let running = true;

  function frame() {
    if (!running) return;
    const t = clock.getElapsedTime();
    const dt = Math.min(clock.getDelta?.() ?? 0.016, 0.05);

    // mouth follows audio with quick attack, slower release
    const k = mouthTarget > mouth ? 0.55 : 0.28;
    mouth = lerp(mouth, mouthTarget, k);
    if (!speaking) mouthTarget *= 0.6;

    const m = mouth;
    set(idx.jawOpen, m * 0.85);
    set(idx.mouthClose, (1 - m) * 0.06);
    // vowel-ish colour: alternate funnel / stretch with a slow LFO so it isn't a flat flap
    const vow = (Math.sin(t * 9.0) * 0.5 + 0.5);
    set(idx.mouthFunnel, m * vow * 0.35);
    set(idx.mouthPucker, m * vow * 0.18);
    set(idx.mouthStretchL, m * (1 - vow) * 0.30);
    set(idx.mouthStretchR, m * (1 - vow) * 0.30);
    // faint resting smile so it isn't grim
    set(idx.mouthSmileL, 0.10 + m * 0.05);
    set(idx.mouthSmileR, 0.10 + m * 0.05);

    // blinks
    const now = performance.now();
    if (now > nextBlink) { blink = 1; nextBlink = now + 220; }
    if (blink > 0 && now > nextBlink - 120) blink = Math.max(0, blink - dt * 9);
    if (blink === 0 && now > nextBlink && now < nextBlink + 30) nextBlink = now + 1800 + Math.random() * 3200;
    const b = Math.sin(Math.min(blink, 1) * Math.PI);
    set(idx.blinkL, b); set(idx.blinkR, b);

    // brows lift slightly while talking + idle drift
    const brow = 0.05 + m * 0.18 + Math.sin(t * 0.7) * 0.03;
    set(idx.browInner, brow);
    set(idx.browOuterL, brow * 0.6); set(idx.browOuterR, brow * 0.6);

    // gentle living sway / breathing
    root.rotation.y = Math.sin(t * 0.45) * 0.05 + (speaking ? Math.sin(t * 2.3) * 0.012 : 0);
    root.rotation.x = Math.sin(t * 0.6) * 0.02;
    root.position.y = Math.sin(t * 1.1) * 0.004;

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  clock.getDelta(); // prime
  requestAnimationFrame(frame);

  function resize() {
    const s = size();
    if (s.w === w && s.h === h) return;
    w = s.w; h = s.h;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    reframe();
  }

  return {
    /** level: 0..1 from the audio analyser */
    setMouth(level) { mouthTarget = Math.max(0, Math.min(1, level)); },
    setSpeaking(on) { speaking = !!on; if (!on) mouthTarget = 0; },
    resize,
    dispose() { running = false; renderer.dispose(); },
  };
}
