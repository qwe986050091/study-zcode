// 建立 b5 快照：复制当前未修改的源文件到 ZC-deep-svc-b5/orig，并写 _files.txt。
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
const batchDir = 'D:/code/_annot_baseline/ZC-deep-svc-b5';
const origDir = path.join(batchDir, 'orig');
const roots = [
  'packages/services/src/conversation-share',
  'packages/services/src/settings-sync',
  'packages/services/src/model-provider',
];

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', 'dist', '__tests__', 'fixtures'].includes(ent.name)) continue;
      walk(p, out);
    } else if (ent.isFile() && /\.tsx?$/.test(ent.name)) {
      if (/\.(test|spec)\.tsx?$/.test(ent.name)) continue;
      if (ent.name === 'test-fixture.ts') continue;
      out.push(p);
    }
  }
}

const files = [];
for (const r of roots) walk(path.join(repo, r), files);
const rels = files.map((f) => path.relative(repo, f).replace(/\\/g, '/')).sort();
fs.mkdirSync(origDir, { recursive: true });
for (const rel of rels) {
  const dst = path.join(origDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(repo, rel), dst);
}
fs.writeFileSync(path.join(batchDir, '_files.txt'), rels.join('\n') + '\n', 'utf8');
console.log('snapshot files=' + rels.length);
