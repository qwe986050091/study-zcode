// own-commits-gen：把本线归属白名单从「台账散文」改成「git log 机器产出」。
//
// 背景：v2 从 `docs/annotation/ZC-*.md` 里用正则抽 sha（`提交 xxx` / `安全快照 xxx`），
// b262 台账里一句「本线的注释提交，`872ad960` / `aac47556` 都在册外」就把上游 sha 抽进了白名单，
// 导致 1,001 行归户翻转。散文会被误读，机器不会——所以白名单只认这个脚本的输出。
//
// 判据：本线 = `OWN_AUTHORS` 里的作者在 `git log` 里的全部提交。
// 只看作者，不看标题：标题改写法不影响归属；上游作者（wuweiqi / bot）不进白名单。
//
// 产物：`docs/annotation/_tools/OWN-COMMITS.tsv`，四列 `sha \t author \t date \t subject`，按 sha 升序。
//       另写 `OWN-COMMITS.meta.json`：生成时的 HEAD 与行数。容量件启动时比对 meta.head 与当前 HEAD，
//       不一致即拒跑——白名单落后会让新提交的改写行被判成「上游自清」，`done` 少算且不报错。
// 用法：
//   node own-commits-gen.mjs <repoRoot>            写 TSV + meta
//   node own-commits-gen.mjs <repoRoot> --print    只打印，不写
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const OWN_AUTHORS = ['zhanglingfeng'];
export const TSV_PATH = path.join('docs', 'annotation', '_tools', 'OWN-COMMITS.tsv');
export const META_PATH = path.join('docs', 'annotation', '_tools', 'OWN-COMMITS.meta.json');

export function currentHead(repoRoot) {
  return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export function generateRows(repoRoot) {
  const out = execFileSync(
    'git',
    ['-C', repoRoot, 'log', '--format=%H%x09%an%x09%ai%x09%s', '--reverse'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [sha, author, date, ...rest] = line.split('\t');
    if (!OWN_AUTHORS.includes(author)) continue;
    rows.push({ sha, author, date, subject: rest.join('\t') });
  }
  return rows.sort((a, b) => (a.sha < b.sha ? -1 : 1));
}

export function renderTsv(rows) {
  return rows.map((r) => `${r.sha}\t${r.author}\t${r.date}\t${r.subject}`).join('\n') + '\n';
}

if (process.argv[1] && process.argv[1].endsWith('own-commits-gen.mjs')) {
  const repo = process.argv[2];
  if (!repo) {
    console.error('用法: node own-commits-gen.mjs <repoRoot> [--print]');
    process.exit(2);
  }
  const rows = generateRows(repo);
  const text = renderTsv(rows);
  if (process.argv.includes('--print')) {
    process.stdout.write(text);
  } else {
    fs.writeFileSync(path.join(repo, TSV_PATH), text);
    const meta = { head: currentHead(repo), generatedAt: new Date().toISOString(), rows: rows.length };
    fs.writeFileSync(path.join(repo, META_PATH), `${JSON.stringify(meta, null, 1)}\n`);
    console.log(
      `OWN-COMMITS.tsv 已写 ${rows.length} 行（作者：${OWN_AUTHORS.join(', ')}）meta.head=${meta.head.slice(0, 12)}`,
    );
  }
}
