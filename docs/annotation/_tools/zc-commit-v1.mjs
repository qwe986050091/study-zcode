// zc-commit：把「标题里的数字」从手工抄写改成从 git 现算。
//
// 背景：标题数字连续三次写错（最近一次 98e03c1a 写 +76/−1、实际 +170/−1），
// 三次都发生在「先写标题、再数 numstat」的顺序上。规则约束不了手工动作，
// 所以这里让数字只由脚本产生：人工只给 subject，行数一律从 git 抄。
//
// 用法：
//   node zc-commit.mjs --repo d:\code\ZCode --files <清单文件> --subject "<前缀>"
//                      [--body <正文文件>] [--require-pure-annot] [--yes]
//
// 行为：
//   1. 读清单（每行一个相对路径，UTF-8）；
//   2. 已跟踪文件取 `git diff --numstat`，未跟踪文件按行数计（新增 = 行数，删除 = 0）；
//   3. 生成标题：删除为 0 → `<subject> (+X)`，否则 `<subject> (+X/−Y)`；
//   4. 打印完整标题、文件数、增删行数、新增最多的 10 个文件、未跟踪文件清单；
//   5. 只有带 --yes 才 `git add` + `git commit`，否则只打印待确认内容。
//
// --require-pure-annot：逐文件校验「删除 0 行，且新增行全部是注释或空行」，命中即整批不动。
//   用于快照提交，防止把别的会话的代码改动混进来。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
};
const has = (name) => argv.includes(`--${name}`);

const repo = opt('repo');
const filesArg = opt('files');
const subject = opt('subject');
const bodyFile = opt('body');
const requirePureAnnot = has('require-pure-annot');
const doCommit = has('yes');

if (!repo || !filesArg || !subject) {
  console.error('用法: node zc-commit.mjs --repo <仓库> --files <清单文件> --subject "<前缀>" [--body <正文文件>] [--require-pure-annot] [--yes]');
  process.exit(2);
}

const run = (args, opts = {}) =>
  execFileSync('git', ['-C', repo, ...args], { maxBuffer: 512 * 1024 * 1024, encoding: 'utf8', ...opts });

