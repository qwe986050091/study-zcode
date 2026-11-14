import { readFileSync } from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b60-spec-05.json";
const targetPath = "d:/code/ZCode/packages/ui/src/plugin-ui/adapters/pluginUiPagePlane.ts";

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const raw = readFileSync(targetPath, "utf8");
const fileLines = raw.split(/\r?\n/);
const trimmed = fileLines.map((l) => l.trim());

const entry = spec.files?.[0];
const items = entry?.items ?? [];
const problems = [];

const forbiddenStart = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const callForm = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

let total = 0;
let rawCount = 0;
const report = [];

for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const body = item.raw ?? item.lines;
  if (!Array.isArray(body)) {
    problems.push(`item ${i}: 缺少 raw/lines`);
    continue;
  }
  if (item.raw) rawCount++;
  total += body.length;

  const anchor = typeof item.anchor === "string" ? item.anchor.trim() : "";
  const occurrences = [];
  trimmed.forEach((l, idx) => {
    if (l === anchor) occurrences.push(idx + 1);
  });
  const nth = item.nth ?? 0;
  const ok = nth ? occurrences.length >= nth : occurrences.length === 1;
  if (!ok) {
    problems.push(
      `item ${i}: anchor 匹配失败（出现 ${occurrences.length} 次，nth=${nth || "-"}）：${anchor}`,
    );
  }
  report.push(`item ${String(i).padStart(2, "0")} lines=${body.length} occ=${occurrences.length} nth=${nth || "-"}`);

  for (let j = 0; j < body.length; j++) {
    let text = body[j];
    if (item.raw) {
      if (!text.startsWith("//")) {
        problems.push(`item ${i} line ${j}: raw 行未以 // 开头`);
        continue;
      }
      text = text.slice(2);
      if (text.startsWith(" ")) text = text.slice(1);
    }
    const t = text.trim();
    if (!t) continue;
    if (t.includes("=>")) problems.push(`item ${i} line ${j}: 含 =>`);
    if (t.includes("*/")) problems.push(`item ${i} line ${j}: 含 */`);
    if (t.endsWith(";")) problems.push(`item ${i} line ${j}: 以 ; 结尾`);
    if (callForm.test(t)) problems.push(`item ${i} line ${j}: 调用形态`);
    const first = t.split(/[\s:：,，、]/)[0];
    if (forbiddenStart.includes(first)) problems.push(`item ${i} line ${j}: 禁词开头 ${first}`);
    for (const w of forbiddenStart) {
      if (t === w || t.startsWith(w + " ") || t.startsWith(w + "(")) {
        problems.push(`item ${i} line ${j}: 禁词开头 ${w}`);
        break;
      }
    }
  }
}

// 文件头校验：第一条必须是 raw，锚点是首条 import，且排在所有非 raw 项之前
const head = items[0];
if (!head?.raw) problems.push("首条 item 不是 raw 文件头");
const firstImportIdx = trimmed.findIndex((l) => l.startsWith("import "));
if (head?.anchor?.trim() !== trimmed[firstImportIdx]) {
  problems.push("文件头 anchor 不是首条 import 原文");
}
if (items.slice(1).some((it) => it.raw)) problems.push("除文件头外仍存在 raw item");

const invCount = (head?.raw ?? []).filter((l) => /^\/\/ INV-\d\d /.test(l)).length;
if (invCount < 18 || invCount > 20) problems.push(`INV 条数越界：${invCount}`);
if ((head?.raw ?? []).at(-1) !== "//") problems.push("文件头末尾不是 // 空行");
const overview = (head?.raw ?? []).filter((l) => l === "//").length;

console.log(report.join("\n"));
console.log(`\nitems=${items.length} raw=${rawCount} INV=${invCount} 空行=${overview} 总行数=${total}`);
console.log(`anchor 检查：${problems.some((p) => p.includes("anchor")) ? "失败" : "通过"}`);
if (problems.length) {
  console.log("\n问题：");
  for (const p of problems) console.log(" - " + p);
  process.exitCode = 1;
} else {
  console.log("全部自检通过");
}
if (total !== 72) {
  console.log(`总行数不是 72（允许 72~74）：${total}`);
  process.exitCode = 1;
}
