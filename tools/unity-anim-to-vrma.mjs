// unity-anim-to-vrma.mjs — convert a Unity Humanoid AnimationClip (.anim YAML)
// into a VRMA (.vrma) file: glTF binary + VRMC_vrm_animation extension.
//
// Limitations:
//   • Uses Unity's DEFAULT muscle min/max ranges (the original avatar's calibration
//     isn't accessible from the clip alone), so extreme poses may be over/undershoot.
//   • Finger curves, blend shapes, eye muscles, jaw, and IK target curves are ignored.
//   • Root translation is applied to the hips bone.
//
// Usage: node tools/unity-anim-to-vrma.mjs <input.anim> <output.vrma>
import fs from 'node:fs';

// ---------- Unity default muscle definitions ----------
// Each entry: [muscleName, bone, axis, defaultMin (deg), defaultMax (deg)]
// Sourced from Unity's HumanTrait.MuscleDefaultMin/Max for the standard humanoid avatar.
// Axis is the VRM/glTF rotation axis in the bone's local frame after Unity Mecanim normalization.
const MUSCLES = [
  // Spine / Chest / Neck / Head
  ['Spine Front-Back',          'spine',      'x', -40, 40],
  ['Spine Left-Right',          'spine',      'z', -40, 40],
  ['Spine Twist Left-Right',    'spine',      'y', -40, 40],
  ['Chest Front-Back',          'chest',      'x', -20, 20],
  ['Chest Left-Right',          'chest',      'z', -20, 20],
  ['Chest Twist Left-Right',    'chest',      'y', -20, 20],
  ['UpperChest Front-Back',     'upperChest', 'x', -20, 20],
  ['UpperChest Left-Right',     'upperChest', 'z', -20, 20],
  ['UpperChest Twist Left-Right','upperChest','y', -20, 20],
  ['Neck Nod Down-Up',          'neck',       'x', -40, 40],
  ['Neck Tilt Left-Right',      'neck',       'z', -40, 40],
  ['Neck Turn Left-Right',      'neck',       'y', -40, 40],
  ['Head Nod Down-Up',          'head',       'x', -40, 40],
  ['Head Tilt Left-Right',      'head',       'z', -40, 40],
  ['Head Turn Left-Right',      'head',       'y', -40, 40],

  // Left arm chain
  ['Left Shoulder Down-Up',     'leftShoulder',  'z',  15, -15],
  ['Left Shoulder Front-Back',  'leftShoulder',  'y', -15, 15],
  ['Left Arm Down-Up',          'leftUpperArm',  'z',  60, -100],
  ['Left Arm Front-Back',       'leftUpperArm',  'y', -60, 60],
  ['Left Arm Twist In-Out',     'leftUpperArm',  'x', -90, 90],
  ['Left Forearm Stretch',      'leftLowerArm',  'z',  -80, 80],
  ['Left Forearm Twist In-Out', 'leftLowerArm',  'x', -90, 90],
  ['Left Hand Down-Up',         'leftHand',      'z', -40, 40],
  ['Left Hand In-Out',          'leftHand',      'y', -40, 40],

  // Right arm chain (mirrored)
  ['Right Shoulder Down-Up',    'rightShoulder', 'z', -15, 15],
  ['Right Shoulder Front-Back', 'rightShoulder', 'y',  15, -15],
  ['Right Arm Down-Up',         'rightUpperArm', 'z', -60, 100],
  ['Right Arm Front-Back',      'rightUpperArm', 'y',  60, -60],
  ['Right Arm Twist In-Out',    'rightUpperArm', 'x',  90, -90],
  ['Right Forearm Stretch',     'rightLowerArm', 'z',  80, -80],
  ['Right Forearm Twist In-Out','rightLowerArm', 'x',  90, -90],
  ['Right Hand Down-Up',        'rightHand',     'z',  40, -40],
  ['Right Hand In-Out',         'rightHand',     'y',  40, -40],

  // Left leg
  ['Left Upper Leg Front-Back', 'leftUpperLeg',  'x', -90, 50],
  ['Left Upper Leg In-Out',     'leftUpperLeg',  'z',  60, -60],
  ['Left Upper Leg Twist In-Out','leftUpperLeg', 'y', -60, 60],
  ['Left Lower Leg Stretch',    'leftLowerLeg',  'x',   0, 80],
  ['Left Lower Leg Twist In-Out','leftLowerLeg', 'y', -30, 30],
  ['Left Foot Up-Down',         'leftFoot',      'x', -50, 50],
  ['Left Foot Twist In-Out',    'leftFoot',      'y', -30, 30],

  // Right leg (mirrored)
  ['Right Upper Leg Front-Back','rightUpperLeg', 'x', -90, 50],
  ['Right Upper Leg In-Out',    'rightUpperLeg', 'z', -60, 60],
  ['Right Upper Leg Twist In-Out','rightUpperLeg','y', 60, -60],
  ['Right Lower Leg Stretch',   'rightLowerLeg', 'x',   0, 80],
  ['Right Lower Leg Twist In-Out','rightLowerLeg','y', 30, -30],
  ['Right Foot Up-Down',        'rightFoot',     'x', -50, 50],
  ['Right Foot Twist In-Out',   'rightFoot',     'y',  30, -30],
];

