// UVR-B1 注释插入器：按 JSON 规格在指定锚点行之前插入 `//` 注释，不改动任何原有行。
// 规格格式：[{ file, head?: string[], items: [{ anchor, lines: string[] }] }]
//   - head：插入到文件最前面的注释行（自动加 "// " 前缀；空串写成单独一行 "//"）
//   - items：anchor 必须与某一行（去掉行尾 \r 后）完全相等且全文件唯一，
//            注释按 anchor 的缩进插入，空串写成 "<indent>//"
// 安全约束（fail-closed，任何一条不满足就整体中止，不写文件）：
//   1) 锚点缺失或重复 → 报错退出
//   2) 若锚点上方已经紧邻同样的首行注释，视为已插入，跳过（可重复执行）
//   3) 只做插入，从不删除/替换原有行；写回前再断言行数只增不减
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\uv';
const specPath = process.argv[2];
if (!specPath) {
  console.error('usage: node _uvr_insert.mjs <spec.json>');
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

const prefix = (line, indent) =>
  line === ''
    ? `${indent}//`
    : `${indent}${String(line).trimStart().startsWith("//") ? String(line).trimStart() : `// ${line}`}`;
const prefixHead = (line) =>
  line === '' ? '//' : String(line).trimStart().startsWith("//") ? String(line).trimStart() : `// ${line}`;

let inserted = 0;
let skipped = 0;
const failures = [];

for (const entry of spec) {
  const target = path.isAbsolute(entry.file) ? entry.file : path.join(ROOT, entry.file);
  const original = fs.readFileSync(target, 'utf8');
  const hadTrailingNewline = original.endsWith('\n');
  let lines = original.split('\n');
  if (hadTrailingNewline) lines.pop();
  const beforeCount = lines.length;

  // 先定位所有 items（用原始行号），再整体从下往上插，避免行号漂移
  const jobs = [];
  for (const item of entry.items ?? []) {
    const hits = [];
    if (Number.isInteger(item.line)) {
      // 行号模式：line 为 1-based 原始行号，可选 anchor 作为一致性断言
      const idx = item.line - 1;
      if (idx < 0 || idx >= lines.length) {
        failures.push(`${entry.file}: line out of range: ${item.line}`);
        continue;
      }
      if (item.anchor !== undefined && lines[idx].replace(/\r$/, '') !== item.anchor) {
        failures.push(
          `${entry.file}: line ${item.line} mismatch: ${JSON.stringify(lines[idx])} != ${JSON.stringify(item.anchor)}`,
        );
        continue;
      }
      hits.push(idx);
    } else {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].replace(/\r$/, '') === item.anchor) hits.push(i);
      }
    }
    if (hits.length !== 1) {
      failures.push(`${entry.file}: anchor x${hits.length}: ${JSON.stringify(item.anchor)}`);
      continue;
    }
    const idx = hits[0];
    const indent = (/^[ \t]*/.exec(lines[idx]) || [''])[0];
    const text = item.lines.map((l) => prefix(l, indent));
    // 幂等判定：锚点上方紧邻的整段行与待插入内容完全一致时才跳过，
    // 只比较首行会把“已插入的多行注释”误判成未插入，从而重复插入。
    const already =
      idx >= text.length &&
      text.every((t, k) => lines[idx - text.length + k].replace(/\r$/, '') === t);
    if (already) {
      skipped++;
      continue;
    }
    jobs.push({ idx, text });
  }
  jobs.sort((a, b) => b.idx - a.idx);
  for (const job of jobs) {
    lines.splice(job.idx, 0, ...job.text);
    inserted += job.text.length;
  }

  if (entry.head?.length) {
    const text = entry.head.map(prefixHead);
    if (lines[0]?.replace(/\r$/, '') === text[0]) {
      skipped++;
    } else {
      lines = [...text, ...lines];
      inserted += text.length;
    }
  }

  if (lines.length < beforeCount) {
    failures.push(`${entry.file}: line count shrank (${beforeCount} -> ${lines.length})`);
    continue;
  }
  if (failures.length) continue; // 有失败时不要写任何文件
  fs.writeFileSync(target, lines.join('\n') + (hadTrailingNewline ? '\n' : ''));
  console.log(`OK ${entry.file} (+${lines.length - beforeCount})`);
}

if (failures.length) {
  for (const f of failures) console.error('FAIL ' + f);
  process.exit(1);
}
console.log(`DONE inserted=${inserted} skipped=${skipped}`);
