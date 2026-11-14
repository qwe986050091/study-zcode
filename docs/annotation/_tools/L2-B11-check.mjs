// L2-B11 校验：1) diff 删除列=0；2) TS parseDiagnostics=0；3) 新增行仅为注释/空行；4) /* 与 */ 计数相等。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = "d:\\code\\ZCode\\packages\\desktop\\src\\host";
const baseline = "d:\\code\\_annot_baseline\\L2-B11\\host";
const repo = "d:\\code\\ZCode";
const rels = process.argv.slice(2);
if (rels.length === 0) {
  console.error("usage: node L2-B11-check.mjs <rel> [<rel> ...]");
  process.exit(2);
}
const require = createRequire(path.join(repo, "package.json"));
const ts = require("typescript");
let failed = 0;
let totalAdded = 0;
for (const rel of rels) {
  const target = path.join(root, rel);
  const base = path.join(baseline, rel);
  if (!existsSync(target) || !existsSync(base)) {
    console.log(`ERR missing file: ${rel}`);
    failed += 1;
    continue;
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
    // git diff 无输出 = 文件与基线完全相同（无需改动）。
    console.log(`OK added=0 deleted=0 unchanged ${rel}`);
    continue;
  }
  const added = Number(nums[0]);
  const deleted = Number(nums[1]);
  totalAdded += added;
  if (deleted !== 0) {
    console.log(`ERR deleted=${deleted} (must be 0): ${rel}`);
    failed += 1;
    continue;
  }
  const full = spawnSync(
    "git",
    ["--no-pager", "diff", "--no-index", "--unified=0", base, target],
    { cwd: repo, encoding: "utf8" },
  );
  const bad = [];
  for (const line of (full.stdout || "").split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const text = line.slice(1).trim();
      if (
        text !== "" &&
        !text.startsWith("//") &&
        !text.startsWith("/*") &&
        !text.startsWith("*") &&
        !text.startsWith("/**")
      ) {
        bad.push(text);
      }
    }
  }
  if (bad.length > 0) {
    console.log(`ERR non-comment added lines (${bad.length}): ${rel}`);
    for (const text of bad.slice(0, 5)) console.log(`  ${text}`);
    failed += 1;
    continue;
  }
  const source = readFileSync(target, "utf8");
  const sf = ts.createSourceFile(target, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (sf.parseDiagnostics && sf.parseDiagnostics.length > 0) {
    console.log(`ERR syntax: ${rel}`);
    for (const d of sf.parseDiagnostics.slice(0, 5)) {
      console.log(`  ${d.start}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    }
    failed += 1;
    continue;
  }
  const openSlash = (source.match(/\/\*/g) || []).length;
  const closeSlash = (source.match(/\*\//g) || []).length;
  const baseSource = readFileSync(base, "utf8");
  const baseOpen = (baseSource.match(/\/\*/g) || []).length;
  const baseClose = (baseSource.match(/\*\//g) || []).length;
  // 允许源码字符串字面量里本来就有的 `*/`（如 Content-Range 模板），只要求新增注释不引入不平衡。
  if (openSlash - closeSlash !== baseOpen - baseClose) {
    console.log(
      `ERR block comment delimiters current /*=${openSlash} */=${closeSlash} baseline /*=${baseOpen} */=${baseClose}: ${rel}`,
    );
    failed += 1;
    continue;
  }
  console.log(`OK added=${added} deleted=0 syntax=0 commentDelims=${openSlash} ${rel}`);
}
console.log(failed === 0 ? `ALL OK totalAdded=${totalAdded}` : `FAILED=${failed} totalAdded=${totalAdded}`);
process.exit(failed === 0 ? 0 : 1);
