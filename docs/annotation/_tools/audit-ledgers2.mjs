// 全仓批次台账审计 v2：核对每个 ZC-DEEP-b*.md 登记的「文件 + 行数」是否真的提交。
// 判定四类：已提交且干净 / 未提交 / 部分未提交 / 台账与实测不符（含 file-missing / over）。
// 用法：node audit-ledgers2.mjs <repoRoot> <ledgerDir> <outTsv>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [repo, ledgerDir, outTsv] = process.argv.slice(2);
const git = (args) => {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
};

// 全仓文件索引（用于把台账里的缩写路径还原成全路径）
const tracked = git(['ls-files']).split(/\r?\n/).filter(Boolean);
const byBase = new Map();
for (const p of tracked) {
  const b = p.split('/').pop();
  if (!byBase.has(b)) byBase.set(b, []);
  byBase.get(b).push(p);
}

const resolve = (raw) => {
  const p = raw.trim().replace(/^`|`$/g, '');
  if (!p) return null;
  const candidates = [p, 'packages/' + p, 'apps/zcode-cli/packages/' + p];
  for (const c of candidates) if (fs.existsSync(path.join(repo, c))) return c;
  // 缩写路径兜底：按 basename 唯一命中，或按尾部段数匹配（允许中间缺 src）
  const base = p.split('/').pop();
  const hits = byBase.get(base) || [];
  if (hits.length === 1) return hits[0];
  const segs = p.split('/');
  const tail2 = segs.slice(-2).join('/');
  const tail3 = segs.slice(-3).join('/');
  const norm = (s) => s.replace(/\/src\//g, '/');
  const t2 = norm(tail2);
  const t3 = norm(tail3);
  const m3 = hits.filter((h) => norm(h).endsWith('/' + t3));
  if (m3.length === 1) return m3[0];
  const m2 = hits.filter((h) => norm(h).endsWith('/' + t2));
  if (m2.length === 1) return m2[0];
  return p; // 保持原样，后续判定为 file-missing
};

const ledgers = fs
  .readdirSync(ledgerDir)
  .filter((n) => /^ZC-DEEP-b\d+[a-z]?\.md$/.test(n))
  .sort((a, b) => Number(a.match(/b(\d+)/)[1]) - Number(b.match(/b(\d+)/)[1]) || a.localeCompare(b));

// 不变量：解析到的台账数必须等于盘上存在的台账数。
// 2026-11-10 的 436 文件误判就是这么来的——脚本只 glob 了 ZC-DEEP-b*.md，
// 把 svc/L1/L2 三族静默排除，产物却仍以「全仓审计」的名义输出。
// 判据：凡文件名匹配台账命名族的都必须被解析或显式列进 UNPARSED，否则非零退出。
const LEDGER_FAMILY = /^(ZC-DEEP-b\d+[a-z]?|ZC-DEEP-svc-.+|L[12]-B.+|ZC-DEEP-SERVICES-PLAN|ZC-DEEP-CORE-PLAN)\.md$/;
const onDisk = fs.readdirSync(ledgerDir).filter((n) => LEDGER_FAMILY.test(n)).sort();
const parsed = new Set(ledgers);
const unparsed = onDisk.filter((n) => !parsed.has(n));
console.log(`SCOPE ledgersOnDisk=${onDisk.length} parsed=${ledgers.length} unparsed=${unparsed.length}`);
if (unparsed.length) {
  console.error('UNPARSED ' + unparsed.join(', '));
  console.error('台账解析范围不完整：要么把该族加入解析，要么在审计结论里显式声明「本审计只覆盖 X 族」。');
}

const entries = [];
for (const name of ledgers) {
  const text = fs.readFileSync(path.join(ledgerDir, name), 'utf8');
  const title = (text.match(/^#\s*(.+)$/m) || [, ''])[1];
  const seen = new Map();
  const okRe = /\[ok\]\s+(\S+?):\s*\d+\s+blocks?,\s*(\d+)\s+lines?/g;
  let m;
  while ((m = okRe.exec(text))) {
    const p = resolve(m[1]);
    if (p && !seen.has(p)) seen.set(p, Number(m[2]));
  }
  if (seen.size === 0) {
    for (const line of text.split(/\r?\n/)) {
      const cells = line.split('|').map((c) => c.trim());
      if (cells.length < 4) continue;
      const first = cells[1];
      if (!/^`[^`]*\.[cm]?[jt]sx?`$/.test(first)) continue;
      const p = resolve(first);
      const nums = cells.slice(2).filter((c) => /^\+?\d+$/.test(c));
      if (p && nums.length && !seen.has(p)) seen.set(p, Number(nums[nums.length - 1].replace('+', '')));
    }
  }
  for (const [p, n] of seen) entries.push({ batch: name.replace('.md', ''), file: p, declared: n });
  if (seen.size === 0) entries.push({ batch: name.replace('.md', ''), file: '', declared: 0 });
  entries[entries.length - 1].batchTitle = title;
}

const statusRaw = git(['status', '--porcelain']);
const statusMap = new Map();
for (const line of statusRaw.split(/\r?\n/)) {
  if (!line.trim()) continue;
  statusMap.set(line.slice(3).trim().replace(/^"|"$/g, ''), line.slice(0, 2).trim());
}

const rows = [];
for (const e of entries) {
  if (!e.file) {
    rows.push({ ...e, head: '', subject: '', added: 0, deleted: 0, verdict: '台账解析失败', note: 'no-table' });
    continue;
  }
  const exists = fs.existsSync(path.join(repo, e.file));
  const head = exists ? git(['log', '-1', '--format=%h', '--', e.file]) : '';
  const subject = exists ? git(['log', '-1', '--format=%s', '--', e.file]) : '';
  let added = 0;
  let del = 0;
  if (exists) {
    const ns = git(['diff', '--numstat', '--', e.file]);
    if (ns) {
      const [a, d] = ns.split(/\s+/);
      added = Number(a) || 0;
      del = Number(d) || 0;
    }
  }
  const annotationCommit = /注释|annotat/i.test(subject);
  let verdict;
  let note = '';
  if (!exists) {
    verdict = '台账与实测不符';
    note = 'file-missing';
  } else if (added === e.declared && del === 0) {
    verdict = '未提交';
  } else if (added > 0 && added < e.declared) {
    verdict = '部分未提交';
    note = `差 ${e.declared - added} 行`;
  } else if (added > e.declared) {
    verdict = '台账与实测不符';
    note = `超出 ${added - e.declared} 行`;
  } else if (annotationCommit) {
    verdict = '已提交且干净';
  } else {
    verdict = '台账与实测不符';
    note = 'clean-no-commit';
  }
  rows.push({ ...e, head, subject, added, deleted: del, verdict, note, status: statusMap.get(e.file) || '' });
}

const cols = ['批次', '台账登记', '文件', 'HEAD', '末次提交', '工作区+', '工作区-', '判定', '备注'];
const lines = [cols.join('\t')];
for (const r of rows) {
  lines.push(
    [r.batch, r.declared, r.file, r.head, r.subject, r.added, r.deleted, r.verdict, r.note || ''].join('\t'),
  );
}
if (outTsv) fs.writeFileSync(outTsv, lines.join('\n') + '\n', 'utf8');

const vc = {};
const perBatch = {};
let dirtyFiles = 0;
let dirtyLines = 0;
for (const r of rows) {
  vc[r.verdict] = (vc[r.verdict] || 0) + 1;
  const b = (perBatch[r.batch] ||= { files: 0, declared: 0, dirty: 0, dirtyLines: 0 });
  b.files++;
  b.declared += r.declared;
  if (r.verdict !== '已提交且干净') {
    b.dirty++;
    b.dirtyLines += r.added;
    dirtyFiles++;
    dirtyLines += r.added;
  }
}
console.log(`LEDGERS ${ledgers.length} ENTRIES ${rows.length}`);
for (const [k, v] of Object.entries(vc).sort((a, b) => b[1] - a[1])) console.log(`  ${k}\t${v}`);
console.log(`DIRTY-FILES ${dirtyFiles} DIRTY-LINES ${dirtyLines}`);
if (process.argv[5]) fs.writeFileSync(process.argv[5], JSON.stringify({ vc, perBatch, dirtyFiles, dirtyLines }, null, 2));
// 不变量落地：范围不完整以非零退出，避免再产出「名叫全仓、实为一族」的结论。
if (unparsed.length) process.exitCode = 3;
