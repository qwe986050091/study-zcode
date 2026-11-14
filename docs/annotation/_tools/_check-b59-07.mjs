// 自检脚本：校验 spec 的行数、锚点唯一性与注释书写规则
import fs from 'node:fs';

const SPEC = 'D:/code/_annot_baseline/ZC-deep-b59-spec-07.json';
const TARGET = 'D:/code/ZCode/packages/ui/src/store/hooksStore.ts';

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const srcLines = fs.readFileSync(TARGET, 'utf8').split(/\r?\n/);

const BANNED_START = [
  'const', 'let', 'var', 'function', 'class', 'import', 'export', 'return',
  'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'await', 'async',
  'throw', 'new', 'interface', 'type', 'enum',
];

let total = 0;
const errors = [];

for (const f of spec.files) {
  if (f.file.startsWith('ZCode/') || f.file.startsWith('D:') || f.file.includes('\\')) {
    errors.push(`bad file path: ${f.file}`);
  }
  const anchors = new Set();
  for (const item of f.items) {
    const anchor = String(item.anchor ?? '').trim();
    if (!anchor) errors.push('empty anchor');
    const hits = [];
    srcLines.forEach((l, i) => {
      if (l.trim() === anchor) hits.push(i + 1);
    });
    const nth = item.nth || 1;
    if (!item.nth && hits.length !== 1) {
      errors.push(`anchor not unique (${hits.length}): ${anchor}`);
    }
    if (item.nth && hits.length < nth) {
      errors.push(`nth out of range (${hits.length} < ${nth}): ${anchor}`);
    }
    if (anchors.has(anchor)) errors.push(`duplicate anchor in spec: ${anchor}`);
    anchors.add(anchor);

    const texts = item.raw ? item.raw : item.lines;
    if (!Array.isArray(texts) || texts.length === 0) errors.push(`no lines: ${anchor}`);
    total += texts.length;
    // 与插入器一致：非 raw 的文本会被套上 "// "，空串输出为 "//"
    const out = item.raw ? texts : texts.map((t) => (t === '' ? '//' : '// ' + t));

    for (const line of out) {
      if (!line.trim().startsWith('//')) {
        errors.push(`not a comment line: ${line}`);
        continue;
      }
      if (line.includes('*/')) errors.push(`contains */: ${line}`);
      if (line.includes('=>')) errors.push(`contains =>: ${line}`);
      if (line.trim().endsWith(';')) errors.push(`ends with ;: ${line}`);
      const body = line.replace(/^\s*\/\/\s?/, '');
      const first = body.split(/\s+/)[0] ?? '';
      if (BANNED_START.includes(first)) {
        errors.push(`banned leading word "${first}": ${line}`);
      }
      if (/[\w$)\]]\.[\w$]+\(/.test(body)) {
        errors.push(`call-like identifier.identifier(: ${line}`);
      }
    }
  }

  // 文件头必须是第一个 item，且为 raw，位于首条 import 之前
  const first = f.items[0];
  if (!first.raw) errors.push('first item is not raw header');
  if (first.anchor !== 'import { create } from "zustand";') {
    errors.push(`header anchor unexpected: ${first.anchor}`);
  }
  const headerText = first.raw.join('\n');
  const invCount = first.raw.filter((l) => /^\/\/ INV-\d{2} /.test(l)).length;
  if (invCount < 18 || invCount > 20) errors.push(`INV count out of range: ${invCount}`);
  if (!/^\/\/ INV-01 /.test(headerText)) errors.push('header does not start with INV-01');
  const lastLine = first.raw[first.raw.length - 1];
  if (lastLine === '//') errors.push('header must not end with bare // (needs summary lines before it)');
}

if (total < 68 || total > 70) errors.push(`total comment lines ${total} not in 68..70`);
if (total !== 68) errors.push(`total comment lines ${total} != 68 (preferred)`);

console.log(`items=${spec.files[0].items.length} total=${total}`);
if (errors.length) {
  console.log('FAIL');
  for (const e of errors) console.log(' - ' + e);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
