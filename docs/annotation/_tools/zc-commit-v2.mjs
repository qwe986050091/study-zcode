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
//
// --rewrite-annot --base <ref> [--register <tsv>]：改写批专用门禁（DEEP-SPEC §2.16）。
//   1→1 改写必然删掉本线注释行，所以不能沿用「删除必须为 0」。删除行按来源分三类同屏输出：
//     a) 删本线注释：允许，逐行登记到 --register（file<TAB>baseLine<TAB>kind<TAB>content）；
//     b) 删代码    ：必须 0，非 0 整批拒绝；
//     c) 删上游注释：必须 0，非 0 整批拒绝。
//   来源判据是 base 上该行的 blame 提交：提交标题以 bNNN 开头、或以「注释」开头、
//   或以 snapshot(annot) 开头的算本线；其余算上游。base 必须是「本批改写前的 HEAD」，
//   不能写死成快照提交 8f7daaf0——那样每批的 diff 会把前面所有批的改写一起卷进来。
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
const rewriteAnnot = has('rewrite-annot');
const baseRef = opt('base', 'HEAD');
const registerFile = opt('register');
const doCommit = has('yes');

if (rewriteAnnot && requirePureAnnot) {
  console.error('--rewrite-annot 与 --require-pure-annot 互斥：前者允许删本线注释，后者要求删除为 0。');
  process.exit(2);
}

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

// --rewrite-annot：改写批门禁。删除行按来源三类同屏输出（§2.16）。
if (rewriteAnnot) {
  const wanted = new Set(files);
  const isComment = (t) => t === '' || /^(\/\/|\/\*|\*|\*\/|#|<!--|-->|;)/.test(t);
  const diff = run(['diff', '-U0', '--no-color', '--no-ext-diff', baseRef]);
  let cur = null;
  let baseLine = 0;
  const dels = []; // {file, line, content}
  const addedNonComment = [];
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      cur = m ? m[2].replace(/\\/g, '/') : null;
      if (cur && !wanted.has(cur)) cur = null;
      continue;
    }
    if (!cur) continue;
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h) {
      baseLine = Number(h[1]);
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      dels.push({ file: cur, line: baseLine, content: line.slice(1) });
      baseLine++;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      const t = line.slice(1).trim();
      if (!isComment(t)) addedNonComment.push({ file: cur, content: line.slice(1) });
    }
  }

  // base 上每一行由哪个提交引入：提交标题决定「本线 / 上游」
  const subjectOf = new Map();
  for (const l of run(['log', '--format=%H\t%s']).split(/\r?\n/)) {
    const i = l.indexOf('\t');
    if (i > 0) subjectOf.set(l.slice(0, i), l.slice(i + 1));
  }
  const isOwnCommit = (s) => /^(?:b\d{3}[a-z]?\b|注释|snapshot\(annot\))/.test(s ?? '');
  const blameCache = new Map();
  const blameAt = (file) => {
    if (blameCache.has(file)) return blameCache.get(file);
    const map = new Map();
    let out;
    try {
      out = run(['blame', '--line-porcelain', baseRef, '--', file]);
    } catch {
      blameCache.set(file, map);
      return map;
    }
    let hash = null;
    let ln = 0;
    for (const l of out.split('\n')) {
      const m = l.match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/);
      if (m) {
        hash = m[1];
        ln = Number(m[2]);
        continue;
      }
      if (l.startsWith('\t') && hash) map.set(ln, hash);
    }
    blameCache.set(file, map);
    return map;
  };

  const ownComments = [];
  const codeDels = [];
  const upstreamComments = [];
  for (const d of dels) {
    const t = d.content.trim();
    if (!isComment(t)) {
      codeDels.push(d);
      continue;
    }
    const hash = blameAt(d.file).get(d.line);
    const subject = hash ? subjectOf.get(hash) : '';
    if (isOwnCommit(subject)) ownComments.push({ ...d, subject: subject ?? '', hash: hash ?? '' });
    else upstreamComments.push({ ...d, subject: subject ?? '(blame 未命中)', hash: hash ?? '' });
  }

  const short = (s) => (s.length > 14 ? s.slice(0, 14) : s);
  console.log(`\n=== 改写门禁（base=${baseRef}）===`);
  console.log(`删本线注释    n=${ownComments.length}  （允许，逐行登记）`);
  console.log(`删代码        n=${codeDels.length}  （必须 0）`);
  console.log(`删上游注释    n=${upstreamComments.length}  （必须 0）`);
  console.log(`新增非注释行  n=${addedNonComment.length}  （必须 0）`);
  if (ownComments.length) {
    console.log('--- 删本线注释逐行登记 ---');
    for (const d of ownComments) console.log(`  ${d.file}:${d.line}\t${short(d.hash)}\t${d.content.trim().slice(0, 90)}`);
  }
  if (codeDels.length) {
    console.log('--- 删代码（违规）---');
    for (const d of codeDels) console.log(`  ${d.file}:${d.line}\t${d.content.trim().slice(0, 90)}`);
  }
  if (upstreamComments.length) {
    console.log('--- 删上游注释（违规）---');
    for (const d of upstreamComments) console.log(`  ${d.file}:${d.line}\t${d.subject}\t${d.content.trim().slice(0, 90)}`);
  }
  if (addedNonComment.length) {
    console.log('--- 新增非注释行（违规）---');
    for (const d of addedNonComment.slice(0, 30)) console.log(`  ${d.file}\t${d.content.trim().slice(0, 90)}`);
  }
  if (registerFile) {
    const tsv = ['file\tbaseLine\tblame\tcontent'];
    for (const d of ownComments) tsv.push(`${d.file}\t${d.line}\t${short(d.hash)}\t${d.content.trim()}`);
    fs.writeFileSync(registerFile, tsv.join('\n') + '\n', 'utf8');
    console.log(`登记表已写 ${registerFile}（${ownComments.length} 行）`);
  }
  if (codeDels.length || upstreamComments.length || addedNonComment.length) {
    console.error('\n改写门禁未通过：删代码 / 删上游注释 / 新增非注释行必须全为 0。');
    process.exit(1);
  }
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
