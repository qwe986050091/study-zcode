// 校验任务组里每个 target 在当前文件中「紧邻上方」已有注释。
import fs from 'node:fs';
import path from 'node:path';

const [groupPath, repoRoot] = process.argv.slice(2);
const group = JSON.parse(fs.readFileSync(groupPath, 'utf8'));
let missing = 0;
let checked = 0;
for (const chunk of group.files) {
  const abs = path.join(repoRoot, chunk.file.split('/').join(path.sep));
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  let cursor = 0;
  for (const t of chunk.targets) {
    checked++;
    let hit = -1;
    let seen = 0;
    for (let i = cursor; i < lines.length; i++) {
      if (lines[i].trim() === t.anchor) {
        seen++;
        if (seen === t.occurrence) {
          hit = i;
          break;
        }
      }
    }
    if (hit < 0) {
      console.log(`MISSING_ANCHOR ${chunk.file}:${t.line} ${t.anchor}`);
      missing++;
      continue;
    }
    cursor = hit;
    let ok = false;
    for (let k = hit - 1, gap = 0; k >= 0 && gap <= 2; k--) {
      const s = lines[k].trim();
      if (s === '') {
        gap++;
        continue;
      }
      if (s.startsWith('#[')) continue;
      ok = s.startsWith('//');
      break;
    }
    if (!ok) {
      console.log(`NO_COMMENT ${chunk.file}:${t.line} ${t.anchor}`);
      missing++;
    }
  }
}
console.log(`CHECKED=${checked} MISSING=${missing}`);
process.exitCode = missing ? 1 : 0;
