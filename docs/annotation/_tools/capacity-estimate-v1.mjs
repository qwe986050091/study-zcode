// 产能估算的可复算件：从 weak-own-by-file.tsv 基线 + 各批 rewrite.tsv 推出的已清集合，
// 逐档汇总剩余文件/行数，并对三条恒等式做断言（不等即 exit 1）：
//   1) Σ档位文件数 == 基线文件数 − 已清文件数
//   2) Σ档位行数   == 基线行数   − 已清行数
//   3) Σceil(档位文件数 / 每批文件数) == 批数
// 已清行数按「基线里该文件的计数」算，不按各批登记表条数算——两者口径不同（登记表可能多/少几行）。
import { readdirSync, readFileSync } from "node:fs";
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

const baseline = new Map();
for (const line of readFileSync(baselineFile, "utf8").split(/\r?\n/)) {
  const [count, file] = line.split("\t");
  if (count && file && /^\d+$/.test(count)) {
    baseline.set(file.trim(), Number(count));
  }
}

const done = new Set();
for (const name of readdirSync(ledgerDir)) {
  if (!/^ZC-deep-b\d+-rewrite\.tsv$/.test(name)) {
    continue;
  }
  for (const line of readFileSync(path.join(ledgerDir, name), "utf8").split(/\r?\n/)) {
    // 各批登记表列序不统一（有的 path 在前，有的在 hash 之后），所以逐字段找能对上基线的路径。
    for (const field of line.split("\t")) {
      const file = field.trim().replace(/:\d+$/, "");
      if (file && baseline.has(file)) {
        done.add(file);
        break;
      }
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
let doneLines = 0;
const remaining = [];
for (const [file, count] of baseline) {
  totalFiles += 1;
  totalLines += count;
  if (done.has(file)) {
    doneFiles += 1;
    doneLines += count;
    continue;
  }
  remaining.push({ file, count });
  const band = bands.get(bandOf(count));
  band.files += 1;
  band.lines += count;
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

const checks = [
  ["文件数", fileSum, totalFiles - doneFiles],
  ["行数", lineSum, totalLines - doneLines],
];

console.log(`baseline=${path.basename(baselineFile)} files=${totalFiles} lines=${totalLines}`);
console.log(`done files=${doneFiles} lines=${doneLines}  perBatch=${perBatch}`);
console.log("band\tfiles\tlines\tperBatch\tbatches(对照)");
for (const row of rows) {
  console.log(`${row.key}\t${row.files}\t${row.lines}\t${row.size}\t${row.batches}`);
}
console.log(
  `REMAIN\t${fileSum}\t${lineSum}\t-\t${batchSum}  （剩余；批数为对照/上界，不作为排期依据）`,
);

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
      console.log(`PLAN#${i + 1}\t${bin.files} 文件 / ${bin.lines} 行\t${bin.members.join(' , ')}`);
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

// 按文件成本折算总时长：s/文件 是与批大小无关的量，批数只在「每批耗时 = 该批文件数 × s/文件」时才有意义。
// 依据（b244 反例 + b245/b246/b247 与 b240/b241 的离散）：固定成本随扫描单元近似线性增长，合并文件不摊薄。
const perFileAt = process.argv.indexOf("--per-file");
if (perFileAt > 0) {
  const values = (process.argv[perFileAt + 1] ?? "14.9,20.6")
    .split(",")
    .map(Number)
    .filter(Number.isFinite);
  for (const value of values) {
    const seconds = fileSum * value;
    console.log(
      `HOURS\ts/文件=${value}\t剩余文件=${fileSum}\t${(seconds / 3600).toFixed(1)}h（${Math.round(seconds)}s）`,
    );
  }
  console.log("HOURS 口径：总时长 = 剩余文件数 × 单文件耗时；禁用「批数 × 每批耗时」，除非每批耗时按该批文件数放大。");
}

// 显式等式：基线与剩余之间只差「已清」，两侧必须闭口；批数是 Σceil(档位文件数 / 该档每批文件数)。
console.log(
  `ACCT files  done ${doneFiles} + remain ${fileSum} = ${totalFiles}  ${doneFiles + fileSum === totalFiles ? 'OK' : 'MISMATCH'}`,
);
console.log(
  `ACCT lines  done ${doneLines} + remain ${lineSum} = ${totalLines}  ${doneLines + lineSum === totalLines ? 'OK' : 'MISMATCH'}`,
);
console.log(
  `ACCT batches = Σ ceil(band.files / perBatch[band]) = ${batchSum}（口径：剩余文件数分档后合并，不是文件数也不是行数）`,
);

let failed = false;
for (const [label, actual, expected] of checks) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: ${actual} != ${expected}`);
    failed = true;
  }
}
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
