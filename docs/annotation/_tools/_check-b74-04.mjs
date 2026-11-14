import fs from "node:fs";

const SPEC_PATH = "d:\\code\\_annot_baseline\\ZC-deep-b74-spec-04.json";
const TARGET_PATH =
  "d:\\code\\ZCode\\packages\\ui\\src\\settings\\model-provider-section\\codingPlanProductPresentation.ts";
const REL_PATH =
  "packages/ui/src/settings/model-provider-section/codingPlanProductPresentation.ts";
const EXPECT_TOTAL = 60;
const EXPECT_HEADER = 22;

const errors = [];
const err = (m) => errors.push(m);

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
if (!Array.isArray(spec.files) || spec.files.length !== 1) {
  err("spec.files 必须恰好包含 1 个文件");
}
const entry = spec.files[0];
if (!entry || entry.file !== REL_PATH) {
  err("spec 中 file 路径与目标不一致");
}

const rawSource = fs.readFileSync(TARGET_PATH, "utf8");
const srcLines = rawSource.split("\n").map((l) => l.replace(/\r$/, ""));
const trimmed = srcLines.map((l) => l.trim());

const FORBIDDEN =
  /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const CALL_EXPR = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

let totalInserted = 0;
let blockCount = 0;
const usedIndexes = new Map();

const items = entry.items || [];
items.forEach((item, itemIdx) => {
  blockCount += 1;
  const outgoing = Array.isArray(item.raw)
    ? item.raw
    : Array.isArray(item.lines)
      ? item.lines
      : null;
  if (!outgoing) {
    err(`item[${itemIdx}] 缺少 raw 或 lines`);
    return;
  }
  if (typeof item.anchor !== "string" || item.anchor.trim() === "") {
    err(`item[${itemIdx}] anchor 为空`);
    return;
  }

  const anchorTrim = item.anchor.trim();
  if (anchorTrim.startsWith("//")) {
    err(`item[${itemIdx}] anchor 指向注释行: ${anchorTrim}`);
  }
  const matches = [];
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === anchorTrim) matches.push(i);
  }
  let targetIdx;
  if (item.nth !== undefined) {
    if (!Number.isInteger(item.nth) || item.nth < 1) {
      err(`item[${itemIdx}] nth 非法: ${item.nth}`);
      return;
    }
    if (matches.length < item.nth) {
      err(`item[${itemIdx}] anchor 命中 ${matches.length} 次，不足 nth=${item.nth}`);
      return;
    }
    targetIdx = matches[item.nth - 1];
  } else {
    if (matches.length === 0) {
      err(`item[${itemIdx}] anchor 未命中: ${anchorTrim}`);
      return;
    }
    if (matches.length > 1) {
      err(`item[${itemIdx}] anchor 命中 ${matches.length} 次（需唯一或指定 nth）: ${anchorTrim}`);
      return;
    }
    targetIdx = matches[0];
  }
  console.log(`anchor[${itemIdx}] hits=${matches.length} idx=${targetIdx}`);

  if (usedIndexes.has(targetIdx)) {
    err(`item[${itemIdx}] 插入下标 ${targetIdx} 与 item[${usedIndexes.get(targetIdx)}] 重复`);
  } else {
    usedIndexes.set(targetIdx, itemIdx);
  }
  const anchorLine = srcLines[targetIdx];
  const indentMatch = anchorLine.match(/^[ \t]*/);
  const indent = indentMatch ? indentMatch[0] : "";

  outgoing.forEach((rawLine, lineIdx) => {
    totalInserted += 1;
    if (typeof rawLine !== "string") {
      err(`item[${itemIdx}].line[${lineIdx}] 不是字符串`);
      return;
    }
    if (rawLine.includes("\n") || rawLine.includes("\r")) {
      err(`item[${itemIdx}].line[${lineIdx}] 含换行`);
    }
    const finalLine = Array.isArray(item.raw)
      ? rawLine
      : rawLine === ""
        ? `${indent}//`
        : `${indent}// ${rawLine}`;
    const t = finalLine.trim();
    if (!t.startsWith("//")) err(`item[${itemIdx}].line[${lineIdx}] 插入后不以 // 开头: ${t}`);
    if (t.includes("*/")) err(`item[${itemIdx}].line[${lineIdx}] 含 */`);
    const text = t.replace(/^\/\/\s?/, "").trim();
    if (text === "") return;
    if (FORBIDDEN.test(text)) err(`item[${itemIdx}].line[${lineIdx}] 以禁止词开头: ${text}`);
    if (text.endsWith(";")) err(`item[${itemIdx}].line[${lineIdx}] 以分号结尾: ${text}`);
    if (text.includes("=>")) err(`item[${itemIdx}].line[${lineIdx}] 含箭头: ${text}`);
    if (CALL_EXPR.test(text)) err(`item[${itemIdx}].line[${lineIdx}] 含调用表达式: ${text}`);
  });
});

const header = items[0];
if (!header || !Array.isArray(header.raw)) {
  err("第一个 item 必须使用 raw 并作为文件头");
} else {
  if (header.raw.length !== EXPECT_HEADER)
    err(`文件头 raw 长度 ${header.raw.length} != ${EXPECT_HEADER}`);
  if (!String(header.raw[0]).startsWith("// INV-01")) err("文件头首行未以 // INV-01 开头");
  if (header.raw[18] !== "//")
    err(`文件头第 19 行不是单独 //，实际: ${JSON.stringify(header.raw[18])}`);
  let invCount = 0;
  for (let i = 0; i < 18; i += 1) {
    const want = `// INV-${String(i + 1).padStart(2, "0")}`;
    if (String(header.raw[i]).startsWith(want)) invCount += 1;
    else err(`文件头 INV 序号错位: 期望 ${want}，实际 ${header.raw[i]}`);
  }
  if (invCount !== 18) err(`INV 行数 ${invCount} != 18`);
  const tail = header.raw.slice(19, 22);
  if (tail.length !== 3) err("文件头尾部职责说明不足 3 行");
  if (!String(tail[0]).startsWith("// 模块职责：")) err("文件头缺少 模块职责 行");
  if (!String(tail[1]).startsWith("// 状态所有权：")) err("文件头缺少 状态所有权 行");
  if (!String(tail[2]).startsWith("// 阅读顺序：")) err("文件头缺少 阅读顺序 行");
}

if (totalInserted !== EXPECT_TOTAL) err(`插入总行数 ${totalInserted} != ${EXPECT_TOTAL}`);

if (errors.length > 0) {
  console.error("FAIL");
  for (const e of errors) console.error(" - " + e);
  process.exit(1);
}
console.log(`OK blocks=${blockCount} lines=${totalInserted}`);
