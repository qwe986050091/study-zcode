// 阳性对照脚手架（一次性）：造一个临时 git 仓库，
// 让 HEAD = ZCode 上游快照、工作区 = 删除前（orig）版本，
// 从而在完全相同的 OWN/UPSTREAM 判定条件下回放已知真阳性。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ZC = 'D:/code/ZCode';
const PC = 'D:/code/_annot_baseline/_pc-dups';
const files = [
  ['packages/desktop/src/main/index.ts', 'D:/code/_annot_baseline/ZC-lc51/orig'],
  ['packages/desktop/src/main/browserView/browserScreenshotActivityController.ts', 'D:/code/_annot_baseline/ZC-lc53/orig'],
];

fs.rmSync(PC, { recursive: true, force: true });
for (const [rel] of files) fs.mkdirSync(path.join(PC, path.dirname(rel)), { recursive: true });

// 1) HEAD = 上游快照
for (const [rel] of files) {
  const txt = execFileSync('git', ['-C', ZC, 'show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(path.join(PC, rel), txt);
}
const git = (...a) => execFileSync('git', ['-C', PC, ...a], { encoding: 'utf8' });
git('init', '-q');
git('add', '.');
git('-c', 'user.name=pc', '-c', 'user.email=pc@local', 'commit', '-q', '-m', 'upstream-snapshot');

// 2) 工作区 = 删除前版本（含已知重复）
for (const [rel, origDir] of files) {
  fs.copyFileSync(path.join(origDir, rel), path.join(PC, rel));
}

fs.writeFileSync('D:/code/_annot_baseline/_pc-files.txt', files.map(([r]) => r).join('\n') + '\n', 'utf8');
console.log('PC ready:', PC);
