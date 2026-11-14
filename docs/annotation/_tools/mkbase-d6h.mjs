import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = 'd:\\code\\opensource\\uv';
const rels = ['crates/uv-client/src/registry_client.rs'];
const out = 'd:\\code\\_annot_baseline\\UVR-D6h';
for (const rel of rels) {
  const buf = execFileSync('git', ['-C', repo, 'show', `HEAD:${rel}`], { maxBuffer: 64 * 1024 * 1024 });
  const dest = path.join(out, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log('baseline written', dest, buf.length);
}
fs.writeFileSync(path.join(out, '_files.txt'), rels.join('\n') + '\n');