// Humanoid bone hierarchy + approximate VRM-standard rest translations (meters,
// from parent). three-vrm-animation rebinds these to the target VRM, but a coherent
// hierarchy with non-zero offsets is required for the rebinding to work.
// [boneName, parent, [tx,ty,tz]]
const HUMANOID_TREE = [
  ['hips',          null,           [0,    0.95, 0   ]],
  ['spine',         'hips',         [0,    0.10, 0   ]],
  ['chest',         'spine',        [0,    0.15, 0   ]],
  ['upperChest',    'chest',        [0,    0.10, 0   ]],
  ['neck',          'upperChest',   [0,    0.10, 0   ]],
  ['head',          'neck',         [0,    0.08, 0   ]],
  ['leftShoulder',  'upperChest',   [ 0.04, 0.08, 0  ]],
  ['leftUpperArm',  'leftShoulder', [ 0.10, 0,    0  ]],
  ['leftLowerArm',  'leftUpperArm', [ 0.25, 0,    0  ]],
  ['leftHand',      'leftLowerArm', [ 0.25, 0,    0  ]],
  ['rightShoulder', 'upperChest',   [-0.04, 0.08, 0  ]],
  ['rightUpperArm', 'rightShoulder',[-0.10, 0,    0  ]],
  ['rightLowerArm', 'rightUpperArm',[-0.25, 0,    0  ]],
  ['rightHand',     'rightLowerArm',[-0.25, 0,    0  ]],
  ['leftUpperLeg',  'hips',         [ 0.08,-0.05, 0  ]],
  ['leftLowerLeg',  'leftUpperLeg', [ 0,   -0.40, 0  ]],
  ['leftFoot',      'leftLowerLeg', [ 0,   -0.40, 0  ]],
  ['rightUpperLeg', 'hips',         [-0.08,-0.05, 0  ]],
  ['rightLowerLeg', 'rightUpperLeg',[ 0,   -0.40, 0  ]],
  ['rightFoot',     'rightLowerLeg',[ 0,   -0.40, 0  ]],
];
const HUMANOID_BONES = HUMANOID_TREE.map(([n]) => n);

