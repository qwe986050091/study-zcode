// 产能估算的可复算件：从 weak-own-by-file.tsv 基线 + 各批 rewrite.tsv 推出的已清集合，
// 逐档汇总剩余文件/行数，并对恒等式做断言（不等即 exit 1）。
//
// v2（b264）：ACCT 记账单位从「文件」改为「行」。
//   - 旧口径：文件一旦出现在任一 rewrite.tsv 就整份扣掉基线行数（all-or-nothing）。
//     于是「文件 done 但还剩 1 行 weak」会被记成 0 行残留，差额只能人工核（b263 的 +1 就是
//     cuaDetails.tsx:14——整文件扣了 23 行，实际只清了 22 行）。
//   - 新口径：done 文件按「基线 weak − 现 weak」记账；现 weak 来自当前 `--list-weak` 快照
//     与池定义（`git diff -U0 <pool-base> HEAD` 的 `+` 行）的交集。
//   - 新增断言：`acct_remain == pool_remain`，不等即 exit 1。不允许人工核出「差 1 已知」后放过：
//     差 1 说明要么有文件漏登、要么池定义漂了，二者都必须先解释再继续。
//
// 池内 weak 的构成（b265 定稿，`8beabb5b` 实测）：
//   权威口径（收口判「清零」只看它）：`packages,apps,docs/knip` = 6,425 → b265 后 6,325。
//   其中 `packages,apps` = 6,376 + `docs/knip` 49（4 个文件：16+13+12+8）。
//   6,476 / 6,676 / 6,576 / 6,525 这些数一律是「packages,apps 投影」或旧快照，
//   只能当参考，**不可与权威数相减**（差 49 就是这个漏扫，不是记账差）。
//   本件的 pool 与 `--weak` 必须同域覆盖 packages,apps,docs/knip：漏扫 docs/knip 会让
//   `ALIGNED` 的 diff = −49，这条断言就是那次漏扫的检出器。
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const repo = path.resolve(opt("repo", "."));
const baselineFile = path.resolve(
  opt("baseline", path.join(repo, "..", "_annot_baseline", "snapshot", "weak-own-by-file.tsv")),
);
const ledgerDir = path.resolve(opt("ledger-dir", path.join(repo, "docs", "annotation")));
const perBatch = Number(opt("per-batch", "2"));
// 分档合并倍数：--per-batch-map ">=20:2,5-9:3,1-2:6"，未列出的档位用 --per-batch。
const perBatchMap = new Map(
  (opt("per-batch-map", "") || "")
    .split(",")
    .map((pair) => pair.split(":"))
    .filter((pair) => pair.length === 2)
    .map(([band, size]) => [band.trim(), Number(size)]),
);

const weakFile = opt("weak", "");
const poolBase = opt("pool-base", "8f7daaf0");
if (!weakFile) {
  console.error(
    "缺少 --weak <deep-quality --list-weak 输出>：ACCT 自 v2 起按行记账，必须给当前 weak 快照；" +
      "没有快照就无法算「基线 weak − 现 weak」，也就无法断言 pool_remain == acct_remain。",
  );
  process.exit(2);
}

// 白名单新鲜度：meta.head ≠ 当前 HEAD 即拒跑。b280 首跑把 92 行中的 85 行判成「上游自清」，
// 就是因为 54ee8612 还没进 OWN-COMMITS.tsv——归户翻转不报错，只让 done 少算。
const ownMetaFile = path.join(repo, "docs", "annotation", "_tools", "OWN-COMMITS.meta.json");
let ownMeta = null;
try {
  ownMeta = JSON.parse(readFileSync(ownMetaFile, "utf8"));
} catch {
  ownMeta = null;
}
const headNow = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (!ownMeta || !ownMeta.head) {
  console.error(`WHITELIST MISSING 缺 ${ownMetaFile}：先重跑 own-commits-gen.mjs <repo> 再跑产能`);
  process.exit(2);
}
if (ownMeta.head !== headNow) {
  let behind = "?";
  try {
    behind = execFileSync("git", ["-C", repo, "rev-list", "--count", `${ownMeta.head}..HEAD`], {
      encoding: "utf8",
    }).trim();
  } catch {
    behind = "?";
  }
  console.error(
    `WHITELIST STALE 白名单落后 ${behind} 个提交（生成于 ${ownMeta.head.slice(0, 12)}，当前 HEAD ${headNow.slice(0, 12)}）：` +
      "先重跑 own-commits-gen.mjs <repo> 再跑产能",
  );
  process.exit(2);
}
console.log(`WHITELIST OK head=${headNow.slice(0, 12)} rows=${ownMeta.rows}`);

