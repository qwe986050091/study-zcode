// 把 R58c 的 5 个文件统一回 CRLF（Edit 插入的行带了裸 LF）
import fs from 'node:fs';
const files = fs.readFileSync('d:/code/_annot_baseline/R58c/_files.txt', 'utf8').split(/\r?\n/).filter(Boolean);
for (const f of files) {
  const p = 'd:/code/opensource/drizzle-orm/' + f;
  const s = fs.readFileSync(p, 'utf8');
  const out = s.replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(p, out, 'utf8');
  console.log('normalized', f, s.length, '->', out.length);
}
