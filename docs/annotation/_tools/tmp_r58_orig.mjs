// 用 Node 取 HEAD 版本，保留原始字节（避免 PowerShell 加 BOM / 改换行）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const REPO = 'D:/code/opensource/drizzle-orm';
const root = 'D:/code/_annot_baseline/R58';
const files = fs.readFileSync(path.join(root, '_files.txt'), 'utf8').trim().split(/\r?\n/);
for (const f of files) {
  const buf = execFileSync('git', ['-C', REPO, 'show', `HEAD:${f}`], { maxBuffer: 1 << 28 });
  const out = path.join(root, 'orig', f);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
}
console.log('wrote', files.length);