// ---------- minimal YAML extractor for Unity AnimationClip ----------
// Doesn't parse the whole file (it's 540k lines). Instead scans for
// `m_FloatCurves` entries with `attribute: "<muscle name>"` and pulls
// out time/value pairs from the curve keyframes.
function extractCurves(text) {
  const out = new Map(); // attribute -> [{time, value}, ...]

  const wanted = new Set(MUSCLES.map(m => m[0]));
  // Root motion: hips position + body rotation
  for (const c of ['RootT.x','RootT.y','RootT.z','RootQ.x','RootQ.y','RootQ.z','RootQ.w']) wanted.add(c);
  // IK target translations + rotations for hands & feet — needed for legs to move
  // (Mecanim dances often use IK targets, not FK muscles, for legs)
  for (const side of ['Left','Right']) {
    for (const part of ['Hand','Foot']) {
      for (const c of ['T.x','T.y','T.z','Q.x','Q.y','Q.z','Q.w']) wanted.add(`${side}${part}${c}`);
    }
  }

  // Split on each `- curve:` block under `m_FloatCurves`. Each block contains a
  // m_Curve array of keyframes plus an `attribute: <name>` and `path:` field.
  // We scan linearly because the file is huge but flat.
  const blocks = text.split(/\n  - curve:\n/);
  for (let i = 1; i < blocks.length; i++) {
    const blk = blocks[i];
    // attribute can be quoted "Name" or bare Name; cut at end of line/quote
    const aMatch = blk.match(/\n    attribute:\s*"?([^"\n]+?)"?\n/);
    if (!aMatch) continue;
    const attr = aMatch[1].trim();
    if (!wanted.has(attr)) continue;
    const keys = [];
    const keyRx = /\n      - serializedVersion:[\s\S]*?\n        time:\s*([\-0-9.eE]+)\n        value:\s*([\-0-9.eE]+)/g;
    let m; while ((m = keyRx.exec(blk)) !== null) keys.push({ t: +m[1], v: +m[2] });
    if (keys.length) out.set(attr, keys);
  }
  return out;
}

// Sample a piecewise-linear interpolation of {t,v} keyframes at time t.
function sample(keys, t) {
  if (!keys || !keys.length) return 0;
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].v;
  let lo = 0, hi = keys.length - 1;
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (keys[mid].t <= t) lo = mid; else hi = mid; }
  const a = keys[lo], b = keys[hi]; const f = (t - a.t) / (b.t - a.t);
  return a.v + (b.v - a.v) * f;
}

// Muscle normalized value [-1,1] → angle in radians, using Unity's default range.
// Negative muscle uses min, positive uses max; rest at 0.
function muscleToRad(value, minDeg, maxDeg) {
  const deg = value >= 0 ? value * maxDeg : (-value) * minDeg * -1;
  // wait — Unity does: value * (max), then value * (-min) for negative. Cleaner:
  // pose_deg = (value >= 0) ? value * max : value * (-min)
  const v = value >= 0 ? value * maxDeg : value * (-minDeg);
  return v * Math.PI / 180;
}

// Compose XYZ Euler (intrinsic) into a quaternion (glTF/three.js convention)
function eulerXYZToQuat(rx, ry, rz) {
  const c1 = Math.cos(rx / 2), c2 = Math.cos(ry / 2), c3 = Math.cos(rz / 2);
  const s1 = Math.sin(rx / 2), s2 = Math.sin(ry / 2), s3 = Math.sin(rz / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,  // x
    c1 * s2 * c3 - s1 * c2 * s3,  // y
    c1 * c2 * s3 + s1 * s2 * c3,  // z
    c1 * c2 * c3 - s1 * s2 * s3,  // w
  ];
}

// Hamilton quaternion product (xyzw order)
function quatMul(a, b) {
  return [
    a[3]*b[0] + a[0]*b[3] + a[1]*b[2] - a[2]*b[1],
    a[3]*b[1] - a[0]*b[2] + a[1]*b[3] + a[2]*b[0],
    a[3]*b[2] + a[0]*b[1] - a[1]*b[0] + a[2]*b[3],
    a[3]*b[3] - a[0]*b[0] - a[1]*b[1] - a[2]*b[2],
  ];
}
function quatNormalize(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0]/l, q[1]/l, q[2]/l, q[3]/l]; }

