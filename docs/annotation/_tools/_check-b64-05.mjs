// 干跑校验：ZC-deep-b64-spec-05 的注释插入规格，不写仓库文件。
// 用法：node _check-b64-05.mjs
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
const specPath = path.join('D:/code/_annot_baseline', 'ZC-deep-b64-spec-05.json');
const EXPECTED_LINES = 67;
const BANNED_START = /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const CALL_EXPR = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const problems = [];
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

if (!Array.isArray(spec.files) || spec.files.length !== 1) {
  problems.push(`单文件约束失败：files 长度为 ${Array.isArray(spec.files) ? spec.files.length : '非数组'}`);
}

let total = 0;
for (const f of spec.files) {
  const abs = path.join(repo, f.file);
  if (!fs.existsSync(abs)) {
    problems.push(`文件不存在：${f.file}`);
    continue;
  }
  const fileLines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  const items = Array.isArray(f.items) ? f.items : [];
  if (items.length === 0) problems.push(`items 为空：${f.file}`);

  items.forEach((item, index) => {
    const body = Array.isArray(item.raw) ? item.raw : item.lines;
    if (!Array.isArray(body) || body.length === 0) {
      problems.push(`第 ${index + 1} 项缺少 raw/lines`);
      return;
    }
    total += body.length;

    const anchor = String(item.anchor ?? '').trim();
    const hits = [];
    fileLines.forEach((line, i) => {
      if (line.trim() === anchor) hits.push(i + 1);
    });
    const nth = item.nth ?? 1;
    if (hits.length === 0) {
      problems.push(`第 ${index + 1} 项 anchor 不存在：${anchor}`);
    } else if (!Number.isInteger(nth) || nth < 1 || nth > hits.length) {
      problems.push(`第 ${index + 1} 项 nth 非法：${nth}，命中 ${hits.length} 处`);
    } else if (hits.length > 1 && item.nth === undefined) {
      problems.push(`第 ${index + 1} 项 anchor 不唯一且未给 nth：命中 ${hits.join(',')}`);
    }

    if (index === 0 && anchor !== fileLines[0].trim()) {
      problems.push(`第一项 anchor 不是文件首行：${anchor}`);
    }
    if (index === 0 && body.length !== 22) {
      problems.push(`第一项应为 22 行，实际 ${body.length}`);
    }

    body.forEach((rawLine, li) => {
      const line = String(rawLine);
      const where = `第 ${index + 1} 项第 ${li + 1} 行`;
      if (line.includes('*/')) problems.push(`${where} 含 */：${line}`);
      if (/\s$/.test(line)) problems.push(`${where} 行尾有空白：${line}`);
      if (line.trimEnd().endsWith(';')) problems.push(`${where} 以分号结尾：${line}`);
      if (line.includes('=>')) problems.push(`${where} 含箭头：${line}`);
      if (CALL_EXPR.test(line)) problems.push(`${where} 含方法调用表达式：${line}`);
      if (item.raw && !line.startsWith('//')) problems.push(`${where} raw 行不是注释：${line}`);
      const content = item.raw ? line.replace(/^\/\/ ?/, '') : line.trimStart();
      if (BANNED_START.test(content)) problems.push(`${where} 以禁词开头：${line}`);
    });
  });
}

if (total !== EXPECTED_LINES) {
  problems.push(`总行数应为 ${EXPECTED_LINES}，实际 ${total}`);
}

if (problems.length) {
  console.log(`CHECK FAIL ${problems.length}`);
  for (const p of problems) console.log(`- ${p}`);
  process.exit(1);
}
console.log(`OK total=${total} files=${spec.files.length}`);
