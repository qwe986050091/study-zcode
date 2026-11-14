// 准备回炉基线快照：从 deep-boilerplate 的 JSON 报告里取受影响文件，
// 按相对路径复制到指定的 pre 快照目录（仅复制，不改仓库）。
// 用法：node uv-rw-prep.mjs <boiler.json> <snapshotDir>
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'd:\\code\\opensource\\uv';
const [jsonPath, snapDir] = process.argv.slice(2);
if (!jsonPath || !snapDir) {
  console.error('usage: node uv-rw-prep.mjs <boiler.json> <snapshotDir>');
  process.exit(2);
}
const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).report;
const files = report.filter((f) => f.groups.length > 0).map((f) => f.file);
const manifest = [];
for (const rel of files) {
  const src = path.join(REPO, rel.split('/').join(path.sep));
  const dst = path.join(snapDir, rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  manifest.push(rel);
}
fs.writeFileSync(path.join(snapDir, '_files.txt'), manifest.join('\n') + '\n');
console.log(`files=${files.length} snapshot=${snapDir}`);
