// B77 通用 spec 自检器（raw 按原样校验，不回补 // 前缀）
// 用法：node _check-b77.mjs <spec.json> <relPath> <expectTotal> [expectHeader]
import fs from 'node:fs';

const [specPath, relPath, expectTotalRaw, expectHeaderRaw] = process.argv.slice(2);
const EXPECT_TOTAL = Number(expectTotalRaw);
const EXPECT_HEADER = expectHeaderRaw ? Number(expectHeaderRaw) : 22;
const TARGET_PATH = 'D:/code/ZCode/' + relPath;

const FORBIDDEN =
  /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const CALL_EXPR = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

const errors = [];
const err = (m) => errors.push(m);
const strip = (l) => String(l).replace(/^\/\/\s?/, '').trim();

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
if (!Array.isArray(spec.files) || spec.files.length !== 1) err('spec.files 必须恰好包含 1 个文件');
const entry = spec.files[0];
if (!entry || entry.file !== relPath) err('spec 中 file 路径与目标不一致');

const srcLines = fs.readFileSync(TARGET_PATH, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));
const trimmed = srcLines.map((l) => l.trim());

let totalInserted = 0;
let blockCount = 0;
const usedIndexes = new Map();

const items = entry.items || [];
items.forEach((item, itemIdx) => {
  blockCount += 1;
  const isRaw = Array.isArray(item.raw);
  const outgoing = isRaw ? item.raw : Array.isArray(item.lines) ? item.lines : null;
  if (!outgoing) { err(`item[${itemIdx}] 缺少 raw 或 lines`); return; }
  if (isRaw && Array.isArray(item.lines)) { err(`item[${itemIdx}] 不能同时使用 raw 与 lines`); return; }
  if (typeof item.anchor !== 'string' || item.anchor.trim() === '') { err(`item[${itemIdx}] anchor 为空`); return; }
  if (!isRaw && (outgoing.length < 3 || outgoing.length > 6)) {
    err(`item[${itemIdx}] lines 长度 ${outgoing.length} 不在 3~6`);
  }

  const anchorTrim = item.anchor.trim();
  const matches = [];
  for (let i = 0; i < trimmed.length; i += 1) if (trimmed[i] === anchorTrim) matches.push(i);
  let targetIdx;
  if (item.nth !== undefined) {
    if (!Number.isInteger(item.nth) || item.nth < 1) { err(`item[${itemIdx}] nth 非法: ${item.nth}`); return; }
    if (matches.length < item.nth) { err(`item[${itemIdx}] anchor 命中 ${matches.length} 次，不足 nth=${item.nth}`); return; }
    targetIdx = matches[item.nth - 1];
  } else {
    if (matches.length === 0) { err(`item[${itemIdx}] anchor 未命中: ${anchorTrim}`); return; }
    if (matches.length > 1) { err(`item[${itemIdx}] anchor 命中 ${matches.length} 次（需唯一或 nth）: ${anchorTrim}`); return; }
    targetIdx = matches[0];
  }
  if (targetIdx > 0 && /^\s*\/\//.test(srcLines[targetIdx])) err(`item[${itemIdx}] anchor 指向注释行: ${anchorTrim}`);
  if (usedIndexes.has(targetIdx)) err(`item[${itemIdx}] 插入下标 ${targetIdx} 与 item[${usedIndexes.get(targetIdx)}] 重复`);
  else usedIndexes.set(targetIdx, itemIdx);

  const indent = isRaw ? '' : (/^[ \t]*/.exec(srcLines[targetIdx]) || [''])[0];

  outgoing.forEach((rawLine, lineIdx) => {
    totalInserted += 1;
    if (typeof rawLine !== 'string') { err(`item[${itemIdx}].out[${lineIdx}] 不是字符串`); return; }
    if (rawLine.includes('\n') || rawLine.includes('\r')) err(`item[${itemIdx}].out[${lineIdx}] 含换行`);
    const finalLine = isRaw ? rawLine : rawLine === '' ? `${indent}//` : `${indent}// ${rawLine}`;
    const t = finalLine.trim();
    if (!t.startsWith('//')) err(`item[${itemIdx}].out[${lineIdx}] 不以 // 开头: ${t}`);
    if (t.includes('*/')) err(`item[${itemIdx}].out[${lineIdx}] 含 */`);
    const text = strip(t);
    if (FORBIDDEN.test(text)) err(`item[${itemIdx}].out[${lineIdx}] 以禁止词开头: ${text}`);
    if (text.endsWith(';')) err(`item[${itemIdx}].out[${lineIdx}] 以分号结尾: ${text}`);
    if (text.includes('=>')) err(`item[${itemIdx}].out[${lineIdx}] 含箭头: ${text}`);
    if (CALL_EXPR.test(text)) err(`item[${itemIdx}].out[${lineIdx}] 含调用表达式: ${text}`);
  });
});

const header = items[0];
if (!header || !Array.isArray(header.raw)) {
  err('第一个 item 必须使用 raw 并作为文件头');
} else {
  if (header.raw.length !== EXPECT_HEADER) err(`文件头 raw 长度 ${header.raw.length} != ${EXPECT_HEADER}`);
  if (strip(header.raw[18]) !== '') err(`文件头第 19 行必须是 "//"，实际: ${JSON.stringify(header.raw[18])}`);
  let invCount = 0;
  for (let i = 0; i < 18; i += 1) {
    const want = `INV-${String(i + 1).padStart(2, '0')} `;
    if (!strip(header.raw[i]).startsWith(want)) err(`文件头 INV 序号错位: 期望 ${want}，实际 ${header.raw[i]}`);
    else invCount += 1;
    if (!String(header.raw[i]).includes('守住位置') || !String(header.raw[i]).includes('改错故障')) {
      err(`文件头 INV-${i + 1} 缺少 守住位置/改错故障`);
    }
  }
  if (invCount !== 18) err(`INV 行数 ${invCount} != 18`);
  const tail = header.raw.slice(19, 22);
  if (tail.length !== 3) err('文件头尾部职责说明不足 3 行');
  ['模块职责：', '状态所有权：', '阅读顺序：'].forEach((p, i) => {
    if (!strip(tail[i]).startsWith(p)) err(`文件头第 ${20 + i} 行未以 ${p} 开头: ${tail[i]}`);
  });
  if (header.anchor.trim() !== srcLines[0].trim()) err(`首块 anchor 必须是文件首行: ${header.anchor}`);
}

if (totalInserted !== EXPECT_TOTAL) err(`插入总行数 ${totalInserted} != ${EXPECT_TOTAL}`);

if (errors.length > 0) {
  console.error('FAIL');
  for (const e of errors) console.error(' - ' + e);
  process.exit(1);
}
console.log(`OK blocks=${blockCount} lines=${totalInserted}`);
