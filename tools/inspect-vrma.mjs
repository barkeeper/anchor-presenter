// inspect-vrma.mjs — parse each .vrma (GLB) and report its VRMC_vrm_animation extension
// (specVersion + humanoid bone mapping) and animation channel targets, so we can see why
// some clips don't drive the model.
import fs from 'fs';
import path from 'path';

const dir = 'assets/vrma';
const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(dir).filter((f) => f.endsWith('.vrma'));

function parseGLB(buf) {
  // 12-byte header: magic, version, length; then chunks (len, type, data)
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error('not a GLB');
  let off = 12;
  let json = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off); const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8')); // 'JSON'
    off += 8 + len;
  }
  return json;
}

for (const f of files) {
  const full = path.join(dir, path.basename(f));
  try {
    const buf = fs.readFileSync(full);
    const gltf = parseGLB(buf);
    const ext = gltf.extensions?.VRMC_vrm_animation;
    const nodes = gltf.nodes || [];
    const anims = gltf.animations || [];
    // map node index -> humanoid bone name (from the VRM animation humanoid mapping)
    const humanBones = ext?.humanoid?.humanBones || {};
    const nodeToBone = {};
    for (const [bone, v] of Object.entries(humanBones)) if (v && typeof v.node === 'number') nodeToBone[v.node] = bone;
    // which humanoid bones do the animation channels actually target?
    const targetedBones = new Set();
    let totalChannels = 0, expressionCh = 0, lookAtCh = 0;
    for (const a of anims) {
      for (const ch of (a.channels || [])) {
        totalChannels++;
        const n = ch.target?.node;
        if (nodeToBone[n]) targetedBones.add(nodeToBone[n]);
        // VRMA may also have expression/lookat channels via pointer extension
        if (ch.target?.path === undefined) {/* pointer-based */}
      }
    }
    console.log(`\n=== ${path.basename(f)} ===`);
    console.log(`  ext present: ${!!ext} · specVersion: ${ext?.specVersion ?? '(none)'}`);
    console.log(`  extensionsUsed: ${(gltf.extensionsUsed || []).join(', ') || '(none)'}`);
    console.log(`  nodes: ${nodes.length} · animations: ${anims.length} · channels: ${totalChannels}`);
    console.log(`  humanBones mapped: ${Object.keys(humanBones).length} · bones actually animated: ${targetedBones.size}`);
    console.log(`  animated bones: ${[...targetedBones].sort().join(', ') || '(NONE — clip will not move the body!)'}`);
  } catch (e) {
    console.log(`\n=== ${path.basename(f)} ===\n  ERROR parsing: ${e.message}`);
  }
}
