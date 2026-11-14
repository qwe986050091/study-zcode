// 按「唯一子串 + 可选出现序号」在当前文件中定位锚点，生成 _uvr_insert 规格。
// 用法：node build-d6g.mjs <in.json> <out.json>
// in.json: [{ file?, pick, nth?, lines: string[] }]
// 定位规则：包含 pick 的行；若 nth 省略则必须恰好 1 行，否则取第 nth 行（1-based）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\uv';
const inPath = process.argv[2];
const outPath = process.argv[3];
const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));

const byFile = new Map();
for (const item of raw) {
  const rel = item.file ?? 'crates/uv-workspace/src/workspace.rs';
  if (!byFile.has(rel)) byFile.set(rel, []);
  byFile.get(rel).push(item);
}

const spec = [];
const failures = [];
for (const [rel, items] of byFile) {
  const target = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const lines = fs.readFileSync(target, 'utf8').split('\n');
  const out = [];
  for (const item of items) {
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].replace(/\r$/, '').includes(item.pick)) hits.push(i);
    }
    let idx;
    if (item.nth !== undefined) {
      if (hits.length < item.nth) {
        failures.push(`${rel}: pick not found (nth=${item.nth}, hits=${hits.length}): ${JSON.stringify(item.pick)}`);
        continue;
      }
      idx = hits[item.nth - 1];
    } else if (hits.length === 1) {
      idx = hits[0];
    } else {
      failures.push(`${rel}: ambiguous pick x${hits.length}: ${JSON.stringify(item.pick)}`);
      continue;
    }
    out.push({ line: idx + 1, anchor: lines[idx].replace(/\r$/, ''), lines: item.lines });
    console.log(`${idx + 1}\t${lines[idx].trim().slice(0, 70)}`);
  }
  spec.push({ file: rel, items: out });
}

if (failures.length) {
  for (const f of failures) console.error('FAIL ' + f);
  process.exit(1);
}
fs.writeFileSync(outPath, JSON.stringify(spec, null, 2));
console.log(`SPEC ${outPath} items=${spec.reduce((n, e) => n + e.items.length, 0)}`);
