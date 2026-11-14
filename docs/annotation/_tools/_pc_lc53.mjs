import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const rel = 'packages/desktop/src/main/browserView/browserScreenshotActivityController.ts';
const orig = fs.readFileSync('D:/code/_annot_baseline/ZC-lc53/orig/' + rel, 'utf8').split(/\r?\n/);
const head = new Set(
  execFileSync('git', ['-C', 'D:/code/ZCode', 'show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split(/\r?\n/)
    .map((l) => l.trim()),
);
console.log('--- orig 282..296（O=OWN, U=UPSTREAM）');
for (let i = 281; i < 296; i++) {
  const t = orig[i].trim();
  console.log(String(i + 1).padStart(4), t.startsWith('//') ? (head.has(t) ? 'U' : 'O') : ' ', t.slice(0, 100));
}
