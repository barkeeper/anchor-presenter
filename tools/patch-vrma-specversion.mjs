// patch-vrma-specversion.mjs — add `specVersion: "1.0"` to the VRMC_vrm_animation extension of
// the rare dance VRMA files, so three-vrm-animation stops warning "specVersion not defined".
import fs from 'fs';
import path from 'path';
const dir = 'assets/vrma';
const files = (process.argv.slice(2).length ? process.argv.slice(2) : ['OtonaBlue', 'BabyYou', 'TocaToca', 'RareDance_3', 'RareDance_5']).map((n) => (n.endsWith('.vrma') ? n : n + '.vrma'));
const JSON_T = 0x4e4f534a, BIN_T = 0x004e4942;

for (const f of files) {
  const fp = path.join(dir, f);
  const buf = fs.readFileSync(fp);
  if (buf.readUInt32LE(0) !== 0x46546c67) { console.log('skip (not GLB):', f); continue; }
  let off = 12, jsonData = null, binData = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4), data = buf.subarray(off + 8, off + 8 + len);
    if (type === JSON_T) jsonData = data; else if (type === BIN_T) binData = data;
    off += 8 + len;
  }
  const json = JSON.parse(jsonData.toString('utf8'));
  const ext = json.extensions?.VRMC_vrm_animation;
  if (!ext) { console.log('no VRMC_vrm_animation:', f); continue; }
  if (ext.specVersion) { console.log('already has specVersion', ext.specVersion + ':', f); continue; }
  ext.specVersion = '1.0';
  let jb = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (jb.length % 4)) % 4; if (pad) jb = Buffer.concat([jb, Buffer.alloc(pad, 0x20)]);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jb.length, 0); jh.writeUInt32LE(JSON_T, 4);
  const parts = [jh, jb];
  if (binData) { const bh = Buffer.alloc(8); bh.writeUInt32LE(binData.length, 0); bh.writeUInt32LE(BIN_T, 4); parts.push(bh, binData); }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + body.length, 8);
  fs.writeFileSync(fp, Buffer.concat([header, body]));
  console.log('patched', f, '-> specVersion 1.0');
}
