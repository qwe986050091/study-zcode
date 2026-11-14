// own-commits：本线归属白名单（zc-commit 的来源判据）。
//
// 背景：v1–v5 用「commit 标题前缀」判断某行是不是本线写的（`bNNN` / `注释` / `snapshot(annot)`）。
// 这个判据放在标题上，标题一改写法就漏：b236 就漏了 `docs(注释): …`（L2-B10b 起的新写法），
// 把 3 行本线注释判成上游。更糟的是方向可变——把本线记成上游只是拒绝提交，
// 反过来把上游记成本线则会放行改写上游注释，那就破了 §2.6。
//
// 现在的判据：blame 出来的 sha ∈ 台账登记的批次 commit 集合 → 本线，否则上游。
// 白名单只从台账 `docs/annotation/ZC-*.md` 里抽，抽到什么就认什么，标题怎么写都不影响；
// 新增批次只要按惯例在台账里写 `提交 <sha>`（或 `git log --oneline -1` 证据块），下一批自动进白名单。
//
// v2（b248 起）：判定改三态——本线 / 上游 / 未解析。
// v1 把「不在白名单」一律记成上游，其中混着「git 根本解析不出这个 sha」的情况：
// 那是「不知道」，却拿到了「上游、不必改」的结论，属于 fail-open。
// 未解析必须人工定归属（`git log -1 --format='%an %ae %s'` / 是否在批次台账或 OWN-COMMITS.md），
// 结论回填白名单后才允许放过；未解析且未回填的计入「待定 n 条」，算未完成。
//
// 用法：
//   node own-commits.mjs <repoRoot>          列出白名单（sha / 短标题 / 首次出现于哪个台账）
//   node own-commits.mjs <repoRoot> --check <sha>[...]   三态判定 + 证据；有未解析即 exit 3
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LEDGER_DIR = 'docs/annotation';

// 三种登记写法都要吃：`提交 a8784b7e`、`a8784b7e b230 改写…`（git log 证据块）、`安全快照 \`a8784b7e\``。
const PATTERNS = [
  /提交[^\n0-9a-f]{0,6}([0-9a-f]{7,40})/g,
  /^\s{0,4}([0-9a-f]{7,40})\s+(?:b\d{3}[a-z]?\b)/gm,
  /安全快照[^\n0-9a-f]{0,6}([0-9a-f]{7,40})/g,
];

// 手工登记表：`| \`ad6dc0eb\` | 2026-11-03 | docs(注释): L2-B2 runtime |`
const MANUAL_FILE = path.join('docs', 'annotation', '_tools', 'OWN-COMMITS.md');
const MANUAL_PATTERN = /^\|\s*`?([0-9a-f]{7,40})`?\s*\|/gm;

function listLedgers(repoRoot) {
  const dir = path.join(repoRoot, LEDGER_DIR);
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^ZC-.*\.md$/.test(name)) continue;
    out.push(path.join(dir, name));
  }
  return out;
}

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'], // 台账里的非提交哈希会让 rev-parse 报错，属预期，不往 stderr 喷
  });
}

// 返回 { commits: Map<fullSha, {ledger, subject}>, short: Map<shortSha, fullSha> }
export function loadOwnCommits(repoRoot) {
  const commits = new Map();
  const short = new Map();
  const sources = [];
  for (const file of listLedgers(repoRoot)) sources.push({ file, patterns: PATTERNS });
  const manual = path.join(repoRoot, MANUAL_FILE);
  if (fs.existsSync(manual)) sources.push({ file: manual, patterns: [MANUAL_PATTERN] });
  for (const { file, patterns } of sources) {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    for (const re of patterns) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const raw = m[1];
        let full;
        try {
          full = git(repoRoot, ['rev-parse', '--verify', `${raw}^{commit}`]).trim();
        } catch {
          continue; // 台账里的非提交哈希（文件 blob、工具版本等）解析失败即跳过
        }
        short.set(raw, full);
        if (!commits.has(full)) {
          const subject = git(repoRoot, ['log', '-1', '--format=%s', full]).trim();
          commits.set(full, { ledger: path.basename(file), subject });
        }
      }
    }
  }
  return { commits, short };
}

export function isOwnBlame(sha, whitelist) {
  if (!sha) return false;
  return whitelist.commits.has(sha);
}

// sha 能否解析成仓库里的一个 commit。解析失败不等于上游：它可能是短 sha 打错、
// 是 blob sha、或来自另一份历史。这类「不知道」必须单独成态，不能落进上游桶。
export function resolveCommit(repoRoot, sha) {
  if (!sha) return null;
  try {
    return git(repoRoot, ['rev-parse', '--verify', `${sha}^{commit}`]).trim();
  } catch {
    return null;
  }
}

// 三态判定：本线 / 上游 / 未解析。
// 上游也带证据（author + subject），让「为什么算上游」在报告里可直接引用，而不是一句话断言。
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
    console.error('用法: node own-commits.mjs <repoRoot> [--check <sha>...]');
    process.exit(2);
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
          ? `台账\t${r.subject}`
          : '(无 commit 证据)';
      console.log(`${sha}\t${r.state}\t${r.full ?? '(未解析)'}\t${ev}`);
    }
    console.log(`CHECK own=${tally.本线} upstream=${tally.上游} pending=${tally.未解析}`);
    if (tally.未解析) {
      console.error(
        `未解析 ${tally.未解析} 条：必须人工定归属（git log -1 --format='%an %ae %s' / 批次台账 / OWN-COMMITS.md）` +
          '并回填白名单后才允许放过；未回填的计入「待定」，不算豁免。',
      );
      process.exit(3);
    }
  } else {
    console.log(`白名单提交数 ${wl.commits.size}`);
    for (const [sha, info] of [...wl.commits].sort()) {
      console.log(`${sha.slice(0, 8)}\t${info.ledger}\t${info.subject}`);
    }
  }
}
