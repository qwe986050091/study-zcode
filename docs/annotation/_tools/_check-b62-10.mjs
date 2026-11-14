import fs from "node:fs";
import path from "node:path";

const ROOT = "d:/code";
const SPEC = path.join(ROOT, "_annot_baseline", "ZC-deep-b62-spec-10.json");
const TARGET = path.join(ROOT, "ZCode", "packages", "desktop", "src", "main", "browserDataManager.ts");
const EXPECT_TOTAL = 67;

const fail = (msg) => {
  console.error("FAIL " + msg);
  process.exit(1);
};

if (!fs.existsSync(SPEC)) fail("spec 不存在");
if (!fs.existsSync(TARGET)) fail("目标文件不存在");

const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
const entry = spec.files?.[0];
if (!entry || entry.file !== "packages/desktop/src/main/browserDataManager.ts") fail("file 字段不正确");
const items = entry.items;
if (!Array.isArray(items) || items.length === 0) fail("items 为空");

const targetLines = fs.readFileSync(TARGET, "utf8").split(/\r?\n/);
const trimmed = targetLines.map((l) => l.trim());

// 1) 首项 raw
const first = items[0];
if (!Array.isArray(first.raw) || first.raw.length === 0) fail("首项缺少 raw");
const invSeen = [];
for (const line of first.raw) {
  if (!(line.startsWith("// ") || line === "//")) fail("raw 行缺少注释前缀: " + line);
  const m = /^\/\/ INV-(\d{2}) /.exec(line);
  if (m) invSeen.push(Number(m[1]));
}
if (invSeen.length !== 18) fail("INV 条数不是 18: " + invSeen.length);
for (let i = 0; i < 18; i += 1) {
  if (invSeen[i] !== i + 1) fail("INV 编号不连续，位置 " + (i + 1) + " 为 " + invSeen[i]);
}
const markerIdx = first.raw.findIndex((l) => l === "//");
if (markerIdx !== 18) fail("INV 之后缺少单行空注释");
const moduleLines = first.raw.slice(19);
if (moduleLines.length !== 3) fail("模块说明应为 3 行");
if (!moduleLines[0].includes("模块职责：")) fail("缺少模块职责");
if (!moduleLines[1].includes("状态所有权：")) fail("缺少状态所有权");
if (!moduleLines[2].includes("阅读顺序：")) fail("缺少阅读顺序");

// 2) 其余项 lines
let total = first.raw.length;
for (let i = 1; i < items.length; i += 1) {
  const it = items[i];
  if (!Array.isArray(it.lines) || it.lines.length === 0) fail("第 " + (i + 1) + " 项缺少 lines");
  for (const line of it.lines) {
    if (line.startsWith("//")) fail("lines 不应含注释前缀: " + line);
  }
  total += it.lines.length;
}
if (total !== EXPECT_TOTAL) fail("总行数 " + total + " !== " + EXPECT_TOTAL);

// 3) 禁词检查
const BANNED_HEAD =
  /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const CALL_STYLE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;
const checkText = (text, label) => {
  if (text.includes("*/")) fail(label + " 含 */");
  const lower = text.trim().toLowerCase();
  if (BANNED_HEAD.test(lower)) fail(label + " 以关键字开头: " + text);
  if (text.trimEnd().endsWith(";")) fail(label + " 以分号结尾: " + text);
  if (text.includes("=>")) fail(label + " 含 =>: " + text);
  if (CALL_STYLE.test(text)) fail(label + " 含调用样式: " + text);
};
for (const line of first.raw) checkText(line.replace(/^\/\/ ?/, ""), "raw");
for (let i = 1; i < items.length; i += 1) {
  for (const line of items[i].lines) checkText(line, "items[" + i + "].lines");
}

// 4) anchor 匹配
for (let i = 0; i < items.length; i += 1) {
  const it = items[i];
  if (typeof it.anchor !== "string" || it.anchor.trim() === "") fail("第 " + (i + 1) + " 项 anchor 为空");
  const anchor = it.anchor.trim();
  const hits = [];
  for (let k = 0; k < trimmed.length; k += 1) {
    if (trimmed[k] === anchor) hits.push(k + 1);
  }
  if (hits.length === 0) fail("anchor 未命中: " + anchor);
  if (it.nth !== undefined) {
    if (!Number.isInteger(it.nth) || it.nth < 1 || it.nth > hits.length) {
      fail("nth 越界: " + anchor + " (命中 " + hits.length + " 次)");
    }
  }
}

console.log("anchors=" + items.length + ", inserted=" + total + ", targetLines=" + targetLines.length);
console.log("OK");
