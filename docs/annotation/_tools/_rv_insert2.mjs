// 注释插入器 v2：支持「原样行」插入（可自带 "// " 前缀与空行），用于文件头。
// 用法：node _rv_insert2.mjs <spec.json> [file ...]
// spec: { "files": [ { "file": "quorum/quorum.go", "items": [
//   { "anchor": "package quorum", "raw": ["// 说明...", ""] },
//   { "anchor": "func (c MajorityConfig) CommittedIndex(l AckedIndexer) Index",
//     "lines": ["职责...", "", "边界..."] }   // 非 raw：自动缩进 + "// "
// ] } ] }
// - anchor 按 trim 后整行相等匹配，必须唯一，否则整批不落盘（原子性）。
// - 非 raw 且锚点是顶层声明时，新注释插到既有 godoc 块之上（godoc 原样保留）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\raft';
const specPath = process.argv[2];
const only = process.argv.slice(3);
if (!specPath) {
  console.error('usage: node _rv_insert2.mjs <spec.json> [file ...]');
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
if (only.length) spec.files = spec.files.filter((f) => only.includes(f.file));

let totalInserted = 0;

for (const f of spec.files) {
  const abs = path.join(ROOT, f.file);
  const raw = fs.readFileSync(abs, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);

  const plan = [];
  for (const item of f.items) {
    const anchor = item.anchor.trim();
    if (!anchor) {
      console.error(`[FAIL] ${f.file}: empty anchor`);
      process.exit(1);
    }
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === anchor) hits.push(i);
    }
    if (hits.length !== 1) {
      console.error(`[FAIL] ${f.file}: anchor hit ${hits.length} times: ${anchor}`);
      process.exit(1);
    }
    let idx = hits[0];
    if (!item.raw && /^(func|type|const|var)\b/.test(lines[idx].trim())) {
      let j = idx - 1;
      while (j >= 0 && lines[j].trim().startsWith('//') && !lines[j].trim().startsWith('//go:build')) j--;
      if (j < idx - 1) idx = j + 1;
    }
    if (item.raw) {
      plan.push({ idx, out: item.raw });
    } else {
      const indent = /^[ \t]*/.exec(lines[idx])[0];
      plan.push({ idx, out: item.lines.map((t) => (t === '' ? indent + '//' : indent + (String(t).trimStart().startsWith('//') ? String(t).trimStart() : '// ' + t))) });
    }
  }

  // 检查插入点唯一，避免两个 item 落在同一行导致顺序歧义。
  const seen = new Set();
  for (const p of plan) {
    if (seen.has(p.idx)) {
      console.error(`[FAIL] ${f.file}: duplicate insert index ${p.idx}`);
      process.exit(1);
    }
    seen.add(p.idx);
  }

  plan.sort((a, b) => b.idx - a.idx);
  for (const p of plan) {
    lines.splice(p.idx, 0, ...p.out);
    totalInserted += p.out.length;
  }
  fs.writeFileSync(abs, lines.join(eol));
  console.log(`[ok] ${f.file}: ${plan.length} blocks, ${plan.reduce((n, p) => n + p.out.length, 0)} lines`);
}

console.log(`TOTAL inserted ${totalInserted} comment lines`);
