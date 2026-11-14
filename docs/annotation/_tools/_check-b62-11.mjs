import fs from "node:fs";
import path from "node:path";

const specPath = "d:\\code\\_annot_baseline\\ZC-deep-b62-spec-11.json";
const repoRoot = "d:\\code\\ZCode";
const EXPECTED_TOTAL = 71;

const problems = [];
const fail = (msg) => problems.push(msg);

if (!fs.existsSync(specPath)) {
  console.error(`FAIL: spec 不存在: ${specPath}`);
  process.exit(1);
}

let spec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
} catch (error) {
  console.error(`FAIL: spec 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (!spec || !Array.isArray(spec.files) || spec.files.length === 0) {
  console.error("FAIL: spec.files 为空");
  process.exit(1);
}

const bannedStart = [
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
const callLike = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

function checkText(text, label) {
  if (text.includes("*/")) fail(`${label}: 含 */`);
  const lower = text.toLowerCase();
  for (const keyword of bannedStart) {
    if (lower.startsWith(keyword)) {
      fail(`${label}: 以关键字 ${keyword} 开头 -> ${text}`);
      break;
    }
  }
  if (text.trimEnd().endsWith(";")) fail(`${label}: 以 ; 结尾 -> ${text}`);
  if (text.includes("=>")) fail(`${label}: 含 => -> ${text}`);
  if (callLike.test(text)) fail(`${label}: 含调用样式 ident.ident( -> ${text}`);
}

let total = 0;
let anchorCount = 0;

for (const entry of spec.files) {
  if (!entry || typeof entry.file !== "string") {
    fail("files 项缺少 file 字段");
    continue;
  }
  const targetPath = path.join(repoRoot, entry.file);
  if (!fs.existsSync(targetPath)) {
    fail(`目标文件不存在: ${targetPath}`);
    continue;
  }
  if (!Array.isArray(entry.items) || entry.items.length === 0) {
    fail(`${entry.file}: items 为空`);
    continue;
  }

  const fileLines = fs.readFileSync(targetPath, "utf8").split(/\r?\n/);
  const trimmed = fileLines.map((line) => line.trim());

  entry.items.forEach((item, index) => {
    const where = `${entry.file} items[${index}]`;
    const isFirst = index === 0;

    if (isFirst) {
      if (!Array.isArray(item.raw) || item.raw.length === 0) {
        fail(`${where}: 首项必须有非空 raw`);
        return;
      }
      item.raw.forEach((line, i) => {
        if (typeof line !== "string" || !(line.startsWith("// ") || line === "//")) {
          fail(`${where}.raw[${i}]: 未以 // 或 // 空格开头 -> ${String(line)}`);
          return;
        }
        checkText(line.replace(/^\/\/ ?/, ""), `${where}.raw[${i}]`);
      });
      total += item.raw.length;
    } else {
      if (!Array.isArray(item.lines) || item.lines.length === 0) {
        fail(`${where}: 非首项必须有非空 lines`);
        return;
      }
      item.lines.forEach((line, i) => {
        if (typeof line !== "string" || line.length === 0) {
          fail(`${where}.lines[${i}]: 空行或非字符串`);
          return;
        }
        if (line.startsWith("//")) fail(`${where}.lines[${i}]: lines 不得带 // 前缀 -> ${line}`);
        checkText(line, `${where}.lines[${i}]`);
      });
      total += item.lines.length;
    }

    if (typeof item.anchor !== "string" || item.anchor.trim() === "") {
      fail(`${where}: anchor 为空`);
      return;
    }
    anchorCount += 1;

    const wanted = item.anchor.trim();
    const matches = trimmed.filter((line) => line === wanted).length;
    if (matches < 1) {
      fail(`${where}: anchor 未匹配到 -> ${JSON.stringify(item.anchor)}`);
      return;
    }
    if (item.nth !== undefined) {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > matches) {
        fail(`${where}: nth=${item.nth} 越界（匹配 ${matches} 次）`);
      }
    } else if (matches !== 1) {
      fail(`${where}: anchor 不唯一（匹配 ${matches} 次），请改用 nth 或换行 -> ${JSON.stringify(item.anchor)}`);
    }
  });
}

if (total !== EXPECTED_TOTAL) {
  fail(`总插入行数 ${total} != ${EXPECTED_TOTAL}`);
}

if (problems.length > 0) {
  console.error(`FAIL: ${problems.length} 个问题`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}

const target = path.join(repoRoot, spec.files[0].file);
const splitLines = fs.readFileSync(target, "utf8").split(/\r?\n/);
const allLines = splitLines[splitLines.length - 1] === "" ? splitLines.slice(0, -1) : splitLines;
const lineComment = allLines.filter((line) => /^\s*\/\//.test(line)).length;
const blockComment = allLines.filter((line) => /^\s*(\/\*|\*)/.test(line)).length;
const blank = allLines.filter((line) => line.trim() === "").length;
const comments = lineComment + blockComment + total;
const code = allLines.length + total - comments - blank;
const ratio = ((comments / code) * 100).toFixed(2);

console.log(
  `OK 插入 ${total} 行，anchor ${anchorCount} 个；文件 ${allLines.length + total} 行，注释 ${comments} 行，代码 ${code} 行，注释/代码 ${ratio}%`,
);
