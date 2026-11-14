// 把「落在 /// 文档注释或 #[属性] 之后的新增中文注释块」整体上移到该文档/属性块之上。
// 只移动含中日韩字符的整行 // 注释块，不动任何上游原有注释。
import fs from 'node:fs';

const CJK = /[\u4e00-\u9fff]/;
const isPlain = (l) => {
  const t = l.trim();
  return t.startsWith('//') && !t.startsWith('///') && !t.startsWith('//!');
};
const isDocOrAttr = (l) => {
  const t = l.trim();
  return t.startsWith('///') || t.startsWith('//!') || t.startsWith('#[');
};

for (const file of process.argv.slice(2)) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let moved = 0;
  for (let pass = 0; pass < 200; pass++) {
    let hit = -1;
    for (let i = 1; i < lines.length; i++) {
      if (isPlain(lines[i]) && CJK.test(lines[i]) && isDocOrAttr(lines[i - 1])) {
        hit = i;
        break;
      }
    }
    if (hit < 0) break;
    let k = hit;
    const run = [];
    while (k < lines.length && isPlain(lines[k]) && CJK.test(lines[k])) {
      run.push(lines[k]);
      k++;
    }
    let a = hit - 1;
    while (a >= 0 && isDocOrAttr(lines[a])) a--;
    lines.splice(hit, run.length);
    lines.splice(a + 1, 0, ...run);
    moved += run.length;
  }
  fs.writeFileSync(file, lines.join('\n'));
  console.log(`${file}: moved ${moved} line(s)`);
}
