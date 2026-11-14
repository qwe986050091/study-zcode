// 校验 L2-B6 注释：1) diff 删除列必须为 0；2) TypeScript 语法解析无诊断。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = "d:\\code\\ZCode\\apps\\zcode-cli\\packages\\adapters\\src";
const baseline = "d:\\code\\_annot_baseline\\L2-B6";
const repo = "d:\\code\\ZCode";
const rel = process.argv[2];
if (!rel) {
  console.error("usage: node L2-B6-check.mjs <relative-path>");
  process.exit(2);
}
const target = path.join(root, rel);
const base = path.join(baseline, rel);
if (!existsSync(target) || !existsSync(base)) {
  console.log(`ERR missing file: ${rel}`);
  process.exit(1);
}
const diff = spawnSync(
  "git",
  ["--no-pager", "diff", "--no-index", "--numstat", base, target],
  { cwd: repo, encoding: "utf8" },
);
const nums = (diff.stdout || "")
  .split(/\r?\n/)
  .map((line) => line.trim().split(/\s+/))
  .find((parts) => parts.length >= 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]));
if (!nums) {
  console.log(`ERR cannot read numstat: ${rel}`);
  process.exit(1);
}
const added = Number(nums[0]);
const deleted = Number(nums[1]);
if (deleted !== 0) {
  console.log(`ERR deleted=${deleted} (must be 0): ${rel}`);
  process.exit(1);
}
const require = createRequire(path.join(repo, "package.json"));
const ts = require("typescript");
const source = readFileSync(target, "utf8");
const sf = ts.createSourceFile(target, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
if (sf.parseDiagnostics && sf.parseDiagnostics.length > 0) {
  console.log(`ERR syntax: ${rel}`);
  for (const d of sf.parseDiagnostics.slice(0, 5)) {
    console.log(`  ${d.start}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  }
  process.exit(1);
}
console.log(`OK added=${added} deleted=0 syntax=0 ${rel}`);
