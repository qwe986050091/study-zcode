// B29 自查：新增行是否合法注释、是否有误写代码行
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/code/ZCode';
const BASE = 'D:/code/_annot_baseline/ZC-deep-b29/orig';
const files = fs.readFileSync('D:/code/_annot_baseline/ZC-deep-b29-files.txt', 'utf8')
  .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

const kw = /^\s*\/\/\s*(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const call = /^\s*\/\/\s*[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+\s*\(.*\)\s*;?\s*$/;
const semi = /;\s*$/;
const arrow = /=>/;

let total = 0;
let bad = 0;
for (const rel of files) {
  const a = fs.readFileSync(path.join(BASE, rel), 'utf8').split(/\r?\n/);
  const b = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
  // 简单 LCS 太重；基线是当前文件的子序列（只插入），用双指针提取新增行
  const added = [];
  let i = 0;
  for (let j = 0; j < b.length; j++) {
    if (i < a.length && b[j] === a[i]) { i++; continue; }
    added.push(b[j]);
  }
  if (i !== a.length) {
    console.log(`[WARN] ${rel}: 基线不是当前文件子序列（可能有删改） i=${i}/${a.length}`);
  }
  const nonComment = added.filter((l) => !l.trim().startsWith('//'));
  const star = added.filter((l) => l.includes('*/'));
  const sus = added.filter((l) => kw.test(l) || call.test(l) || semi.test(l) || arrow.test(l));
  total += added.length;
  bad += nonComment.length + star.length;
  console.log(`[${rel}] added=${added.length} nonComment=${nonComment.length} starSlash=${star.length} suspicious=${sus.length}`);
  for (const s of sus.slice(0, 6)) console.log(`   sus: ${s}`);
  for (const s of nonComment.slice(0, 3)) console.log(`   non: ${s}`);
}
console.log(`TOTAL added=${total} hardBad=${bad}`);
