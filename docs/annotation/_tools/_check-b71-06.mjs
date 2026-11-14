import { readFileSync } from "node:fs";

const specPath = "d:\\code\\_annot_baseline\\ZC-deep-b71-spec-06.json";
const targetPath = "d:\\code\\ZCode\\packages\\server\\src\\remote\\zcodeAgentDeploy.ts";
const EXPECTED_LINES = 62;
const HEADER_LINES = 22;

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const fileLines = readFileSync(targetPath, "utf8").split(/\r?\n/);

const FORBIDDEN_LEAD = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const CALL_RE = /\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

const failures = [];
const usedIndexes = new Map();
let total = 0;
const fileEntry = spec.files[0];
const items = fileEntry.items;

items.forEach((item, idx) => {
  const anchor = String(item.anchor ?? "");
  const anchorTrim = anchor.trim();
  if (!anchorTrim) {
    failures.push(`item#${idx}: 锚点为空`);
    return;
  }
  if (!anchor.includes(anchor.trim())) {
    failures.push(`item#${idx}: 锚点含首尾空白以外的问题`);
  }
  const matches = [];
  fileLines.forEach((line, i) => {
    if (line.trim() === anchorTrim) matches.push(i);
  });
  let targetIndex;
  if (item.nth !== undefined) {
    if (!Number.isInteger(item.nth) || item.nth < 1) {
      failures.push(`item#${idx}: nth 非法 ${item.nth}`);
      return;
    }
    if (matches.length < item.nth) {
      failures.push(`item#${idx}: 锚点第 ${item.nth} 次不存在，命中 ${matches.length} 次`);
      return;
    }
    targetIndex = matches[item.nth - 1];
  } else {
    if (matches.length !== 1) {
      failures.push(`item#${idx}: 锚点不唯一，命中 ${matches.length} 次: ${anchorTrim}`);
      return;
    }
    targetIndex = matches[0];
  }
  if (usedIndexes.has(targetIndex)) {
    failures.push(
      `item#${idx}: 插入下标与 item#${usedIndexes.get(targetIndex)} 重复: ${targetIndex}`,
    );
    return;
  }
  usedIndexes.set(targetIndex, idx);

  const indent = (fileLines[targetIndex].match(/^\s*/) || [""])[0];
  let emitted = [];
  if (Array.isArray(item.raw)) {
    if (item.lines) failures.push(`item#${idx}: 同时存在 raw 与 lines`);
    emitted = item.raw.map((s) => String(s));
  } else if (Array.isArray(item.lines)) {
    emitted = item.lines.map((s) => {
      const text = String(s);
      return text === "" ? `${indent}//` : `${indent}// ${text}`;
    });
  } else {
    failures.push(`item#${idx}: 缺少 raw 或 lines`);
    return;
  }

  if (item.raw && idx !== 0) failures.push(`item#${idx}: 只有文件头允许使用 raw`);
  if (item.raw && emitted.length !== HEADER_LINES) {
    failures.push(`item#${idx}: 文件头 raw 长度 ${emitted.length}，应为 ${HEADER_LINES}`);
  }
  if (item.raw) {
    if (!emitted[0].startsWith("// INV-01")) {
      failures.push(`item#${idx}: 文件头首行未以 // INV-01 开头`);
    }
    if (emitted[18] !== "//") {
      failures.push(`item#${idx}: 文件头第 19 行不是裸 //，实际: ${emitted[18]}`);
    }
    if (!emitted.slice(0, 18).every((l, i) => l.startsWith(`// INV-${String(i + 1).padStart(2, "0")} `))) {
      failures.push(`item#${idx}: 文件头 INV 序号不连续`);
    }
  } else if (emitted.length < 3 || emitted.length > 6) {
    failures.push(`item#${idx}: 块行数 ${emitted.length}，应在 3~6 之间`);
  }

  emitted.forEach((line, j) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("//")) {
      failures.push(`item#${idx}[${j}]: trim 后未以 // 开头: ${trimmed}`);
      return;
    }
    if (trimmed.includes("*/")) {
      failures.push(`item#${idx}[${j}]: 含 */: ${trimmed}`);
    }
    const body = trimmed.replace(/^\/\/+/, "").trim();
    const lead = (body.match(/^[A-Za-z_$][\w$]*/) || [""])[0];
    if (FORBIDDEN_LEAD.includes(lead)) {
      failures.push(`item#${idx}[${j}]: // 之后以禁用词开头 ${lead}: ${trimmed}`);
    }
    if (body.endsWith(";") || trimmed.endsWith(";")) {
      failures.push(`item#${idx}[${j}]: 以分号结尾: ${trimmed}`);
    }
    if (body.includes("=>")) {
      failures.push(`item#${idx}[${j}]: 含箭头 =>: ${trimmed}`);
    }
    if (CALL_RE.test(body)) {
      failures.push(`item#${idx}[${j}]: 含调用表达式: ${trimmed}`);
    }
  });

  total += emitted.length;
});

if (total !== EXPECTED_LINES) {
  failures.push(`总新增行数 ${total} !== ${EXPECTED_LINES}`);
}
if (items.length === 0) failures.push("items 为空");

if (failures.length > 0) {
  console.error("FAIL");
  failures.forEach((f) => console.error(" - " + f));
  process.exit(1);
}

console.log(`OK blocks=${items.length} lines=${total}`);
