import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const repo = 'd:/code/opensource/uv';
const files = fs.readFileSync('d:/code/_annot_baseline/uv-rework/b2-files.txt', 'utf8').split(/\r?\n/).filter((x) => x.startsWith('crates/'));
for (const rel of files) {
  const diff = spawnSync('git', ['-C', repo, 'diff', '-U0', '3d5c8d7', '--', rel], { encoding: 'utf8' }).stdout;
  const raw = diff.split(/\r?\n/).filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  let newLine = 0;
  let ok = 0;
  for (const l of diff.split(/\r?\n/)) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m) { newLine = Number(m[3]); continue; }
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) { ok++; newLine++; }
  }
  if (ok !== raw.length) console.log(`MISMATCH ${rel} raw=${raw.length} parsed=${ok}`);
}