// 2-bone analytic IK in a chain (hip→knee→foot or shoulder→elbow→hand).
// Inputs: chain root pos (rest, local to its parent's frame), target pos (same frame),
// upper bone length L1, lower bone length L2, "down" axis for natural bend direction.
// Returns: { upperQuat, lowerQuat } as local rotation quaternions.
// Assumes the chain at rest lies along the negative Y axis (legs hang down; arms hang down).
// The bend axis is +X by default (knee bends forward); pass {bendAxis:'-x'} for opposite.
function twoBoneIK(targetX, targetY, targetZ, L1, L2, bendDir = 1) {
  let dx = targetX, dy = targetY, dz = targetZ;
  let D = Math.hypot(dx, dy, dz);
  const maxR = L1 + L2 - 1e-4;
  const minR = Math.abs(L1 - L2) + 1e-4;
  if (D > maxR) { const s = maxR / D; dx *= s; dy *= s; dz *= s; D = maxR; }
  else if (D < minR) { const s = minR / D; dx *= s; dy *= s; dz *= s; D = minR; }
  // Knee angle (interior angle at knee); π = straight, smaller = more bent
  const cosKnee = (L1*L1 + L2*L2 - D*D) / (2*L1*L2);
  const knee = Math.acos(Math.max(-1, Math.min(1, cosKnee)));
  const kneeBend = Math.PI - knee;          // rotate lower bone by this (around bend axis)

  // Hip pitch: angle between chain at rest (downward, -Y in this frame) and the line
  // from root to a point along the bent chain that reaches the target. We compute the
  // hip→foot direction, then offset by the "half-angle" of the bend along bend axis.
  // Simplest robust approach: rotate the -Y vector to the (dx,dy,dz) direction, then
  // pre-rotate by half the bend offset.
  const tlen = Math.hypot(dx, dy, dz) || 1;
  const tx = dx / tlen, ty = dy / tlen, tz = dz / tlen;
  // angle between (0,-1,0) and (tx,ty,tz)
  const cosA = -ty; // dot((0,-1,0),(tx,ty,tz)) = -ty
  const ang = Math.acos(Math.max(-1, Math.min(1, cosA)));
  // axis is (0,-1,0) × (tx,ty,tz) = (-tz, 0, tx), normalised
  let ax = -tz, ay = 0, az = tx;
  const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
  const sA = Math.sin(ang / 2), cA = Math.cos(ang / 2);
  const aim = [ax * sA, ay * sA, az * sA, cA];

  // Knee bend pre-rotation around +X (forward bend) by half of kneeBend, then a
  // matching post-rotation on the lower bone by the remaining kneeBend.
  const half = kneeBend / 2;
  const preX = [bendDir * Math.sin(half), 0, 0, Math.cos(half)];
  const upperQuat = quatNormalize(quatMul(aim, preX));
  const lowerQuat = [bendDir * Math.sin(kneeBend / 2), 0, 0, Math.cos(kneeBend / 2)];
  return { upperQuat, lowerQuat: quatNormalize(lowerQuat) };
}

// ---------- main ----------
const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) { console.error('usage: node unity-anim-to-vrma.mjs <input.anim> <output.vrma>'); process.exit(2); }

const text = fs.readFileSync(inPath, 'utf8');
const stopTime = parseFloat((text.match(/m_StopTime:\s*([\-0-9.eE]+)/) || [])[1] || '0');
const sampleRate = parseFloat((text.match(/m_SampleRate:\s*([\-0-9.eE]+)/) || [])[1] || '30');
if (!stopTime) { console.error('no m_StopTime'); process.exit(1); }
const curves = extractCurves(text);
console.log(`parsed ${curves.size} curves; duration ${stopTime.toFixed(2)}s @ ${sampleRate}fps`);

// Per-bone muscle list for fast frame composition
const bonePerturb = new Map(); // bone -> [{name, axis, min, max, keys}]
for (const [name, bone, axis, min, max] of MUSCLES) {
  const keys = curves.get(name);
  if (!keys) continue;
  if (!bonePerturb.has(bone)) bonePerturb.set(bone, []);
  bonePerturb.get(bone).push({ axis, min, max, keys });
}
console.log('animated bones:', [...bonePerturb.keys()].join(', '));

// Root translation + rotation curves (apply to hips)
const rtx = curves.get('RootT.x'), rty = curves.get('RootT.y'), rtz = curves.get('RootT.z');
const rqx = curves.get('RootQ.x'), rqy = curves.get('RootQ.y'), rqz = curves.get('RootQ.z'), rqw = curves.get('RootQ.w');
const rootRef = { x: sample(rtx, 0), y: sample(rty, 0), z: sample(rtz, 0) };

