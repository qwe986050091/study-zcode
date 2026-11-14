// 自检：总行数、anchor 命中次数、注释文本禁词规则
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/code/ZCode';
const specPath = 'D:/code/_annot_baseline/ZC-deep-b58-spec-05.json';
const expectedTotal = 79;

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const forbiddenStart =
  /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const callShape = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

let ok = true;
let total = 0;

for (const f of spec.files) {
  const abs = path.join(ROOT, f.file);
  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split(/\r?\n/);
  let fileTotal = 0;
  for (const item of f.items) {
    const anchor = String(item.anchor ?? '').trim();
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === anchor) hits.push(i);
    }
    const nth = item.nth || 1;
    const uniqueOk = item.nth ? hits.length >= nth : hits.length === 1;
    if (!uniqueOk) {
      console.error(`[ANCHOR FAIL] hits=${hits.length} nth=${nth} :: ${anchor}`);
      ok = false;
    }
    const body = item.raw ? item.raw : item.lines;
    fileTotal += body.length;
    for (const l of body) {
      const t = l.trim();
      if (!item.raw && !t.startsWith('//')) {
        // 非 raw 行由插入器补 "// " 前缀，此处按纯文本校验
      } else if (item.raw && !t.startsWith('//')) {
        console.error(`[NOT COMMENT] ${l}`);
        ok = false;
      }
      if (l.includes('*/')) {
        console.error(`[STAR-SLASH] ${l}`);
        ok = false;
      }
      const text = item.raw ? t.slice(2).trim() : t;
      if (!text) continue;
      if (forbiddenStart.test(text)) {
        console.error(`[FORBIDDEN START] ${l}`);
        ok = false;
      }
      if (text.endsWith(';')) {
        console.error(`[SEMICOLON] ${l}`);
        ok = false;
      }
      if (text.includes('=>')) {
        console.error(`[ARROW] ${l}`);
        ok = false;
      }
      if (callShape.test(text)) {
        console.error(`[CALL SHAPE] ${l}`);
        ok = false;
      }
    }
  }
  total += fileTotal;
  console.log(`${f.file}: items=${f.items.length}, lines=${fileTotal}`);
}

if (total !== expectedTotal) {
  console.error(`[TOTAL FAIL] got ${total}, expected ${expectedTotal}`);
  ok = false;
} else {
  console.log(`[TOTAL OK] ${total}`);
}

console.log(ok ? 'ALL CHECKS PASSED' : 'CHECKS FAILED');
process.exit(ok ? 0 : 1);
