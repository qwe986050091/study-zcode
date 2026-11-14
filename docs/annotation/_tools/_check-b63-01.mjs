import fs from "node:fs";
import path from "node:path";

const specPath = "d:/code/_annot_baseline/ZC-deep-b63-spec-01.json";
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

const EXPECTED_TOTAL = 69;
const BANNED_START = [
  "const",
  "let",
  "var",
  "function",
  "class",
  "import",
  "export",
  "return",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "try",
  "catch",
  "await",
  "async",
  "throw",
  "new",
  "interface",
  "type",
  "enum",
];
const START_RE = new RegExp("^(" + BANNED_START.join("|") + ")\\b");
const DOTTED_CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const errors = [];

function fail(msg) {
  errors.push(msg);
}

function stripPrefix(line) {
  if (line.startsWith("// ")) return line.slice(3);
  if (line === "//") return "";
  if (line.startsWith("//")) return line.slice(2);
  return line;
}

function checkContent(where, text) {
  if (text.includes("*/")) fail(where + ": 含禁词 */");
  if (START_RE.test(text)) fail(where + ": 以禁用关键字开头 -> " + text);
  if (text.endsWith(";")) fail(where + ": 以分号结尾 -> " + text);
  if (text.includes("=>")) fail(where + ": 含 => -> " + text);
  if (DOTTED_CALL_RE.test(text)) fail(where + ": 含点调用 -> " + text);
}

const files = spec.files;
if (!Array.isArray(files) || files.length === 0) fail("files 为空");

let grandTotal = 0;

for (const entry of files) {
  const target = path.resolve("d:/code/ZCode", entry.file);
  const sourceLines = fs.readFileSync(target, "utf8").split(/\r?\n/);
  if (sourceLines.length && sourceLines[sourceLines.length - 1] === "") sourceLines.pop();
  const trimmed = sourceLines.map((l) => l.trim());

  const items = entry.items;
  if (!Array.isArray(items) || items.length === 0) {
    fail(entry.file + ": items 为空");
    continue;
  }

  let total = 0;

  items.forEach((item, idx) => {
    const where = entry.file + " item#" + (idx + 1);
    let contentLines = [];

    if (idx === 0) {
      if (!Array.isArray(item.raw) || item.raw.length === 0) {
        fail(where + ": 首项缺少 raw");
        return;
      }
      item.raw.forEach((line) => {
        if (!(line.startsWith("// ") || line === "//")) {
          fail(where + ": raw 行未以 // 注释开头 -> " + line);
        }
        contentLines.push(stripPrefix(line));
      });
      total += item.raw.length;
    } else {
      if (!Array.isArray(item.lines) || item.lines.length === 0) {
        fail(where + ": 缺少 lines");
        return;
      }
      item.lines.forEach((line) => {
        if (line.startsWith("//")) fail(where + ": lines 不应带 // 前缀 -> " + line);
        contentLines.push(line);
      });
      total += item.lines.length;
    }

    contentLines.forEach((line, i) => checkContent(where + " line#" + (i + 1), line.trim()));

    const anchor = String(item.anchor ?? "").trim();
    if (!anchor) {
      fail(where + ": anchor 为空");
      return;
    }
    const hits = trimmed.reduce((acc, line, i) => (line === anchor ? acc.concat(i + 1) : acc), []);
    if (hits.length === 0) {
      fail(where + ": anchor 无匹配 -> " + anchor);
      return;
    }
    if (item.nth !== undefined) {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
        fail(where + ": nth 越界，匹配数 " + hits.length + " -> " + anchor);
      }
    } else if (hits.length !== 1) {
      fail(where + ": anchor 不唯一，匹配 " + hits.length + " 次 -> " + anchor);
    }
  });

  if (total !== EXPECTED_TOTAL) {
    fail(entry.file + ": 总行数 " + total + " != " + EXPECTED_TOTAL);
  }
  grandTotal += total;

  const commentCount = sourceLines.filter((l) => l.trim().startsWith("//")).length + total;
  const codeCount = sourceLines.filter(
    (l) => l.trim() !== "" && !l.trim().startsWith("//"),
  ).length;
  const ratio = commentCount / codeCount;
  console.log(
    entry.file +
      " -> 插入行数 " + total +
      ", 注释 " + commentCount +
      ", 代码 " + codeCount +
      ", 注释/代码 " + (ratio * 100).toFixed(2) + "%",
  );
}

if (grandTotal !== EXPECTED_TOTAL) fail("合计行数 " + grandTotal + " != " + EXPECTED_TOTAL);

if (errors.length) {
  console.error("FAIL");
  errors.forEach((e) => console.error(" - " + e));
  process.exit(1);
}
console.log("OK");
