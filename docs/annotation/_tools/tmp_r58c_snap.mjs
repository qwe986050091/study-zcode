// 建立 R58c 批次：5 个修正行文件，orig 取 HEAD 原始字节
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const ROOT = 'd:/code/opensource/drizzle-orm';
const OUT = 'd:/code/_annot_baseline/R58c';
const files = [
  'drizzle-kit/src/cli/selector-ui.ts',
  'drizzle-kit/src/cli/views.ts',
  'drizzle-kit/src/serializer/pgSerializer.ts',
  'drizzle-kit/src/serializer/mysqlSerializer.ts',
  'drizzle-kit/src/serializer/sqliteSerializer.ts',
];
fs.mkdirSync(path.join(OUT, 'orig'), { recursive: true });
fs.writeFileSync(path.join(OUT, '_files.txt'), files.join('\n') + '\n', 'utf8');
for (const f of files) {
  const buf = execFileSync('git', ['-C', ROOT, 'show', 'HEAD:' + f], { maxBuffer: 64 * 1024 * 1024 });
  const dst = path.join(OUT, 'orig', f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, buf);
}
console.log('created', files.length, 'orig snapshots');
