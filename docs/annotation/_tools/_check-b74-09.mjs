import { readFileSync } from "node:fs";

const SPEC_PATH = "d:/code/_annot_baseline/ZC-deep-b74-spec-09.json";
const ROOT = "D:/code/ZCode";

const FORBIDDEN_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const DOT_CALL = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const errors = [];
const fail = (msg) => errors.push(msg);

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
if (!Array.isArray(spec.files) || spec.files.length !== 1) {
  fail("spec.files 必须恰好一个文件");
}
const entry = spec.files[0];
const items = entry.items || [];

let totalLines = 0;
const bodies = [];

const first = items[0];
if (!first || !Array.isArray(first.raw)) {
  fail("首块必须使用 raw");
} else {
  if (first.raw.length !== 22) fail(`首块 raw 行数应为 22，实际 ${first.raw.length}`);
  const inv = first.raw.filter((l) => /^\/\/ INV-\d{2} /.test(l));
  if (inv.length !== 18) fail(`首块 INV 行数应为 18，实际 ${inv.length}`);
  const bare = first.raw.filter((l) => l === "//");
  if (bare.length !== 1) fail(`首块纯空注释行应为 1，实际 ${bare.length}`);
  const nums = inv.map((l) => Number(/^\/\/ INV-(\d{2}) /.exec(l)[1]));
  const expect = Array.from({ length: 18 }, (_, i) => i + 1);
  if (nums.join(",") !== expect.join(",")) fail(`INV 编号需为 01..18 顺序，实际 ${nums.join(",")}`);
  const tail = first.raw.slice(-3);
  const tailOk =
    tail[0].includes("模块职责") && tail[1].includes("状态所有权") && tail[2].includes("阅读顺序");
  if (!tailOk) fail("首块末尾三行必须依次为 模块职责/状态所有权/阅读顺序");
  for (const raw of first.raw) {
    if (!raw.startsWith("//")) fail(`raw 行必须以 // 开头: ${raw}`);
    bodies.push({ text: raw.replace(/^\/\//, "").trim(), where: "raw" });
  }
  totalLines += first.raw.length;
}

for (let i = 1; i < items.length; i += 1) {
  const item = items[i];
  if (!Array.isArray(item.lines) || item.lines.length === 0) {
    fail(`第 ${i + 1} 块缺少 lines`);
    continue;
  }
  if (item.raw) fail(`第 ${i + 1} 块不应同时含 raw`);
  for (const line of item.lines) {
    if (typeof line !== "string") fail(`第 ${i + 1} 块存在非字符串行`);
    if (line.startsWith("//")) fail(`lines 元素不应自带 // 前缀: ${line}`);
    bodies.push({ text: line.trim(), where: `block#${i + 1}` });
  }
  totalLines += item.lines.length;
}

if (totalLines !== 61) fail(`总行数应为 61，实际 ${totalLines}`);

const filePath = `${ROOT}/${entry.file}`;
const src = readFileSync(filePath, "utf8").split(/\r?\n/);
const trimmed = src.map((l) => l.trim());

for (let i = 0; i < items.length; i += 1) {
  const item = items[i];
  const anchor = typeof item.anchor === "string" ? item.anchor.trim() : "";
  if (!anchor) {
    fail(`第 ${i + 1} 块 anchor 为空`);
    continue;
  }
  const hits = [];
  trimmed.forEach((line, idx) => {
    if (line === anchor) hits.push(idx);
  });
  const nth = item.nth ? Number(item.nth) : 0;
  if (nth) {
    if (!Number.isInteger(nth) || nth < 1) fail(`第 ${i + 1} 块 nth 非法: ${item.nth}`);
    if (hits.length < nth) fail(`第 ${i + 1} 块 anchor 命中 ${hits.length} 次，不足 nth=${nth}`);
    else if (trimmed[hits[nth - 1]].startsWith("//")) fail(`第 ${i + 1} 块 anchor 落在注释行`);
  } else {
    if (hits.length === 0) fail(`第 ${i + 1} 块 anchor 未命中: ${anchor}`);
    else if (hits.length > 1) fail(`第 ${i + 1} 块 anchor 不唯一(${hits.length}): ${anchor}`);
    else if (trimmed[hits[0]].startsWith("//")) fail(`第 ${i + 1} 块 anchor 落在注释行`);
  }
}

for (const { text, where } of bodies) {
  if (text.includes("*/")) fail(`[${where}] 含 */: ${text}`);
  if (text.endsWith(";")) fail(`[${where}] 以 ; 结尾: ${text}`);
  if (text.includes("=>")) fail(`[${where}] 含 =>: ${text}`);
  if (DOT_CALL.test(text)) fail(`[${where}] 含标识符.标识符(: ${text}`);
  const head = text.split(/\s+/)[0].replace(/^\/\//, "");
  if (FORBIDDEN_START.includes(head)) fail(`[${where}] 以禁用词开头(${head}): ${text}`);
}

if (errors.length) {
  console.error(`FAIL ${errors.length} 项`);
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
console.log(`OK blocks=${items.length} lines=${totalLines}`);