const baseline = new Map();
for (const line of readFileSync(baselineFile, "utf8").split(/\r?\n/)) {
  const [count, file] = line.split("\t");
  if (count && file && /^\d+$/.test(count)) {
    baseline.set(file.trim(), Number(count));
  }
}

// 快照入读（b273 起）：统一剥 BOM，并断言「物理非空行 == 成功识别行」。
// 起因：PowerShell 5.1 的 `>` 会写 UTF-8 BOM，`^WEAK\t` 会漏掉首行，SELF-CLEAR 凭空多一条（b272 实测：
// App.tsx:295 被误报自清，剥 BOM 后 SELF-CLEAR 由 2 回到 1）。SUMMARY 的 weak=N 再与明细行数对一次账。
const readWeakSnapshot = (file) => {
  const resolved = path.resolve(file);
  let text = readFileSync(resolved, "utf8");
  const hadBom = text.charCodeAt(0) === 0xfeff;
  if (hadBom) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  const physical = lines.filter((l) => l.trim() !== "").length;
  const rows = [];
  const unknown = [];
  let known = 0;
  let headerWeak = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^WEAK\t(.+):(\d+)\t/);
    if (m) {
      rows.push([m[1], Number(m[2])]);
      known += 1;
      continue;
    }
    const h = line.match(/^WEAK lines=(\d+) files=\d+$/);
    if (h) {
      headerWeak = Number(h[1]);
      known += 1;
      continue;
    }
    if (
      /^SUMMARY\s/.test(line) ||
      /^RATIOS\s/.test(line) ||
      /^MAP\s/.test(line) ||
      /^metric\t/.test(line) ||
      /^v3\t/.test(line)
    ) {
      known += 1;
      continue;
    }
    unknown.push(line);
  }
  if (unknown.length || known !== physical) {
    console.error(`快照解析失败：${file}（${hadBom ? "检测到 BOM，已剥" : "无 BOM"}）`);
    console.error(`  物理非空行 ${physical} / 识别 ${known} / 未识别 ${unknown.length}`);
    for (const line of unknown.slice(0, 3)) console.error(`  未识别行：${JSON.stringify(line.slice(0, 120))}`);
    process.exit(9);
  }
  if (headerWeak !== null && headerWeak !== rows.length) {
    console.error(`快照自相矛盾：${file} 的表头 WEAK lines=${headerWeak}，明细 ${rows.length} 行`);
    process.exit(9);
  }
  const map = new Map();
  for (const [f, ln] of rows) {
    if (!map.has(f)) map.set(f, new Set());
    map.get(f).add(ln);
  }
  return map;
};

// 当前 weak 逐行明细：`WEAK\t<file>:<line>\t<原因>\t<正文>`
const weakLines = readWeakSnapshot(weakFile);

// --pre-weak：本批改写前的同一作用域 --list-weak 快照。
// 用途只有一个：把「弱→强」拆成「自己改的」和「相邻改写后自动转强的」（self-clearing）。
// 后者不进配额，因为它不需要落笔；b264 的 3 条块尾 `*/` 就是这一类。
const preWeakFile = opt("pre-weak", "");
const preWeakLines = preWeakFile ? readWeakSnapshot(preWeakFile) : new Map();

