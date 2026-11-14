// 生成去重后的清理队列：同一判据（zc-gate）扫全部命中文件，按注水行数降序。
// 用法：node zc-clean-queue.mjs [out.txt] [--all]
//   --all  扫描所有批次快照里的去重文件（分母=全部新增注释行，得到真实注水率）
// 输出列：waterLines \t addedCommentLines \t batches \t era \t rel
import fs from "node:fs";
import { scanFile } from "./zc-gate.mjs";

const P = "D:/code/_annot_baseline/";
const audit = JSON.parse(fs.readFileSync(P + "qc-poem-audit.json", "utf8"));
const byFile = new Map();
for (const o of audit.occurrences) {
  const cur = byFile.get(o.file) ?? { batches: new Set() };
  cur.batches.add(String(o.batch));
  byFile.set(o.file, cur);
}

const all = process.argv.includes("--all");
if (all) {
  for (const d of fs.readdirSync(P, { withFileTypes: true })) {
    if (!d.isDirectory() || !/^ZC-deep-b/.test(d.name) || !fs.existsSync(`${P}${d.name}/orig`)) continue;
    const label = d.name.replace(/^ZC-deep-/, "");
    const walk = (dir, pre) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = pre ? pre + "/" + e.name : e.name;
        if (e.isDirectory()) walk(dir + "/" + e.name, rel);
        else if (/\.(ts|tsx)$/.test(e.name)) {
          const cur = byFile.get(rel) ?? { batches: new Set() };
          cur.batches.add(label);
          byFile.set(rel, cur);
        }
      }
    };
    walk(`${P}${d.name}/orig`, "");
  }
}

const rows = [];
for (const rel of [...byFile.keys()].sort()) {
  let res;
  try {
    res = scanFile(rel);
  } catch (e) {
    console.error(`FAIL ${rel}: ${e.message}`);
    process.exit(1);
  }
  const batches = [...byFile.get(rel).batches].join(",");
  const nums = batches
    .split(",")
    .map((b) => +((/^b?(\d+)/i.exec(b) ?? [0, 0])[1]))
    .filter(Boolean);
  const era = nums.some((n) => n >= 121 && n <= 180) ? "B121-180" : nums.some((n) => n <= 120) ? "B1-120" : "B181+";
  if (!res.findings.length) {
    rows.push({ rel, water: 0, added: res.addedCommentLines, batches, era });
    continue;
  }
  const set = new Set();
  for (const f of res.findings) for (let l = f.line; l <= f.endLine; l++) set.add(l);
  rows.push({ rel, water: set.size, added: res.addedCommentLines, batches, era });
}

rows.sort((a, b) => b.water - a.water || b.added - a.added || a.rel.localeCompare(b.rel));
const out = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : P + (all ? "zc-clean-queue-all.txt" : "zc-clean-queue.txt");
fs.writeFileSync(out, rows.map((r) => `${r.water}\t${r.added}\t${r.batches}\t${r.era}\t${r.rel}`).join("\n") + "\n", "utf8");
const totalWater = rows.reduce((s, r) => s + r.water, 0);
const totalAdded = rows.reduce((s, r) => s + r.added, 0);
const bad = rows.filter((r) => r.water > 0);
for (const r of bad.slice(0, 15)) console.log(`${r.water}\t${r.era}\t${r.rel}`);
console.log(
  `SUMMARY files=${rows.length} badFiles=${bad.length} waterLines=${totalWater} addedCommentLines=${totalAdded} waterRate=${((totalWater / totalAdded) * 100).toFixed(2)}%`,
);
