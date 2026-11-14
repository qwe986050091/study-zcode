// 规范化重复注释前缀：把行首的 `// // ...` 折叠回 `// ...`，正文不动。
// 只处理自有注释行（HEAD 中不存在的整行），并输出统计与样本用于入账。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = "d:\\code\\ZCode";
const files = [
  "packages/desktop/src/main/browserView/browserCommandPageHandlers.ts",
  "packages/desktop/src/main/browserView/browserScreenshotActivityController.ts",
  "packages/desktop/src/main/desktopBrowserViewIpc.ts",
  "packages/desktop/src/main/desktopFinderOpenFolderWorkflow.ts",
  "packages/desktop/src/main/pluginSandbox/host.ts",
];

const src = /^(\s*)\/\/[ \t]+\/\/([ \t]?)(.*)$/;
let total = 0;
const report = [];

for (const rel of files) {
  const abs = path.join(ROOT, rel);
  const original = fs.readFileSync(abs, "utf8");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const head = execFileSync("git", ["-C", ROOT, "show", `HEAD:${rel}`], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).split(/\r?\n/);
  const headLines = new Set(head.map((l) => l.trim()));
  let fixed = 0;
  let noSpace = 0;
  const samples = [];
  const out = lines.map((line) => {
    const m = src.exec(line);
    if (!m) return line;
    const body = m[3];
    const next = `${m[1]}// ${body}`;
    if (headLines.has(next.trim())) return line; // 上游句，保持原样
    fixed++;
    if (!m[2]) noSpace++;
    if (samples.length < 2) samples.push({ before: line, after: next });
    return next;
  });
  fs.writeFileSync(abs, out.join(eol));
  total += fixed;
  report.push({ rel, fixed, noSpace, samples });
}

console.log(JSON.stringify({ total, report }, null, 2));