// 输入批号校验（b267 事故固化）：`--pre-weak` 必须是「上一批的批后全仓快照」，
// 不是「上一批的批前快照」。b267 首次把 b266-weak-before 当批前，SELF-CLEAR 把 b266 已清的
// subagents.ts:93 又列了一遍——这次只污染归桶，若同类错误发生在 --weak 基数上会直接改池子。
// 判据在开始逐档汇总之前执行，靠文件名里的批号判定，不接受人工写「差 N 已知」。
const batchTag = opt("batch", "");
const batchNum = (s) => {
  const m = /(?:^|\D)b(\d{3})(?:\D|$)/.exec(s);
  return m ? Number(m[1]) : null;
};
const baseName = (p) => path.basename(p);
if (batchTag) {
  const cur = batchNum(batchTag);
  if (cur === null) {
    console.error(`--batch 应形如 b267，收到 ${batchTag}`);
    process.exit(2);
  }
  const prev = cur - 1;
  const tagOf = (n) => `b${String(n).padStart(3, "0")}`;
  const check = (file, want, role) => {
    const got = batchNum(baseName(file));
    if (got === null) {
      console.error(
        `BATCHCHK FAIL ${role} 文件名里没有批号：${baseName(file)}；` +
          `期望 ${tagOf(want)} 的批后快照（如 ${tagOf(want)}-repo-post.txt）`,
      );
      process.exit(6);
    }
    if (got !== want) {
      console.error(
        `BATCHCHK FAIL ${role} 批号 ${tagOf(got)} ≠ 期望 ${tagOf(want)}：${baseName(file)}；` +
          `期望 ${tagOf(want)} 的批后快照（如 ${tagOf(want)}-repo-post.txt）`,
      );
      process.exit(6);
    }
  };
  if (!preWeakFile) {
    console.error(`BATCHCHK FAIL 给了 --batch ${batchTag} 但没给 --pre-weak；期望 ${tagOf(prev)} 的批后快照`);
    process.exit(6);
  }
  // 批前快照 = 上一批的**批后**快照：文件名必须带 post 且不能带 before。
  // 只比批号不够：b266-weak-before.txt 的批号也是 266，负控实测能骗过纯批号校验。
  const checkPost = (file, role) => {
    const n = baseName(file).toLowerCase();
    if (!n.includes("post") || n.includes("before")) {
      console.error(
        `BATCHCHK FAIL ${role} 不是批后快照：${baseName(file)}；` +
          `期望上一批的批后快照（如 ${tagOf(prev)}-repo-post.txt），不是该批的 before / 批前快照`,
      );
      process.exit(6);
    }
  };
  check(preWeakFile, prev, "--pre-weak");
  checkPost(preWeakFile, "--pre-weak");
  // 批后快照 = 本批批号（批号校验已保证两份文件不同批，不可能同文件）。
  check(weakFile, cur, "--weak");
  console.log(`BATCHCHK ${batchTag} pre=${baseName(preWeakFile)} weak=${baseName(weakFile)}  OK`);
}

// 池定义：`git diff -U0 <pool-base> HEAD` 的 `+` 行（与 diffsets.mjs 同源）。
const pool = new Map();
{
  const diff = execFileSync(
    "git",
    ["-C", repo, "--no-pager", "diff", "-U0", "--no-color", "--no-ext-diff", poolBase, "HEAD"],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  let cur = null;
  for (const ln of diff.split("\n")) {
    if (ln.startsWith("+++ b/")) {
      cur = ln.slice(6);
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(ln);
    if (m && cur) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) {
        if (!pool.has(cur)) pool.set(cur, new Set());
        for (let k = 0; k < count; k += 1) pool.get(cur).add(start + k);
      }
    }
  }
}
// 只数池内 weak（= 本线在池里的剩余），池外与上游都不进 ACCT。
const curInPool = new Map();
for (const [file, lines] of weakLines) {
  const poolSet = pool.get(file);
  if (!poolSet) continue;
  let n = 0;
  for (const ln of lines) if (poolSet.has(ln)) n += 1;
  if (n) curInPool.set(file, n);
}