// 清单统一成 / 分隔的相对路径
const files = [
  ...new Set(
    fs
      .readFileSync(filesArg, 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((s) => s.trim().replace(/\\/g, '/'))
      .filter(Boolean),
  ),
];
if (!files.length) {
  console.error('清单为空');
  process.exit(2);
}

const tracked = new Set(
  run(['ls-files', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((s) => s.replace(/\\/g, '/')),
);

// 已跟踪文件：一次全仓 numstat，按路径取
const numstat = new Map();
for (const line of run(['diff', '--numstat', '--no-color', '--no-ext-diff']).split(/\r?\n/)) {
  if (!line.trim()) continue;
  const m = line.match(/^(\S+)\t(\S+)\t(.+)$/);
  if (!m) continue;
  numstat.set(m[3].replace(/\\/g, '/'), { added: m[1], deleted: m[2] });
}

const countLines = (abs) => {
  const buf = fs.readFileSync(abs);
  if (!buf.length) return 0;
  let n = 0;
  for (const b of buf) if (b === 0x0a) n++;
  if (buf[buf.length - 1] !== 0x0a) n++;
  return n;
};

const rows = [];
const problems = [];
for (const rel of files) {
  const abs = path.join(repo, rel);
  if (!fs.existsSync(abs)) {
    problems.push({ rel, why: '文件不存在' });
    continue;
  }
  const isTracked = tracked.has(rel);
  let added;
  let deleted;
  if (isTracked) {
    const r = numstat.get(rel);
    if (!r) {
      problems.push({ rel, why: '无 diff（可能未修改）' });
      continue;
    }
    if (r.added === '-' || r.deleted === '-') {
      problems.push({ rel, why: '二进制度量不可用' });
      continue;
    }
    added = Number(r.added);
    deleted = Number(r.deleted);
  } else {
    added = countLines(abs);
    deleted = 0;
  }
  rows.push({ rel, added, deleted, untracked: !isTracked });
}

const totalAdded = rows.reduce((s, r) => s + r.added, 0);
const totalDeleted = rows.reduce((s, r) => s + r.deleted, 0);
const untrackedRows = rows.filter((r) => r.untracked);

// --require-pure-annot：逐文件看 diff 的新增行，非注释即拒。
// 不把 1,700 个路径塞进 argv（Windows 会 ENAMETOOLONG），改为取全仓 -U0 diff 后按集合过滤。
if (requirePureAnnot) {
  const wanted = new Set(files);
  const diff = run(['diff', '-U0', '--no-color', '--no-ext-diff']);
  let cur = null;
  const bad = new Map();
  const mark = (file, why) => {
    if (!bad.has(file)) bad.set(file, new Set());
    bad.get(file).add(why);
  };
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      cur = m ? m[2].replace(/\\/g, '/') : null;
      if (cur && !wanted.has(cur)) cur = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const t = line.slice(1).trim();
      const isComment = t === '' || /^(\/\/|\/\*|\*|\*\/|#|<!--|-->|;)/.test(t);
      if (!isComment) mark(cur, '新增了非注释行');
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      mark(cur, '删除了行');
    }
  }
  for (const r of rows) if (r.deleted > 0) mark(r.rel, `numstat 删除 ${r.deleted} 行`);
  for (const [file, whys] of bad) problems.push({ rel: file, why: [...whys].join(' / ') });
}

// 标题：数字只此一处产生
const numbers = totalDeleted === 0 ? `(+${totalAdded})` : `(+${totalAdded}/−${totalDeleted})`;
const title = `${subject} ${numbers}`;

console.log('=== 待确认 ===');
console.log(`标题: ${title}`);
console.log(`文件数: ${rows.length}（未跟踪 ${untrackedRows.length}）`);
console.log(`numstat: +${totalAdded} −${totalDeleted}`);
console.log('--- 新增最多的 10 个文件 ---');
for (const r of [...rows].sort((a, b) => b.added - a.added).slice(0, 10)) {
  console.log(`  +${r.added}\t−${r.deleted}\t${r.rel}${r.untracked ? '  [新]' : ''}`);
}
if (untrackedRows.length) {
  console.log(`--- 未跟踪文件 ${untrackedRows.length} 个（按行数计新增）---`);
  for (const r of untrackedRows.slice(0, 20)) console.log(`  +${r.added}\t${r.rel}`);
  if (untrackedRows.length > 20) console.log(`  ... 其余 ${untrackedRows.length - 20} 个`);
}
if (problems.length) {
  console.log(`--- 拒绝项 ${problems.length} 条 ---`);
  for (const p of problems) console.log(`  ${p.rel} :: ${p.why}`);
  console.error('\n存在拒绝项，整批不动。');
  process.exit(1);
}
if (!rows.length) {
  console.error('\n没有可提交的文件。');
  process.exit(1);
}

if (!doCommit) {
  console.log('\n未带 --yes，仅预览，不落盘。');
  process.exit(0);
}

// 正文：显式给的文件 + 自动生成的 numstat 行
const bodyParts = [];
if (bodyFile) bodyParts.push(fs.readFileSync(bodyFile, 'utf8').replace(/^\uFEFF/, '').trimEnd());
bodyParts.push('', '---', `文件数 ${rows.length}，numstat +${totalAdded} −${totalDeleted}（由 zc-commit 从 git 现算，非手工抄写）。`);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-commit-'));
const pathspecFile = path.join(tmpDir, 'files.nul');
const msgFile = path.join(tmpDir, 'msg.txt');
fs.writeFileSync(pathspecFile, rows.map((r) => r.rel).join('\0') + '\0', 'utf8');
fs.writeFileSync(msgFile, `${title}\n\n${bodyParts.join('\n')}\n`, 'utf8');

run(['add', '--pathspec-from-file', pathspecFile, '--pathspec-file-nul']);
run(['commit', '-F', msgFile]);
console.log('\n已提交:');
console.log(run(['log', '-1', '--format=%h %s']).trim());
