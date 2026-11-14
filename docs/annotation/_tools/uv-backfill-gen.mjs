// 把 2,755 个 C 类（可注释产品代码）未覆盖单元切成任务组，供逐组补注。
import fs from 'node:fs';
import path from 'node:path';

const [cJson, repoRoot, outDir] = process.argv.slice(2);
const all = JSON.parse(fs.readFileSync(cJson, 'utf8')).filter((u) => u.cat === 'C');
fs.mkdirSync(outDir, { recursive: true });

const byFile = new Map();
for (const u of all) {
  if (!byFile.has(u.file)) byFile.set(u.file, []);
  byFile.get(u.file).push(u);
}

const chunks = [];
for (const [file, list] of byFile) {
  list.sort((a, b) => a.line - b.line);
  const lines = fs.readFileSync(path.join(repoRoot, file.split('/').join(path.sep)), 'utf8').split(/\r?\n/);
  const seen = new Map();
  const resolved = [];
  let prevIdx = -1;
  for (const u of list) {
    const anchor = lines[u.line - 1].trim();
    if (!anchor) throw new Error(`empty anchor ${file}:${u.line}`);
    const curIdx = u.line - 1;
    let n = 0;
    for (let k = Math.max(0, prevIdx); k < curIdx; k++) {
      if (lines[k].trim() === anchor) n++;
    }
    resolved.push({ line: u.line, anchor, occurrence: n + 1 });
    prevIdx = curIdx;
  }
  for (let i = 0; i < resolved.length; i += 280) {
    chunks.push({ file, targets: resolved.slice(i, i + 280) });
  }
}

// 贪心装组：每组 ≤290 个 target，文件不跨组拆散（chunk 已按文件切好）
const groups = [];
let cur = { targets: 0, files: [] };
for (const c of chunks) {
  if (cur.targets + c.targets.length > 290 && cur.files.length) {
    groups.push(cur);
    cur = { targets: 0, files: [] };
  }
  cur.files.push(c);
  cur.targets += c.targets.length;
}
if (cur.files.length) groups.push(cur);

for (let g = 0; g < groups.length; g++) {
  const name = `g${String(g + 1).padStart(2, '0')}.json`;
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(groups[g], null, 1), 'utf8');
  console.log(`${name}\ttargets=${groups[g].targets}\tfiles=${groups[g].files.map((f) => f.file.split('/').pop() + ':' + f.targets.length).join(',')}`);
}
console.log(`total=${all.length} chunks=${chunks.length} groups=${groups.length}`);
