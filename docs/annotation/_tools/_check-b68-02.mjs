import { readFileSync } from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b68-spec-02.json";
const TARGET = "d:/code/ZCode/packages/ui/src/ToolCallBlocks/ToolSummaryRow.tsx";
const EXPECTED_LINES = 64;

const FORBIDDEN_START =
  /^(?:const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const CALL_EXPR = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

let spec;
try {
  spec = JSON.parse(readFileSync(SPEC, "utf8"));
} catch (err) {
  fail("JSON 无法解析：" + err.message);
}

if (!spec || !Array.isArray(spec.files)) fail("顶层缺少 files 数组");
if (spec.files.length !== 1) fail("files 必须恰好一个，实际 " + spec.files.length);

const entry = spec.files[0];
if (entry.file !== "packages/ui/src/ToolCallBlocks/ToolSummaryRow.tsx") {
  fail("file 路径不符：" + entry.file);
}
if (!Array.isArray(entry.items) || entry.items.length === 0) fail("items 为空");

const sourceLines = readFileSync(TARGET, "utf8").replace(/\r\n/g, "\n").split("\n");
const firstLine = sourceLines[0];

if (!entry.items[0] || entry.items[0].anchor !== firstLine) {
  fail("第一项 anchor 不等于文件首行：\n  anchor=" + JSON.stringify(entry.items[0]?.anchor) + "\n  first =" + JSON.stringify(firstLine));
}

let total = 0;
const composed = [];

entry.items.forEach((item, idx) => {
  if (typeof item.anchor !== "string" || item.anchor.trim() === "") {
    fail("第 " + (idx + 1) + " 项 anchor 为空");
  }
  const anchorText = item.anchor;
  const hits = sourceLines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.trim() === anchorText.trim());

  const nth = item.nth ?? 1;
  if (!Number.isInteger(nth) || nth < 1) fail("第 " + (idx + 1) + " 项 nth 非法：" + nth);
  if (hits.length === 0) fail("第 " + (idx + 1) + " 项 anchor 在文件中不存在：" + JSON.stringify(anchorText));
  if (hits.length > 1 && item.nth == null) {
    fail("第 " + (idx + 1) + " 项 anchor 重复出现 " + hits.length + " 次且未指定 nth：" + JSON.stringify(anchorText));
  }
  if (nth > hits.length) fail("第 " + (idx + 1) + " 项 nth=" + nth + " 超出匹配数 " + hits.length);

  const hasRaw = Array.isArray(item.raw);
  const hasLines = Array.isArray(item.lines);
  if (hasRaw === hasLines) fail("第 " + (idx + 1) + " 项必须且只能有 raw 或 lines 之一");

  const body = hasRaw ? item.raw : item.lines;
  if (body.length === 0) fail("第 " + (idx + 1) + " 项内容为空");

  if (idx === 0 && body.length !== 22) {
    fail("第一项必须 22 行，实际 " + body.length);
  }

  if (hasRaw) {
    for (const line of body) {
      if (typeof line !== "string") fail("第 " + (idx + 1) + " 项 raw 含非字符串");
      if (line !== "//" && !line.startsWith("// ")) fail("第 " + (idx + 1) + " 项 raw 行不是 // 注释：" + JSON.stringify(line));
      composed.push({ text: line, where: "item " + (idx + 1) + " raw" });
    }
  } else {
    for (const line of body) {
      if (typeof line !== "string") fail("第 " + (idx + 1) + " 项 lines 含非字符串");
      composed.push({ text: line, where: "item " + (idx + 1) + " lines" });
    }
  }

  total += body.length;
});

if (total !== EXPECTED_LINES) {
  fail("总行数必须 " + EXPECTED_LINES + "，实际 " + total);
}

for (const { text, where } of composed) {
  if (text.includes("*/")) fail(where + " 含 */：" + JSON.stringify(text));
  let content = text.trim();
  if (content.startsWith("//")) content = content.slice(2).trim();
  if (content === "") continue;
  if (FORBIDDEN_START.test(content)) fail(where + " 以禁用词开头：" + JSON.stringify(text));
  if (content.endsWith(";")) fail(where + " 以分号结尾：" + JSON.stringify(text));
  if (content.includes("=>")) fail(where + " 含 =>：" + JSON.stringify(text));
  if (CALL_EXPR.test(content)) fail(where + " 含方法调用表达式：" + JSON.stringify(text));
}

console.log("OK");
console.log("file      : " + entry.file);
console.log("items     : " + entry.items.length);
console.log("lines     : " + total);
