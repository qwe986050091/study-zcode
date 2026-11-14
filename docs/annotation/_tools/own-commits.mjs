// own-commits：本线归属白名单（zc-commit 的来源判据）。
//
// v3（b264 起）：白名单改为**机器生成**，文档散文不再参与解析。
//   - 唯一事实来源：`docs/annotation/_tools/OWN-COMMITS.tsv`，由 `own-commits-gen.mjs` 从 `git log` 产出；
//   - 判据：作者 ∈ `OWN_AUTHORS`（当前 `zhanglingfeng`）的全部提交 → 本线；其余（wuweiqi / bot）→ 上游；
//   - 两条断言：每个 sha 必须能在 `git log` 里解析成 commit；TSV 行数必须等于机器生成行数（`--verify`）。
//
// 为什么废弃 v2 的散文解析：v2 用正则从 `ZC-*.md` 里抽 `提交 <sha>` / `安全快照 <sha>`，
// b262 台账里一句「本线的注释提交，`872ad960` / `aac47556` 都在册外」把上游 sha 抽进了白名单，
// 1,001 行归户翻转。负例（往文档里写假 sha，白名单不得变化）现在是 `--verify` 的回归用例。
//
// 三态判定沿用 v2：本线 / 上游 / 未解析；未解析 `exit 3`，不落进上游桶（fail-closed）。
//
// 用法：
//   node own-commits.mjs <repoRoot>                     列出白名单
//   node own-commits.mjs <repoRoot> --check <sha>...    三态判定 + 证据
//   node own-commits.mjs <repoRoot> --verify            断言「解析得通 + 行数一致」
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateRows, renderTsv, TSV_PATH } from './own-commits-gen.mjs';

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function readRows(repoRoot) {
  const file = path.join(repoRoot, TSV_PATH);
  if (!fs.existsSync(file)) {
    throw new Error(`缺少 ${TSV_PATH}：先跑 node own-commits-gen.mjs <repoRoot>`);
  }
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [sha, author, date, ...rest] = line.split('\t');
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`TSV 行格式不对：${line}`);
    rows.push({ sha, author, date, subject: rest.join('\t') });
  }
  return rows;
}

// 返回 { commits: Map<fullSha, {ledger, subject}>, short: Map<shortSha, fullSha> }
// `ledger` 字段保留兼容：现在记的是 TSV 文件名，不再是台账文件名。
export function loadOwnCommits(repoRoot) {
  const rows = readRows(repoRoot);
  const commits = new Map();
  const short = new Map();
  for (const row of rows) {
    const full = git(repoRoot, ['rev-parse', '--verify', `${row.sha}^{commit}`]).trim();
    if (full !== row.sha) throw new Error(`TSV 里的 sha 不是 commit 本身：${row.sha}`);
    commits.set(full, { ledger: path.basename(TSV_PATH), subject: row.subject });
    short.set(row.sha.slice(0, 8), full);
  }
  return { commits, short };
}

// 两条断言：sha 全部解析得通（loadOwnCommits 内做）+ 行数与机器生成一致。
export function verifyWhitelist(repoRoot) {
  const rows = readRows(repoRoot);
  const generated = generateRows(repoRoot);
  loadOwnCommits(repoRoot); // 逐行 rev-parse，失败即抛
  const fileSet = new Set(rows.map((r) => r.sha));
  const genSet = new Set(generated.map((r) => r.sha));
  const missing = generated.filter((r) => !fileSet.has(r.sha));
  const extra = rows.filter((r) => !genSet.has(r.sha));
  const sameText = renderTsv(rows) === renderTsv(generated);
  return {
    ok: rows.length === generated.length && missing.length === 0 && extra.length === 0 && sameText,
    rows: rows.length,
    generated: generated.length,
    missing,
    extra,
    sameText,
  };
}

export function isOwnBlame(sha, whitelist) {
  if (!sha) return false;
  return whitelist.commits.has(sha);
}

export function resolveCommit(repoRoot, sha) {
  if (!sha) return null;
  try {
    return git(repoRoot, ['rev-parse', '--verify', `${sha}^{commit}`]).trim();
  } catch {
    return null;
  }
}

export function classifySha(repoRoot, sha, whitelist) {
  const full = resolveCommit(repoRoot, sha);
  if (!full) return { state: '未解析', sha, full: null, author: '', subject: '' };
  if (whitelist.commits.has(full)) {
    return { state: '本线', sha, full, author: '', subject: whitelist.commits.get(full).subject };
  }
  let author = '';
  let subject = '';
  try {
    const out = git(repoRoot, ['log', '-1', '--format=%an <%ae>%n%s', full]).split(/\r?\n/);
    author = out[0] ?? '';
    subject = out[1] ?? '';
  } catch {
    // 已解析出 full，取证据失败只影响可读性，不改变「上游」结论
  }
  return { state: '上游', sha, full, author, subject };
}

if (process.argv[1] && process.argv[1].endsWith('own-commits.mjs')) {
  const repo = process.argv[2];
  if (!repo) {
    console.error('用法: node own-commits.mjs <repoRoot> [--check <sha>...] [--verify]');
    process.exit(2);
  }
  if (process.argv.includes('--verify')) {
    const r = verifyWhitelist(repo);
    console.log(
      `OWNCOMMITS rows=${r.rows} generated=${r.generated} missing=${r.missing.length} extra=${r.extra.length} text=${r.sameText ? 'same' : 'diff'}`,
    );
    for (const x of r.missing.slice(0, 5)) console.error(`MISSING ${x.sha} ${x.subject}`);
    for (const x of r.extra.slice(0, 5)) console.error(`EXTRA   ${x.sha} ${x.subject}`);
    if (!r.ok) process.exit(1);
  }
  const wl = loadOwnCommits(repo);
  const checkAt = process.argv.indexOf('--check');
  if (checkAt > 0) {
    const tally = { 本线: 0, 上游: 0, 未解析: 0 };
    for (const sha of process.argv.slice(checkAt + 1)) {
      const r = classifySha(repo, sha, wl);
      tally[r.state] += 1;
      const ev = r.author
        ? `${r.author}\t${r.subject}`
        : r.subject
          ? `白名单\t${r.subject}`
          : '(无 commit 证据)';
      console.log(`${sha}\t${r.state}\t${r.full ?? '(未解析)'}\t${ev}`);
    }
    console.log(`CHECK own=${tally.本线} upstream=${tally.上游} pending=${tally.未解析}`);
    if (tally.未解析) {
      console.error(
        `未解析 ${tally.未解析} 条：必须人工定归属（git log -1 --format='%an %ae %s'）并回填 ` +
          'OWN-COMMITS.tsv 后才允许放过；未回填的计入「待定」，不算豁免。',
      );
      process.exit(3);
    }
  } else {
    console.log(`白名单提交数 ${wl.commits.size}`);
    for (const [sha, info] of [...wl.commits].sort()) {
      console.log(`${sha.slice(0, 8)}\t${info.subject}`);
    }
  }
}