// done 仍是「文件集合」：出现在任一 rewrite.tsv 即算已排期；但记账改按行。
const done = new Set();
const rewritten = new Set();
for (const name of readdirSync(ledgerDir)) {
  if (!/^ZC-deep-b\d+-rewrite\.tsv$/.test(name)) {
    continue;
  }
  for (const line of readFileSync(path.join(ledgerDir, name), "utf8").split(/\r?\n/)) {
    const fields = line.split("\t");
    for (let i = 0; i < fields.length; i += 1) {
      const file = fields[i].trim();
      if (file && baseline.has(file)) {
        done.add(file);
        const next = (fields[i + 1] ?? "").trim();
        if (/^\d+$/.test(next)) rewritten.add(`${file}:${Number(next)}`);
        break;
      }
    }
  }
}

// self-clearing：改前 weak、改后不 weak，且不在本批（或历批）登记表里 —— 没落笔却转强了。
// 典型成因是块尾 `*/`：句元向下合并时它跟着前一行判弱，前一行写强后自动转强。
const selfClearing = [];
if (preWeakLines.size) {
  for (const [file, lines] of preWeakLines) {
    const now = weakLines.get(file) ?? new Set();
    for (const ln of lines) {
      if (now.has(ln)) continue;
      if (rewritten.has(`${file}:${ln}`)) continue;
      selfClearing.push({ file, line: ln });
    }
  }
}

const bandOf = (count) =>
  count >= 20 ? ">=20" : count >= 10 ? "10-19" : count >= 5 ? "5-9" : count >= 3 ? "3-4" : "1-2";
const order = [">=20", "10-19", "5-9", "3-4", "1-2"];
const bands = new Map(order.map((k) => [k, { files: 0, lines: 0 }]));

let totalFiles = 0;
let totalLines = 0;
let doneFiles = 0;
let clearedLines = 0;
let acctRemain = 0;
let poolRemain = 0;
const remaining = [];
const partials = [];
const regressions = [];
const drift = [];
for (const [file, count] of baseline) {
  totalFiles += 1;
  totalLines += count;
  const cur = curInPool.get(file) ?? 0;
  poolRemain += cur;
  const isDone = done.has(file);
  // done 文件按「基线 − 现」记已清；未 done 文件沿用基线（模型假设：没排期的文件没被动过）。
  const cleared = isDone ? count - cur : 0;
  if (isDone) clearedLines += cleared;
  if (cleared < 0) regressions.push({ file, base: count, cur, delta: cleared });
  const remain = isDone ? cur : count;
  acctRemain += remain;
  if (!isDone && cur !== count) drift.push({ file, base: count, cur, delta: cur - count });
  if (remain > 0) {
    if (isDone) partials.push({ file, base: count, cur });
    remaining.push({ file, count: remain });
    const band = bands.get(bandOf(remain));
    band.files += 1;
    band.lines += remain;
  } else {
    doneFiles += 1;
  }
}

let batchSum = 0;
let fileSum = 0;
let lineSum = 0;
const rows = order.map((key) => {
  const { files, lines } = bands.get(key);
  const size = perBatchMap.get(key) ?? perBatch;
  const batches = Math.ceil(files / size);
  batchSum += batches;
  fileSum += files;
  lineSum += lines;
  return { key, files, lines, size, batches };
});

console.log(`baseline=${path.basename(baselineFile)} files=${totalFiles} lines=${totalLines}`);
console.log(
  `done files=${doneFiles} lines=${clearedLines}（行口径：Σ 基线 weak − 现 weak）  perBatch=${perBatch}`,
);
console.log(`weak=${path.basename(path.resolve(weakFile))} pool-base=${poolBase}`);
console.log("band\tfiles\tlines\tperBatch\tbatches(对照)");
for (const row of rows) {
  console.log(`${row.key}\t${row.files}\t${row.lines}\t${row.size}\t${row.batches}`);
}
console.log(
  `REMAIN\t${fileSum}\t${lineSum}\t-\t${batchSum}  （剩余；批数为对照/上界，不作为排期依据）`,
);
if (partials.length) {
  console.log(`PARTIAL\t${partials.length} 个 done 文件仍有池内 weak，已按剩余行回池排期`);
  for (const p of partials.slice(0, 10)) {
    console.log(`PARTIAL\t${p.file}\t基线 ${p.base} → 现 ${p.cur}`);
  }
}
if (regressions.length) {
  console.error(`FAIL 回退：${regressions.length} 个 done 文件的池内 weak 比基线还多`);
  for (const r of regressions.slice(0, 10)) {
    console.error(`FAIL ${r.file}\t基线 ${r.base} → 现 ${r.cur}（${r.delta}）`);
  }
}

