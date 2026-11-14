// 校验 ZC-deep-b67-spec-11.json：anchor 存在性、总行数 66、注释行禁用模式。
// 用法：node _check-b67-11.mjs
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
const specPath = 'D:/code/_annot_baseline/ZC-deep-b67-spec-11.json';
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

const FORBIDDEN = /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const CALL = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const problems = [];
const fail = (msg) => problems.push(msg);

if (!Array.isArray(spec.files) || spec.files.length !== 1) {
  fail(`文件项数量应为 1，实际 ${Array.isArray(spec.files) ? spec.files.length : 'N/A'}`);
}

let total = 0;
for (const entry of spec.files ?? []) {
  const abs = path.join(repo, entry.file);
  if (!fs.existsSync(abs)) {
    fail(`文件不存在：${abs}`);
    continue;
  }
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  const firstLine = lines[0].trim();
  const items = entry.items ?? [];

  if (!items.length) fail('items 为空');
  const firstAnchor = (items[0]?.anchor ?? '').trim();
  if (firstAnchor !== firstLine) {
    fail(`首项 anchor 与文件首行不一致：${JSON.stringify(firstAnchor)} != ${JSON.stringify(firstLine)}`);
  }
  if ((items[0]?.raw ?? []).length !== 22) {
    fail(`首项 raw 行数应为 22，实际 ${(items[0]?.raw ?? []).length}`);
  }

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const rows = item.raw ?? item.lines ?? [];
    if (item.raw && item.lines) fail(`第 ${idx + 1} 项同时含 raw 与 lines`);
    if (!rows.length) fail(`第 ${idx + 1} 项没有注释行`);
    total += rows.length;

    const anchor = (item.anchor ?? '').trim();
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === anchor) hits.push(i + 1);
    }
    if (item.nth !== undefined) {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
        fail(`nth 非法：第 ${idx + 1} 项 nth=${item.nth}，命中 ${hits.length} 处`);
      }
    } else if (hits.length !== 1) {
      fail(`${hits.length === 0 ? 'anchor 不存在' : `anchor 不唯一(${hits.length})`}：第 ${idx + 1} 项 ${JSON.stringify(anchor)}`);
    }

    for (const line of rows) {
      const t = line.trim();
      if (line.includes('*/')) fail(`含 */：第 ${idx + 1} 项 ${JSON.stringify(line)}`);
      if (FORBIDDEN.test(t)) fail(`以禁词开头：第 ${idx + 1} 项 ${JSON.stringify(line)}`);
      if (t.endsWith(';')) fail(`以分号结尾：第 ${idx + 1} 项 ${JSON.stringify(line)}`);
      if (t.includes('=>')) fail(`含 =>：第 ${idx + 1} 项 ${JSON.stringify(line)}`);
      if (CALL.test(t)) fail(`含调用表达式：第 ${idx + 1} 项 ${JSON.stringify(line)}`);
      if (item.raw && !t.startsWith('//')) fail(`raw 行未以 // 开头：${JSON.stringify(line)}`);
    }
  }
}

if (total !== 66) fail(`总行数应为 66，实际 ${total}`);

if (problems.length) {
  console.log(`CHECK FAIL ${problems.length}`);
  for (const p of problems) console.log(' - ' + p);
  process.exit(1);
}
console.log(`OK 文件 1 个，块 ${spec.files[0].items.length} 个，总行数 ${total}`);
