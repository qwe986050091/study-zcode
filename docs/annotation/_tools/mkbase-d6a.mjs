import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = 'd:\\code\\opensource\\uv';
const rel = 'crates/uv/src/lib.rs';
const out = 'd:\\code\\_annot_baseline\\UVR-D6a';
const buf = execFileSync('git', ['-C', repo, 'show', `HEAD:${rel}`], { maxBuffer: 64 * 1024 * 1024 });
const dest = path.join(out, rel);
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, buf);
fs.writeFileSync(path.join(out, '_files.txt'), rel + '\n');
console.log('baseline written', dest, buf.length);