// IK target curves for hands/feet — Mecanim normalized humanoid space.
// Hand/foot Q is the target rotation; T is the target translation relative to the root.
const ik = {};
for (const side of ['Left','Right']) for (const part of ['Hand','Foot']) {
  ik[side + part] = {
    tx: curves.get(`${side}${part}T.x`), ty: curves.get(`${side}${part}T.y`), tz: curves.get(`${side}${part}T.z`),
    qx: curves.get(`${side}${part}Q.x`), qy: curves.get(`${side}${part}Q.y`), qz: curves.get(`${side}${part}Q.z`), qw: curves.get(`${side}${part}Q.w`),
  };
}

// Approximate rest positions (relative to root/hips) for IK chain roots, derived from
// HUMANOID_TREE offsets. Used as the "zero" point for foot/hand IK targets.
function chainRestPos(boneName) {
  let pos = [0, 0, 0];
  let cur = boneName;
  while (cur) {
    const e = HUMANOID_TREE.find(([n]) => n === cur);
    if (!e) break;
    pos = [pos[0] + e[2][0], pos[1] + e[2][1], pos[2] + e[2][2]];
    cur = e[1];
  }
  return pos;
}
const restHip = chainRestPos('hips');
const restLeftShoulder = chainRestPos('leftUpperArm');
const restRightShoulder = chainRestPos('rightUpperArm');
const restLeftHip = chainRestPos('leftUpperLeg');
const restRightHip = chainRestPos('rightUpperLeg');
// Chain lengths (from HUMANOID_TREE — they're constant per rig)
const LEG_UPPER = 0.40, LEG_LOWER = 0.40;
const ARM_UPPER = 0.25, ARM_LOWER = 0.25;

const fps = sampleRate;
const frames = Math.max(2, Math.round(stopTime * fps) + 1);
const times = new Float32Array(frames);
for (let i = 0; i < frames; i++) times[i] = i / fps;

// Per-bone quaternion frames + hips translation frames
const boneQuats = new Map();      // bone -> Float32Array(frames*4)
const hipsTrans = new Float32Array(frames * 3);

for (const bone of HUMANOID_BONES) {
  // Even bones with no muscle data get an identity track? skip if no perturbation and not hips.
  if (!bonePerturb.has(bone) && bone !== 'hips') continue;
  boneQuats.set(bone, new Float32Array(frames * 4));
}

// Make sure all four limbs have a quaternion buffer (IK targets drive these even if no muscles do)
for (const b of ['leftUpperArm','leftLowerArm','rightUpperArm','rightLowerArm','leftUpperLeg','leftLowerLeg','rightUpperLeg','rightLowerLeg','leftFoot','rightFoot','leftHand','rightHand','hips']) {
  if (!boneQuats.has(b)) boneQuats.set(b, new Float32Array(frames * 4));
}

