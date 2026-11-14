// 通用批次自查：新增行是否合法注释、是否混入代码语句
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/code/ZCode';
const [snap, listPath] = process.argv.slice(2);
const BASE = `D:/code/_annot_baseline/${snap}/orig`;
const files = fs.readFileSync(listPath, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

const kw = /^\s*\/\/\s*(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const call = /^\s*\/\/\s*[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+\s*\(.*\)\s*;?\s*$/;
const semi = /;\s*$/;
const arrow = /=>/;

let total = 0;
let hardBad = 0;
let susAll = 0;
for (const rel of files) {
  const a = fs.readFileSync(path.join(BASE, rel), 'utf8').split(/\r?\n/);
  const b = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
  const added = [];
  let i = 0;
  for (let j = 0; j < b.length; j++) {
    if (i < a.length && b[j] === a[i]) { i++; continue; }
    added.push(b[j]);
  }
  if (i !== a.length) console.log(`[WARN] ${rel}: baseline not a subsequence i=${i}/${a.length}`);
  const nonComment = added.filter((l) => !l.trim().startsWith('//'));
  const star = added.filter((l) => l.includes('*/'));
  const sus = added.filter((l) => kw.test(l) || call.test(l) || semi.test(l) || arrow.test(l));
  total += added.length;
  hardBad += nonComment.length + star.length;
  susAll += sus.length;
  console.log(`[${rel}] added=${added.length} nonComment=${nonComment.length} starSlash=${star.length} suspicious=${sus.length}`);
  for (const s of sus.slice(0, 5)) console.log(`   sus: ${s}`);
}
console.log(`TOTAL added=${total} hardBad=${hardBad} suspicious=${susAll}`);
