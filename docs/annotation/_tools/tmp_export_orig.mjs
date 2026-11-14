// 导出批次 orig：从 HEAD 取 blob 写到 <batch>/orig/<rel>，保留 LF。
// 用法：node tmp_export_orig.mjs <batch>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = 'D:/code/_annot_baseline';
const REPO = 'D:/code/opensource/drizzle-orm';
const batch = process.argv[2];
if (!batch) { console.error('usage: node tmp_export_orig.mjs <batch>'); process.exit(2); }
const rels = fs.readFileSync(path.join(BASE, batch, '_files.txt'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
for (const rel of rels) {
  const out = path.join(BASE, batch, 'orig', rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const raw = execFileSync('git', ['-C', REPO, 'show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 1 << 28 });
  fs.writeFileSync(out, raw.replace(/\r\n/g, '\n'), 'utf8');
  console.log('wrote', out);
}
