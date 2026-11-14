// ZCode 注释插入器（TS/TSX 深注专用）
// 用法：node zc-insert.mjs <spec.json> [file ...]
// spec: { "files": [ { "file": "packages/ui/src/App.tsx", "items": [
//   { "anchor": "<整行 trim 后相等>", "nth": 1, "lines": ["说明", "", "边界"] },
//   { "anchor": "<整行>", "raw": ["// 文件头...", "//"] }
// ] } ] }
// 规则：
//  - anchor 按 trim 后整行相等匹配；默认要求唯一，可用 nth(1-based) 指定第几次出现。
//  - 非 raw：自动套用锚点行缩进 + "// "；空字符串行输出为缩进的 "//"。
//  - raw：按给定行原样插入（用于文件头，统一不以空白缩进）。
//  - 任一锚点不匹配则整批不落盘（先全部计算，后统一写入）。
//  - 插入内容只允许 // 整行注释，禁止出现 */。
//  - poem 门禁：落盘前用 zc-gate 判据自检新增行，命中任一违规则整批不落盘并非零退出。
import fs from 'node:fs';
import path from 'node:path';
import { gateInsertion } from './zc-gate.mjs';

const ROOT = 'D:/code/ZCode';
const specPath = process.argv[2];
const only = process.argv.slice(3);
if (!specPath) {
  console.error('usage: node zc-insert.mjs <spec.json> [file ...]');
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const files = only.length ? spec.files.filter((f) => only.includes(f.file)) : spec.files;

let totalInserted = 0;
const staged = [];

for (const f of files) {
  const abs = path.join(ROOT, f.file);
  if (!fs.existsSync(abs)) {
    console.error(`[FAIL] ${f.file}: file not found`);
    process.exit(1);
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);

  const plan = [];
  for (const item of f.items) {
    const anchor = String(item.anchor ?? '').trim();
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
    const idx = hits[nth - 1];
    let out;
    if (item.raw) {
      out = item.raw;
    } else {
      const indent = /^[ \t]*/.exec(lines[idx])[0];
      out = item.lines.map((t) => (t === '' ? indent + '//' : indent + '// ' + t));
    }
    for (const l of out) {
      if (!l.trim().startsWith('//') || l.includes('*/')) {
        console.error(`[FAIL] ${f.file}: illegal inserted line: ${l}`);
        process.exit(1);
      }
    }
    // shebang 必须是文件首行：文件头锚定首行时插到 shebang 之后。
    const insertIdx = item.raw && idx === 0 && lines[0].startsWith('#!') ? 1 : idx;
    plan.push({ idx: insertIdx, out });
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
  const next = lines.slice();
  let fileInserted = 0;
  for (const p of plan) {
    next.splice(p.idx, 0, ...p.out);
    fileInserted += p.out.length;
  }
  const violations = gateInsertion(lines, next, f.file);
  for (const v of violations) {
    console.error(
      `[GATE] ${f.file}:${v.line}${v.endLine > v.line ? '-' + v.endLine : ''} ${v.kind} ${v.reason} :: ${v.lines.join(' | ')}`,
    );
  }
  staged.push({ abs, text: next.join(eol), file: f.file, blocks: plan.length, inserted: fileInserted, violations });
  totalInserted += fileInserted;
}

const gated = staged.filter((s) => s.violations.length);
if (gated.length) {
  console.error(`GATE FAIL: ${gated.length}/${staged.length} 文件命中注水判据，整批不落盘。`);
  process.exit(1);
}

for (const s of staged) {
  fs.writeFileSync(s.abs, s.text);
  console.log(`[ok] ${s.file}: ${s.blocks} blocks, ${s.inserted} lines`);
}
console.log(`TOTAL inserted ${totalInserted} comment lines`);
