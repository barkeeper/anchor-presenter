// inspect-vrma2.mjs — decode actual keyframe data: clip duration + angular range of a few
// bones, to tell whether a clip contains real movement or is effectively static/identity.
import fs from 'fs';
import path from 'path';

const dir = 'assets/vrma';
const files = process.argv.slice(2);

function parseGLB(buf) {
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not GLB');
  let off = 12, json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data; // 'BIN\0'
    off += 8 + len;
  }
  return { json, bin };
}
function readAccessor(gltf, bin, idx) {
  const acc = gltf.accessors[idx];
  const bv = gltf.bufferViews[acc.bufferView];
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const comps = { SCALAR: 1, VEC3: 3, VEC4: 4 }[acc.type];
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    const row = [];
    for (let c = 0; c < comps; c++) row.push(bin.readFloatLE(base + (i * comps + c) * 4));
    out.push(comps === 1 ? row[0] : row);
  }
  return out;
}
const quatAngle = (a, b) => { let d = Math.abs(a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3]); d = Math.min(1, d); return 2 * Math.acos(d) * 180 / Math.PI; };

for (const f of files) {
  try {
    const { json: gltf, bin } = parseGLB(fs.readFileSync(path.join(dir, path.basename(f))));
    const ext = gltf.extensions?.VRMC_vrm_animation;
    const humanBones = ext?.humanoid?.humanBones || {};
    const nodeToBone = {}; for (const [bone, v] of Object.entries(humanBones)) if (typeof v?.node === 'number') nodeToBone[v.node] = bone;
    const anim = gltf.animations[0];
    let duration = 0, hipsTransl = null;
    const report = {};
    for (const ch of anim.channels) {
      const samp = anim.samplers[ch.sampler];
      const bone = nodeToBone[ch.target.node];
      const path_ = ch.target.path;
      const times = readAccessor(gltf, bin, samp.input);
      duration = Math.max(duration, times[times.length - 1] || 0);
      if (['hips', 'leftUpperArm', 'rightUpperArm', 'spine', 'leftLowerLeg'].includes(bone) && path_ === 'rotation') {
        const vals = readAccessor(gltf, bin, samp.output);
        let maxAng = 0; for (const q of vals) maxAng = Math.max(maxAng, quatAngle(vals[0], q));
        report[bone] = `${maxAng.toFixed(1)}° over ${vals.length} keys`;
      }
      if (bone === 'hips' && path_ === 'translation') {
        const vals = readAccessor(gltf, bin, samp.output);
        let dx = 0, dy = 0, dz = 0; const v0 = vals[0];
        for (const v of vals) { dx = Math.max(dx, Math.abs(v[0]-v0[0])); dy = Math.max(dy, Math.abs(v[1]-v0[1])); dz = Math.max(dz, Math.abs(v[2]-v0[2])); }
        hipsTransl = `Δ(${dx.toFixed(3)}, ${dy.toFixed(3)}, ${dz.toFixed(3)})`;
      }
    }
    console.log(`\n=== ${path.basename(f)} ===`);
    console.log(`  duration: ${duration.toFixed(2)}s · hips translation range: ${hipsTransl || '(no translation channel)'}`);
    console.log(`  rotation range: ${Object.entries(report).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  } catch (e) { console.log(`\n=== ${path.basename(f)} ===\n  ERROR: ${e.message}`); }
}
