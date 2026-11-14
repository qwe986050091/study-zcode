// 注释插入器：按“整行锚点”在指定代码行之前插入 // 注释行。
// 用法：node _rv_insert.mjs <spec.json>
// spec 形如：
// { "files": [ { "file": "raft.go", "items": [ { "anchor": "func (r *raft) step(", "lines": ["说明", ""] } ] } ] }
// - anchor 必须在该文件中「按 trim 后整行相等」唯一命中，否则整批报错不落盘（原子性）。
// - lines 中的每一行由脚本加缩进 + "// "；空串输出为空注释行 "//"，用于分隔。
// - 保留原文件的换行风格（LF/CRLF），不改动任何已有行。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\raft';
const specPath = process.argv[2];
const only = process.argv.slice(3);
if (!specPath) {
  console.error('usage: node _rv_insert.mjs <spec.json> [file ...]');
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
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === anchor) hits.push(i);
    }
    if (hits.length !== 1) {
      console.error(`[FAIL] ${f.file}: anchor hit ${hits.length} times: ${anchor}`);
      process.exit(1);
    }
    let idx = hits[0];
    // 顶层声明（func/type/const/var）若上方已有 godoc，把新注释插到该注释块之上，
    // 保持「已有 godoc 原样、新注释在其上方」；若上方是空行则就地插入。
    if (/^(func|type|const|var)\b/.test(lines[idx].trim())) {
      let j = idx - 1;
      while (j >= 0 && lines[j].trim().startsWith('//') && !lines[j].trim().startsWith('//go:build')) j--;
      if (j < idx - 1) idx = j + 1;
    }
    const indent = /^[ \t]*/.exec(lines[idx])[0];
    plan.push({ idx, indent, lines: item.lines });
  }

  // 从后往前插入，行号不受影响。
  plan.sort((a, b) => b.idx - a.idx);
  for (const p of plan) {
    const out = p.lines.map((t) => (t === '' ? p.indent + '//' : p.indent + '// ' + t));
    lines.splice(p.idx, 0, ...out);
    totalInserted += out.length;
  }
  fs.writeFileSync(abs, lines.join(eol));
  console.log(`[ok] ${f.file}: ${plan.length} blocks, ${plan.reduce((n, p) => n + p.lines.length, 0)} lines`);
}

console.log(`TOTAL inserted ${totalInserted} comment lines`);
