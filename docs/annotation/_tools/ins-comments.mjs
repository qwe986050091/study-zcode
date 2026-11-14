#!/usr/bin/env node
// 批量插入整行注释：spec = { file, entries: [{ line, expect, text }] }
// line 为插入前文件的 1-based 行号；expect 为目标行去掉首尾空白后的前缀，用于防漂移。
// 从下往上插入，同一位置重复执行幂等（上方已有同文注释则跳过）。
import fs from 'node:fs';

const specPath = process.argv[2];
if (!specPath) {
    console.error('usage: node ins-comments.mjs <spec.json>');
    process.exit(2);
}
const parsed = JSON.parse(fs.readFileSync(specPath, 'utf8').replace(/^\uFEFF/, ''));
for (const spec of Array.isArray(parsed) ? parsed : [parsed]) applyOne(spec);

function applyOne(spec) {
const file = spec.file;
// 保留原文件行尾：CRLF 文件若被 join('\n') 重写，会整文件变成 LF，污染 token 校验。
const raw = fs.readFileSync(file, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(/\r?\n/);
const entries = [...spec.entries].sort((a, b) => b.line - a.line);

const indentOf = s => /^(\s*)/.exec(s)[1];
let inserted = 0;
let skipped = 0;
const errors = [];
for (const e of entries) {
    const idx = e.line - 1;
    const target = lines[idx];
    if (target === undefined) {
        errors.push(`line ${e.line}: 不存在`);
        continue;
    }
    if (e.expect && !target.trim().startsWith(e.expect)) {
        errors.push(`line ${e.line}: 期望 ${JSON.stringify(e.expect)} 实际 ${JSON.stringify(target.trim().slice(0, 80))}`);
        continue;
    }
    if (!e.text || /[\r\n]/.test(e.text)) {
        errors.push(`line ${e.line}: 注释文本为空或含换行`);
        continue;
    }
    const indent = indentOf(target);
    const comment = `${indent}// ${e.text}`;
    if (lines[idx - 1]?.trim() === comment.trim()) {
        skipped++;
        continue;
    }
    lines.splice(idx, 0, comment);
    inserted++;
}
if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
}
fs.writeFileSync(file, lines.join(eol), 'utf8');
console.log(`OK ${file}: inserted=${inserted} skipped=${skipped}`);
}
