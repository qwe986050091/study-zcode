import fs from "node:fs";
import path from "node:path";

const repoRoot = "d:/code/ZCode";
const specPath = "d:/code/_annot_baseline/ZC-deep-b63-spec-06.json";
const EXPECTED_TOTAL = 69;

const RESERVED = [
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
const MEMBER_CALL = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const errors = [];
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

if (!spec.files || spec.files.length !== 1) {
  errors.push("files 必须恰好包含 1 个文件项");
}

for (const fileEntry of spec.files ?? []) {
  const items = fileEntry.items;
  if (!Array.isArray(items) || items.length === 0) {
    errors.push("items 为空");
    continue;
  }

  const absFile = path.join(repoRoot, fileEntry.file);
  if (!fs.existsSync(absFile)) {
    errors.push(`目标文件不存在：${absFile}`);
    continue;
  }
  const fileLines = fs.readFileSync(absFile, "utf8").split(/\r?\n/);
  const trimmedLines = fileLines.map((line) => line.trim());

  let total = 0;
  const anchorReport = [];

  items.forEach((item, index) => {
    if (typeof item.anchor !== "string") {
      errors.push(`items[${index}] 缺少 anchor`);
      return;
    }

    if (index === 0) {
      if (!Array.isArray(item.raw) || item.raw.length === 0) {
        errors.push("首项必须提供非空 raw");
      } else {
        total += item.raw.length;
        item.raw.forEach((line, li) => {
          if (typeof line !== "string" || (!line.startsWith("// ") && line !== "//")) {
            errors.push(`items[0].raw[${li}] 未以 // 开头：${String(line)}`);
          }
          checkBanned(`items[0].raw[${li}]`, line.replace(/^\/\/ ?/, ""));
        });
      }
      if (Array.isArray(item.lines)) {
        errors.push("首项不应同时声明 lines");
      }
    } else {
      if (!Array.isArray(item.lines) || item.lines.length === 0) {
        errors.push(`items[${index}] 缺少非空 lines`);
      } else {
        total += item.lines.length;
        item.lines.forEach((line, li) => checkBanned(`items[${index}].lines[${li}]`, line));
      }
      if (Array.isArray(item.raw)) {
        errors.push(`items[${index}] 不应声明 raw`);
      }
    }

    const anchorTrimmed = item.anchor.trim();
    const matches = [];
    trimmedLines.forEach((line, li) => {
      if (line === anchorTrimmed) matches.push(li + 1);
    });

    if (matches.length === 0) {
      errors.push(`items[${index}] anchor 无法匹配：${item.anchor}`);
      return;
    }
    if (item.nth !== undefined) {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > matches.length) {
        errors.push(`items[${index}] nth 越界：${item.nth}，实际匹配 ${matches.length} 次`);
      }
    } else if (matches.length !== 1) {
      errors.push(`items[${index}] anchor 不唯一（${matches.length} 次）：${item.anchor}`);
    }
    anchorReport.push(`  行 ${matches[item.nth ? item.nth - 1 : 0]}: ${anchorTrimmed.slice(0, 72)}`);
  });

  if (total !== EXPECTED_TOTAL) {
    errors.push(`总行数 ${total}，期望 ${EXPECTED_TOTAL}`);
  }
  console.log(`anchor 数：${items.length}`);
  console.log(anchorReport.join("\n"));
  console.log(`总插入行数：${total}`);
}

function checkBanned(label, text) {
  if (text.includes("*/")) errors.push(`${label} 含 */`);
  const firstToken = (text.match(/^[A-Za-z_$][\w$]*/) ?? [null])[0];
  if (firstToken && RESERVED.includes(firstToken)) {
    errors.push(`${label} 以保留字 ${firstToken} 开头`);
  }
  if (/;\s*$/.test(text)) errors.push(`${label} 以分号结尾`);
  if (text.includes("=>")) errors.push(`${label} 含 =>`);
  if (MEMBER_CALL.test(text)) errors.push(`${label} 含成员调用表达式`);
}

if (errors.length > 0) {
  console.log("FAIL");
  errors.forEach((error) => console.log(`- ${error}`));
  process.exit(1);
}

console.log("OK");
