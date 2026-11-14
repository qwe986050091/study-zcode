// 批量校验并输出 TSV：rel <tab> added <tab> deleted <tab> syntaxErrors <tab> totalLines
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = "d:\\code\\ZCode\\apps\\zcode-cli\\packages\\adapters\\src";
const baseline = "d:\\code\\_annot_baseline\\L2-B6";
const repo = "d:\\code\\ZCode";
const require = createRequire(path.join(repo, "package.json"));
const ts = require("typescript");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(root);
const rows = [];
for (const file of files) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  const base = path.join(baseline, rel);
  const diff = spawnSync("git", ["--no-pager", "diff", "--no-index", "--numstat", base, file], {
    cwd: repo,
    encoding: "utf8",
  });
  let added = 0;
  let deleted = 0;
  const nums = (diff.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts.length >= 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]));
  if (nums) {
    added = Number(nums[0]);
    deleted = Number(nums[1]);
  }
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const errors = sf.parseDiagnostics?.length ?? 0;
  const totalLines = source.split(/\r?\n/).length;
  rows.push({ rel, added, deleted, errors, totalLines });
}
rows.sort((a, b) => a.rel.localeCompare(b.rel));
for (const row of rows) {
  console.log(`${row.rel}\t${row.added}\t${row.deleted}\t${row.errors}\t${row.totalLines}`);
}
const sumAdded = rows.reduce((sum, row) => sum + row.added, 0);
const badDel = rows.filter((row) => row.deleted !== 0);
const badSyntax = rows.filter((row) => row.errors !== 0);
console.error(`SUMMARY files=${rows.length} added=${sumAdded} deletedNonZero=${badDel.length} syntaxErr=${badSyntax.length}`);
