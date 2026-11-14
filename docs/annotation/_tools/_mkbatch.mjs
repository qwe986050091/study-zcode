// 创建批次基线：node _mkbatch.mjs <batch> <rel1,rel2,...>
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'd:/code/_annot_baseline';
const REPO = 'd:/code/opensource/gemini-cli';
const [batch, list] = process.argv.slice(2);
if (!batch || !list) { console.error('usage: node _mkbatch.mjs <batch> <rel1,rel2,...>'); process.exit(2); }
const rels = list.split(',').map((s) => s.trim()).filter(Boolean);
const dir = path.join(BASE, batch);
fs.mkdirSync(path.join(dir, 'orig'), { recursive: true });
const lines = [];
for (const rel of rels) {
  const src = path.join(REPO, rel);
  if (!fs.existsSync(src)) { console.error('MISSING ' + rel); process.exit(1); }
  const dst = path.join(dir, 'orig', rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  const total = fs.readFileSync(src, 'utf8').split(/\r?\n/).length;
  lines.push(`${rel}\t${total}`);
}
fs.writeFileSync(path.join(dir, '_files.txt'), lines.join('\n') + '\n');
console.log(`OK ${batch} files=${rels.length}`);