for (let f = 0; f < frames; f++) {
  const t = times[f];

  // ---- root translation → hips position (relative to first frame) ----
  hipsTrans[f * 3 + 0] = sample(rtx, t) - rootRef.x;
  hipsTrans[f * 3 + 1] = sample(rty, t) - rootRef.y;
  hipsTrans[f * 3 + 2] = sample(rtz, t) - rootRef.z;

  // ---- per-bone muscle composition (spine/chest/neck/head/arms/legs) ----
  const boneEuler = new Map();
  for (const [bone, perturbs] of bonePerturb) {
    let rx = 0, ry = 0, rz = 0;
    for (const p of perturbs) {
      const v = sample(p.keys, t);
      const ang = muscleToRad(v, p.min, p.max);
      if (p.axis === 'x') rx += ang; else if (p.axis === 'y') ry += ang; else rz += ang;
    }
    boneEuler.set(bone, [rx, ry, rz]);
  }
  function setBoneQuat(bone, q) {
    const arr = boneQuats.get(bone);
    if (!arr) return;
    arr[f * 4 + 0] = q[0]; arr[f * 4 + 1] = q[1]; arr[f * 4 + 2] = q[2]; arr[f * 4 + 3] = q[3];
  }
  for (const [bone, e] of boneEuler) setBoneQuat(bone, eulerXYZToQuat(e[0], e[1], e[2]));

  // ---- root rotation → hips ----
  // Mecanim's RootQ is the whole-body rotation. Apply on top of any spine muscle-driven
  // rotation at the hips (which our muscle table puts on 'spine', not 'hips' — so this
  // is the only thing rotating hips).
  if (rqw && rqw.length) {
    const rq = [sample(rqx, t), sample(rqy, t), sample(rqz, t), sample(rqw, t)];
    setBoneQuat('hips', quatNormalize(rq));
  }

  // ---- foot IK: legs ----
  // Foot target T is in normalized humanoid space relative to root. We approximate by
  // treating it as meters relative to the rest hip position. This is rough but enough
  // to make legs move when a dance pins feet to specific positions.
  function applyLegIK(side, restHipPos, upperBone, lowerBone, footBone) {
    const ikd = ik[side + 'Foot']; if (!ikd.tx) return;
    // foot target world-ish position
    const fx = sample(ikd.tx, t), fy = sample(ikd.ty, t), fz = sample(ikd.tz, t);
    // relative to leg root (hip socket)
    const lx = fx - restHipPos[0], ly = fy - restHipPos[1], lz = fz - restHipPos[2];
    const { upperQuat, lowerQuat } = twoBoneIK(lx, ly, lz, LEG_UPPER, LEG_LOWER, 1);
    setBoneQuat(upperBone, upperQuat);
    setBoneQuat(lowerBone, lowerQuat);
    if (ikd.qw) setBoneQuat(footBone, quatNormalize([sample(ikd.qx, t), sample(ikd.qy, t), sample(ikd.qz, t), sample(ikd.qw, t)]));
  }
  applyLegIK('Left',  restLeftHip,  'leftUpperLeg',  'leftLowerLeg',  'leftFoot');
  applyLegIK('Right', restRightHip, 'rightUpperLeg', 'rightLowerLeg', 'rightFoot');

  // ---- hand IK: arms ----
  function applyArmIK(side, restShoulderPos, upperBone, lowerBone, handBone) {
    const ikd = ik[side + 'Hand']; if (!ikd.tx) return;
    const hx = sample(ikd.tx, t), hy = sample(ikd.ty, t), hz = sample(ikd.tz, t);
    const lx = hx - restShoulderPos[0], ly = hy - restShoulderPos[1], lz = hz - restShoulderPos[2];
    // For arms, the chain at rest also points down (-Y) after our muscle pose; bend axis
    // is opposite for left vs right elbow (elbows bend inward).
    const bend = side === 'Left' ? -1 : 1;
    const { upperQuat, lowerQuat } = twoBoneIK(lx, ly, lz, ARM_UPPER, ARM_LOWER, bend);
    setBoneQuat(upperBone, upperQuat);
    setBoneQuat(lowerBone, lowerQuat);
    if (ikd.qw) setBoneQuat(handBone, quatNormalize([sample(ikd.qx, t), sample(ikd.qy, t), sample(ikd.qz, t), sample(ikd.qw, t)]));
  }
  applyArmIK('Left',  restLeftShoulder,  'leftUpperArm',  'leftLowerArm',  'leftHand');
  applyArmIK('Right', restRightShoulder, 'rightUpperArm', 'rightLowerArm', 'rightHand');
}

// Ensure hips has a quaternion track (identity if no muscles drove it)
if (!boneQuats.has('hips')) boneQuats.set('hips', identityQuats(frames));
function identityQuats(n) { const a = new Float32Array(n * 4); for (let i = 0; i < n; i++) a[i * 4 + 3] = 1; return a; }

// ---------- build glTF JSON + binary buffer ----------
// Layout:
//   nodes: one node per humanoid bone we have. Hierarchy is flat (parent: -1) — VRMA only
//          needs nodes that map to humanoidBones, the *target VRM* supplies the hierarchy.
//          (three-vrm-animation rebinds humanoid bones at clip-creation time.)
//   accessors / bufferViews: time samplers + per-bone rotation samplers + hips translation sampler
//   animation: channels per bone

