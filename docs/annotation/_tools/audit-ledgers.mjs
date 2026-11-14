// 全仓批次台账审计：核对每个 ZC-DEEP-b*.md 登记的「文件 + 行数」是否真的提交。
// 判定四类：已提交且干净 / 未提交 / 部分未提交 / 台账与实测不符。
// 用法：node audit-ledgers.mjs <repoRoot> <ledgerDir> <outTsv>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [repo, ledgerDir, outTsv] = process.argv.slice(2);
if (!repo || !ledgerDir) {
  console.error('usage: node audit-ledgers.mjs <repoRoot> <ledgerDir> [outTsv]');
  process.exit(2);
}

const git = (args) => {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
};

const ledgers = fs
  .readdirSync(ledgerDir)
  .filter((n) => /^ZC-DEEP-b\d+[a-z]?\.md$/.test(n))
  .sort((a, b) => {
    const na = Number(a.match(/b(\d+)/)[1]);
    const nb = Number(b.match(/b(\d+)/)[1]);
    if (na !== nb) return na - nb;
    return a.localeCompare(b);
  });

const normPath = (raw) => {
  let p = raw.trim().replace(/^`|`$/g, '');
  if (!p) return null;
  if (fs.existsSync(path.join(repo, p))) return p;
  if (!p.startsWith('packages/') && fs.existsSync(path.join(repo, 'packages', p))) {
    return 'packages/' + p;
  }
  return p;
};

const entries = [];
for (const name of ledgers) {
  const text = fs.readFileSync(path.join(ledgerDir, name), 'utf8');
  const title = (text.match(/^#\s*(.+)$/m) || [, ''])[1];
  const seen = new Map();
  // 主来源：验收输出的 [ok] <path>: <n> blocks, <m> lines
  const okRe = /\[ok\]\s+(\S+?):\s*\d+\s+blocks?,\s*(\d+)\s+lines?/g;
  let m;
  while ((m = okRe.exec(text))) {
    const p = normPath(m[1]);
    if (p && !seen.has(p)) seen.set(p, Number(m[2]));
  }
  // 备选：明细表里 | `path` | ... | N |
  if (seen.size === 0) {
    for (const line of text.split(/\r?\n/)) {
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 4) continue;
      const first = cells[1];
      if (!/^`[^`]*[/\\][^`]*`$/.test(first)) continue;
      const p = normPath(first);
      const nums = cells.slice(2).filter((c) => /^\d+$/.test(c));
      if (p && nums.length && !seen.has(p)) seen.set(p, Number(nums[nums.length - 1]));
    }
  }
  for (const [p, n] of seen) entries.push({ batch: name.replace('.md', ''), title, file: p, declared: n });
  if (seen.size === 0) entries.push({ batch: name.replace('.md', ''), title, file: '', declared: 0 });
}

// 工作区状态一次性拿
const statusRaw = git(['status', '--porcelain']);
const statusMap = new Map();
for (const line of statusRaw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  const code = line.slice(0, 2).trim();
  const p = line.slice(3).trim().replace(/^"|"$/g, '');
  statusMap.set(p, code);
}

const rows = [];
for (const e of entries) {
  if (!e.file) {
    rows.push({ ...e, head: '', subject: '', added: '', deleted: '', verdict: '台账解析失败' });
    continue;
  }
  const head = git(['log', '-1', '--format=%h', '--', e.file]);
  const subject = git(['log', '-1', '--format=%s', '--', e.file]);
  const numstat = git(['diff', '--numstat', '--', e.file]);
  let added = 0;
  let deletedNum = 0;
  if (numstat) {
    const [a, d] = numstat.split(/\s+/);
    added = Number(a);
    deletedNum = Number(d);
  }
  const st = statusMap.get(e.file) || '';
  const annotationCommit = /注释|docs\(注释\)|纯注释|annotat/i.test(subject);
  let verdict;
  if (added === e.declared && deletedNum === 0) verdict = '未提交';
  else if (added > 0 && added < e.declared) verdict = '部分未提交';
  else if (added > 0) verdict = '台账与实测不符';
  else if (annotationCommit) verdict = '已提交且干净';
  else verdict = '台账与实测不符';
  rows.push({ ...e, head, subject, added, deleted: deletedNum, verdict, status: st });
}

const header = ['批次', '台账登记', '文件', 'HEAD', '末次提交', '工作区+', '工作区-', '判定'];
const lines = [header.join('\t')];
for (const r of rows) {
  lines.push(
    [r.batch, r.declared, r.file, r.head, r.subject, r.added, r.deleted, r.verdict].join('\t'),
  );
}
if (outTsv) fs.writeFileSync(outTsv, lines.join('\n') + '\n', 'utf8');

const byVerdict = {};
let filesDirty = 0;
let linesDirty = 0;
for (const r of rows) {
  byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
  if (r.verdict === '未提交' || r.verdict === '部分未提交' || r.verdict === '台账与实测不符') {
    filesDirty++;
    linesDirty += r.added || 0;
  }
}
console.log(`LEDGERS ${ledgers.length} ENTRIES ${rows.length}`);
for (const [k, v] of Object.entries(byVerdict).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}\t${v}`);
}
console.log(`DIRTY-FILES ${filesDirty} DIRTY-LINES ${linesDirty}`);
for (const r of rows.filter((x) => x.verdict !== '已提交且干净')) {
  console.log(
    `  [${r.verdict}] ${r.batch} ${r.file || '(parse-fail)'} declared=${r.declared} head=${r.head || '-'} wt=+${r.added}/-${r.deleted} ${r.subject || ''}`,
  );
}
