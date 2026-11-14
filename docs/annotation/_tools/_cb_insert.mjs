// 中文注释插入器（Rust / crossbeam 批次）
// 用法：node _cb_insert.mjs <spec.json> [file ...]
// spec: { "files": [ { "file": "crossbeam-queue/src/lib.rs", "items": [
//   { "anchor": "<整行 trim 后相等>", "nth": 1, "lines": ["说明", "", "边界"] },
//   { "anchor": "<整行>", "raw": ["// 文件头...", ""] }
// ] } ] }
// 规则：
//  - anchor 按 trim 后整行相等匹配；默认要求唯一，可用 nth(1-based) 指定第几次出现。
//  - 非 raw：自动套用锚点行缩进 + "// "；空字符串行输出为缩进的 "//"。
//  - 若锚点行是声明，新注释插到其上方既有的 /// 文档与 #[attr] 之上。
//  - 任一锚点不匹配则整批不落盘（原子性）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\crossbeam';
const specPath = process.argv[2];
const only = process.argv.slice(3);
if (!specPath) {
  console.error('usage: node _cb_insert.mjs <spec.json> [file ...]');
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
if (only.length) spec.files = spec.files.filter((f) => only.includes(f.file));

const DECL =
  /^(pub(\([^)]*\))?\s*(unsafe\s*)?(async\s*)?(fn|struct|enum|trait|const|static|type|mod|union)\b|impl\b|unsafe\s+impl\b|macro_rules!\s|#\[)/;

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
    const nth = item.nth || 1;
    if (hits.length < nth || (!item.nth && hits.length !== 1)) {
      console.error(`[FAIL] ${f.file}: anchor hit ${hits.length} times (nth=${nth}): ${anchor}`);
      process.exit(1);
    }
    let idx = hits[nth - 1];
    if (!item.raw) {
      let j = idx - 1;
      while (j >= 0 && /^(#\[|\/\/\/|\/\/!)/.test(lines[j].trim())) j--;
      if (j < idx - 1) idx = j + 1;
    }
    if (item.raw) {
      plan.push({ idx, out: item.raw });
    } else {
      const indent = /^[ \t]*/.exec(lines[idx])[0];
      plan.push({ idx, out: item.lines.map((t) => (t === '' ? indent + '//' : indent + '// ' + t)) });
    }
  }

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