// Build full hierarchy: every humanoid bone gets a node, even if unanimated.
// Hierarchy node indices follow HUMANOID_TREE order.
const bones = HUMANOID_BONES.slice();
const boneIdx = (b) => bones.indexOf(b);
const nodes = HUMANOID_TREE.map(([name, parent, t]) => {
  const node = { name, translation: t };
  const childNames = HUMANOID_TREE.filter(([, p]) => p === name).map(([n]) => n);
  if (childNames.length) node.children = childNames.map(boneIdx);
  return node;
});
// Ensure boneQuats has identity for any humanoid bone the clip didn't drive
function identityFill() {
  for (const b of HUMANOID_BONES) {
    if (!boneQuats.has(b)) {
      const a = new Float32Array(frames * 4);
      for (let i = 0; i < frames; i++) a[i * 4 + 3] = 1;
      boneQuats.set(b, a);
    }
  }
}
identityFill();

const binChunks = []; const bvList = []; const accList = [];
let byteOffset = 0;

function pushAccessor(typedArray, componentType, type, count, min = null, max = null) {
  // Align to 4 bytes per glTF requirement
  const pad = (4 - (byteOffset % 4)) % 4;
  if (pad) { binChunks.push(new Uint8Array(pad)); byteOffset += pad; }
  const buf = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  const bvIndex = bvList.length;
  bvList.push({ buffer: 0, byteOffset, byteLength: buf.byteLength });
  binChunks.push(buf);
  byteOffset += buf.byteLength;
  const acc = { bufferView: bvIndex, componentType, count, type };
  if (min) acc.min = min; if (max) acc.max = max;
  accList.push(acc);
  return accList.length - 1;
}

// Time accessor (shared by all samplers)
const timeAcc = pushAccessor(times, 5126, 'SCALAR', frames, [0], [times[frames - 1]]);

const samplers = []; const channels = [];

// hips translation channel
{
  const accT = pushAccessor(hipsTrans, 5126, 'VEC3', frames);
  samplers.push({ input: timeAcc, output: accT, interpolation: 'LINEAR' });
  channels.push({ sampler: samplers.length - 1, target: { node: boneIdx('hips'), path: 'translation' } });
}

// rotation channels
for (const b of bones) {
  const quats = boneQuats.get(b);
  const accR = pushAccessor(quats, 5126, 'VEC4', frames);
  samplers.push({ input: timeAcc, output: accR, interpolation: 'LINEAR' });
  channels.push({ sampler: samplers.length - 1, target: { node: boneIdx(b), path: 'rotation' } });
}

const totalBinLen = byteOffset;

const humanoidBones = {};
for (const b of bones) humanoidBones[b] = { node: boneIdx(b) };

const gltf = {
  asset: { version: '2.0', generator: 'unity-anim-to-vrma.mjs' },
  extensionsUsed: ['VRMC_vrm_animation'],
  extensions: {
    VRMC_vrm_animation: {
      specVersion: '1.0',
      humanoid: { humanBones: humanoidBones },
    },
  },
  scene: 0,
  scenes: [{ nodes: [boneIdx('hips')] }],
  nodes,
  buffers: [{ byteLength: totalBinLen }],
  bufferViews: bvList,
  accessors: accList,
  animations: [{
    name: 'LoliKamiRequiem',
    samplers, channels,
  }],
};

// ---------- pack as GLB ----------
const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
const jsonPadded = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]); // pad with spaces
const binBuf = Buffer.concat(binChunks);
const binPad = (4 - (binBuf.length % 4)) % 4;
const binPadded = Buffer.concat([binBuf, Buffer.alloc(binPad, 0)]);

const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546C67, 0);   // "glTF"
header.writeUInt32LE(2, 4);             // version 2
const totalLen = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
header.writeUInt32LE(totalLen, 8);

function chunk(typeAscii, payload) {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(payload.length, 0);
  h.writeUInt32LE(typeAscii, 4);
  return Buffer.concat([h, payload]);
}
const jsonChunk = chunk(0x4E4F534A, jsonPadded); // "JSON"
const binChunk  = chunk(0x004E4942, binPadded);  // "BIN\0"

fs.writeFileSync(outPath, Buffer.concat([header, jsonChunk, binChunk]));
console.log(`wrote ${outPath} (${(totalLen/1024).toFixed(1)} KB, ${frames} frames, ${bones.length} bones)`);
