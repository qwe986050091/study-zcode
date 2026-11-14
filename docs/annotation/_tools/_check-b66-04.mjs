import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(here, "ZC-deep-b66-spec-04.json");
const targetPath = resolve(here, "..", "ZCode", "packages", "ui", "src", "WorkspaceHeader.tsx");
const EXPECTED_TOTAL = 66;

const fail = (msg) => {
  console.error("FAIL: " + msg);
  process.exit(1);
};

let spec;
try {
  spec = JSON.parse(readFileSync(specPath, "utf8"));
} catch (error) {
  fail("JSON 解析失败 " + error.message);
}

if (!Array.isArray(spec?.files) || spec.files.length !== 1) {
  fail("spec 必须且只能包含一个 files 项");
}

const fileEntry = spec.files[0];
if (fileEntry.file !== "packages/ui/src/WorkspaceHeader.tsx") {
  fail("file 字段不匹配 " + String(fileEntry.file));
}
if (!Array.isArray(fileEntry.items) || fileEntry.items.length === 0) {
  fail("items 为空");
}

const sourceLines = readFileSync(targetPath, "utf8").split(/\r?\n/);
const trimmedSource = sourceLines.map((line) => line.trim());
const firstLine = trimmedSource[0];

const forbiddenStart =
  /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const dottedCall = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const validateLines = (label, lines) => {
  if (!Array.isArray(lines)) fail(label + " 缺少 lines/raw 数组");
  for (const [index, raw] of lines.entries()) {
    if (typeof raw !== "string") fail(label + " 第 " + (index + 1) + " 行不是字符串");
    const at = label + " 第 " + (index + 1) + " 行";
    if (raw.includes("*/")) fail(at + " 含 */");
    if (raw.trimEnd().endsWith(";")) fail(at + " 以分号结尾");
    if (raw.includes("=>")) fail(at + " 含 =>");
    if (dottedCall.test(raw)) fail(at + " 含 obj.method( 形式调用 " + raw);
    if (raw.trim() === "") continue;
    const body = raw.startsWith("//") ? raw.replace(/^\/\/\s?/, "").trim() : raw.trim();
    if (forbiddenStart.test(body)) fail(at + " 以禁词开头 " + body);
  }
};

let total = 0;
for (const [index, item] of fileEntry.items.entries()) {
  const label = "item[" + index + "]";
  if (typeof item.anchor !== "string" || item.anchor.trim() === "") {
    fail(label + " anchor 为空");
  }
  const hasRaw = item.raw !== undefined;
  const hasLines = item.lines !== undefined;
  if (hasRaw === hasLines) fail(label + " 必须且只能有 raw 或 lines");
  const payload = hasRaw ? item.raw : item.lines;
  validateLines(label, payload);

  const anchor = item.anchor.trim();
  const hits = [];
  trimmedSource.forEach((line, lineIndex) => {
    if (line === anchor) hits.push(lineIndex);
  });
  if (hits.length === 0) fail(label + " anchor 不存在");
  const nth = item.nth;
  if (nth !== undefined) {
    if (!Number.isInteger(nth) || nth < 1 || nth > hits.length) {
      fail(label + " nth 非法 " + String(nth));
    }
  } else if (hits.length !== 1) {
    fail(label + " anchor 非唯一（命中 " + hits.length + " 次）");
  }

  if (index === 0) {
    if (hasLines) fail("第一项必须使用 raw");
    if (payload.length !== 22) fail("第一项 raw 行数为 " + payload.length + "，应为 22");
    if (item.anchor !== firstLine && item.anchor.trim() !== firstLine) {
      fail("第一项 anchor 不等于文件首行");
    }
    const invPrefixes = payload.slice(0, 18).map((line) => line.match(/^\/\/ INV-(\d{2}) /)?.[1]);
    invPrefixes.forEach((value, i) => {
      const expected = String(i + 1).padStart(2, "0");
      if (value !== expected) fail("第 " + (i + 1) + " 条 INV 编号不连续");
    });
    if (payload[18].trim() !== "//") fail("第一项第 19 行应为 //");
    if (!payload.slice(19).every((line) => line.startsWith("// "))) {
      fail("第一项模块说明必须是 3 行注释");
    }
  }

  total += payload.length;
}

if (total !== EXPECTED_TOTAL) {
  fail("注释总行数为 " + total + "，应为 " + EXPECTED_TOTAL);
}

console.log("OK sections=" + fileEntry.items.length + " total=" + total);