// 每片三态摘要（b264 起）：writable = 本线可改写行，upstream = 上游不可写行，pending = 未解析。
// 配额分母必须用 writable：上游行怎么排都写不了（PLAN#1 就是按 weak 总数 107 分的配额，
// 其中 4 行属于上游，于是每片都注定差 4 行）。只在 --plan-print 的成员文件上现算，
// 不为 900+ 个剩余文件逐个跑 blame。
const blameCache = new Map();
function blameShas(file) {
  if (blameCache.has(file)) return blameCache.get(file);
  const out = execFileSync('git', ['-C', repo, '--no-pager', 'blame', '--porcelain', '--', file], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const shas = [];
  let cur = null;
  for (const ln of out.split('\n')) {
    const m = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(ln);
    if (m) {
      cur = m[1];
      continue;
    }
    if (ln.startsWith('\t')) shas.push(cur);
  }
  blameCache.set(file, shas);
  return shas;
}
let ownCache = null;
async function ownSet() {
  if (!ownCache) {
    const { loadOwnCommits } = await import('./own-commits.mjs');
    ownCache = loadOwnCommits(repo).commits;
  }
  return ownCache;
}
async function triState(files) {
  const wl = await ownSet();
  const out = { writable: 0, upstream: 0, pending: 0, poolOut: 0 };
  for (const file of files) {
    const lines = weakLines.get(file);
    if (!lines) continue;
    const poolSet = pool.get(file) ?? new Set();
    const shas = blameShas(file);
    for (const ln of lines) {
      // 池外的 weak 行（本线提交但非 `+` 行，或上游行早于池基线）既不进配额也不进 ACCT，
      // 但会出现在 --list-weak 里，必须单列，否则「weak 掉了 N+1 行」会被误读成 N 行配额。
      if (!poolSet.has(ln)) {
        out.poolOut += 1;
        continue;
      }
      const sha = shas[ln - 1];
      if (!sha || /^0{40}$/.test(sha)) out.pending += 1;
      else if (wl.has(sha)) out.writable += 1;
      else out.upstream += 1;
    }
  }
  return out;
}

// self-clearing 的归属：只有落在「可写桶」里的自清行才该从配额里扣掉。
// 可写桶的定义与 triState 一致：**在池内** 且 blame 命中白名单。
// 上游桶的自清行（b264 的 3 条 `*/`）本来就不在配额内，扣它会重复计数；
// 池外的自清行（b265 的 agent.ts:225，块尾 `*/`，sha 早于池基线）同理——
// 它不在 ACCT/pool 任何一侧，扣配额会让「配额 99」与「实际清 100 行」对不上。
const selfClearWritable = new Map();
if (selfClearing.length) {
  const wl = await ownSet();
  const t = { writable: 0, upstream: 0, pending: 0, outOfPool: 0 };
  const rows = [];
  for (const s of selfClearing) {
    const shas = blameShas(s.file);
    const sha = shas[s.line - 1];
    let kind;
    if (!pool.get(s.file)?.has(s.line)) kind = 'out-of-pool';
    else if (!sha || /^0{40}$/.test(sha)) kind = 'pending';
    else if (wl.has(sha)) kind = 'writable';
    else kind = 'upstream';
    if (kind === 'out-of-pool') t.outOfPool += 1;
    else t[kind] += 1;
    if (kind === 'writable') selfClearWritable.set(s.file, (selfClearWritable.get(s.file) ?? 0) + 1);
    rows.push(`  ${s.file}:${s.line}\t${(sha ?? '').slice(0, 8)}\t${kind}`);
  }
  console.log(
    `SELF-CLEAR n=${selfClearing.length}\t可写桶 ${t.writable} / 池外 ${t.outOfPool} / 上游桶 ${t.upstream} / 未解析 ${t.pending}\t` +
      `（只有可写桶进配额扣减）`,
  );
  for (const r of rows) console.log(r);
}

// 唯一计划口径：≤N 文件且 ≤M 行/批，按行数降序贪心装箱。
// 参数来自实测（b243 6 文件、b247 5 文件）与立项上限（100 行/批），不是拍脑袋的合并倍数。
const planAt = process.argv.indexOf("--plan");
if (planAt > 0) {
  const [maxFiles, maxLines] = (process.argv[planAt + 1] ?? "6x100").split("x").map(Number);
  const bins = [];
  for (const entry of [...remaining].sort((a, b) => b.count - a.count)) {
    const bin = bins.find((b) => b.files < maxFiles && b.lines + entry.count <= maxLines);
    if (bin) {
      bin.files += 1;
      bin.lines += entry.count;
      bin.members.push(entry.file);
    } else {
      bins.push({ files: 1, lines: entry.count, members: [entry.file] });
    }
  }
  // 排期表前 N 批（成员逐条列出），用于「取第一个未做批次」而不是只看批数。
  const printAt = process.argv.indexOf('--plan-print');
  if (printAt > 0) {
    const n = Math.max(1, Number(process.argv[printAt + 1] ?? 1));
    for (let i = 0; i < Math.min(n, bins.length); i += 1) {
      const bin = bins[i];
      const tri = await triState(bin.members);
      const selfClear = bin.members.reduce((n, f) => n + (selfClearWritable.get(f) ?? 0), 0);
      // 自清行在「当前」池里已不是 weak，所以它在四态里必然落 pool-out，不进 quota 扣减。
      // 只有可写桶里的自清行才会扣（那种行当前仍在池内），两者由 selfClearWritable 区分。
      const quota = tri.writable - selfClear;
      // 断言：池内三桶（可写/上游/未解析）之和 == 成员文件里「weak ∩ pool」的行数；
      // 四态之和（再 + pool-out）== 这 5 个文件的 weak 合计。
      // 注意 pool 是 `git diff +` 全行集（含已转强的行），不能直接拿来和桶相加。
      const poolIn = tri.writable + tri.upstream + tri.pending;
      let poolWeak = 0;
      let weakTotal = 0;
      for (const f of bin.members) {
        const wl2 = weakLines.get(f);
        if (!wl2) continue;
        weakTotal += wl2.size;
        const ps = pool.get(f);
        for (const ln of wl2) if (ps?.has(ln)) poolWeak += 1;
      }
      console.log(
        `PLAN#${i + 1}\t${bin.files} 文件 / ${bin.lines} 行\t` +
          `writable=${tri.writable} upstream=${tri.upstream} self-clearing=${selfClear} ` +
          `pool-out=${tri.poolOut} pending=${tri.pending} ` +
          `quota=${quota}(writable ${tri.writable} − self-clearing ${selfClear}) ` +
          `四态和=${poolIn + tri.poolOut}=weak合计 ${weakTotal} 池内weak=${poolIn}/池内实测 ${poolWeak}\t` +
          `${bin.members.join(' , ')}`,
      );
      if (poolIn !== poolWeak || poolIn + tri.poolOut !== weakTotal) {
        console.error(
          `FAIL PLAN#${i + 1} 四态合计 ${poolIn} + 池外 ${tri.poolOut} ≠ weak 合计 ${weakTotal}，` +
            `或池内 ${poolIn} ≠ 实测 ${poolWeak}：分类有漏行或重复计数`,
        );
        process.exitCode = 5;
      }
      if (quota < bin.lines) {
        console.log(
          `PLAN#${i + 1} 配额 ${quota} < 计划 ${bin.lines}：超出本线可写行，实际按 ${quota} 行排`,
        );
      }
      if (tri.pending) {
        console.error(`FAIL PLAN#${i + 1} 有 ${tri.pending} 行归属未解析：先回填 OWN-COMMITS.tsv 再排期`);
        process.exitCode = 3;
      }
    }
  }
  const avgFiles = bins.length ? fileSum / bins.length : 0;
  const avgLines = bins.length ? lineSum / bins.length : 0;
  console.log(
    `PLAN\t${bins.length} 批\t口径=≤${maxFiles} 文件且 ≤${maxLines} 行/批\t均值 ${avgFiles.toFixed(1)} 文件 / ${avgLines.toFixed(1)} 行`,
  );
  console.log(
    `PLAN 依据：近批实测 5–6 文件/批（b243 6、b247 5），立项上限 100 行/批；此数是唯一排期口径，其余批数仅作对照/上界。`,
  );
}

// 显式等式：基线与剩余之间只差「已清」，两侧必须闭口；批数是 Σceil(档位文件数 / 该档每批文件数)。
console.log(
  `ACCT files  done ${doneFiles} + remain ${fileSum} = ${totalFiles}  ${doneFiles + fileSum === totalFiles ? 'OK' : 'MISMATCH'}`,
);
console.log(
  `ACCT lines  done ${clearedLines} + remain ${acctRemain} = ${totalLines}  ${clearedLines + acctRemain === totalLines ? 'OK' : 'MISMATCH'}`,
);
console.log(
  "ACCT NOTE 恒等式只对池内成立（池 = 基线 diff 的 + 行 ∩ 本线 blame）；池外 weak 不进 done/remain，另计为外部观测",
);
console.log(
  `ACCT batches = Σ ceil(band.files / perBatch[band]) = ${batchSum}（口径：剩余文件数分档后合并，不是文件数也不是行数）`,
);

// 两条账必须相等：ACCT 的「剩余行」与池定义实测的「池内 weak」。
// 口径同域（b264 定稿）：两侧都覆盖 `packages,apps,docs/knip`。49 行是 docs/knip 的 weak，
// 必须计入；漏扫 docs/knip 会让 diff = −49 ——这个断言就是那次漏扫的检出器。
const poolOk = acctRemain === poolRemain;
console.log(
  `ALIGNED acct_remain=${acctRemain} pool_remain=${poolRemain} diff=${acctRemain - poolRemain}  ${poolOk ? 'OK' : 'MISMATCH'}`,
);

let failed = false;
if (doneFiles + fileSum !== totalFiles) {
  console.error(`FAIL 文件数: done ${doneFiles} + remain ${fileSum} != ${totalFiles}`);
  failed = true;
}
if (clearedLines + acctRemain !== totalLines) {
  console.error(`FAIL 行数: done ${clearedLines} + remain ${acctRemain} != ${totalLines}`);
  failed = true;
}
if (!poolOk) {
  console.error(
    `FAIL acct_remain ${acctRemain} != pool_remain ${poolRemain}（差 ${acctRemain - poolRemain}）：` +
      "要么有 done 文件漏登、要么池定义/基线漂了；先解释再继续，不接受「已知差 N」。",
  );
  for (const d of drift.slice(0, 10)) {
    console.error(`DRIFT ${d.file}\t基线 ${d.base} → 池内 ${d.cur}（${d.delta}）`);
  }
  failed = true;
}
if (regressions.length) failed = true;
// 批数的边界：每批至少 1 个文件、至多 max(perBatch) 个；越界说明合并倍数或分档算错。
const maxPerBatch = Math.max(perBatch, ...perBatchMap.values());
if (batchSum > fileSum || batchSum < Math.ceil(fileSum / maxPerBatch)) {
  console.error(`FAIL 批数: ${batchSum} 不在 [${Math.ceil(fileSum / maxPerBatch)}, ${fileSum}]`);
  failed = true;
}
if (failed) {
  process.exit(1);
}
console.log("ASSERT PASS");
