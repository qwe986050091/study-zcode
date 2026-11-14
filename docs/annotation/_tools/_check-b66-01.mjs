import fs from "node:fs";
import path from "node:path";

const repo = "d:/code/ZCode";
const specPath = "d:/code/_annot_baseline/ZC-deep-b66-spec-01.json";
const EXPECTED_TOTAL = 66;
const BANNED_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const START_RE = new RegExp("^(" + BANNED_START.join("|") + ")\\b");
const DOTTED_CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const problems = [];
const fail = (msg) => problems.push(msg);

function stripPrefix(line) {
  if (line === "//") return "";
  if (line.startsWith("// ")) return line.slice(3);
  if (line.startsWith("//")) return line.slice(2);
  return line;
}

function checkText(where, line) {
  const text = stripPrefix(String(line)).trim();
  if (text.includes("*/")) fail(`${where}: 含 */`);
  if (START_RE.test(text)) fail(`${where}: 以禁用关键字开头 -> ${text}`);
  if (text.endsWith(";")) fail(`${where}: 以 ; 结尾 -> ${text}`);
  if (text.includes("=>")) fail(`${where}: 含 => -> ${text}`);
  if (DOTTED_CALL_RE.test(text)) fail(`${where}: 含点号调用 -> ${text}`);
}

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

if (!Array.isArray(spec.files) || spec.files.length !== 1) {
  fail(`files 必须且只能有一项，实际 ${Array.isArray(spec.files) ? spec.files.length : "非数组"}`);
}

const entry = spec.files?.[0];
if (!entry || !Array.isArray(entry.items) || entry.items.length === 0) {
  fail("items 为空");
}

const abs = entry ? path.join(repo, entry.file) : "";
if (entry && !fs.existsSync(abs)) fail(`目标文件不存在: ${abs}`);

let total = 0;

if (fs.existsSync(abs) && entry && Array.isArray(entry.items)) {
  const srcLines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  if (srcLines.length && srcLines[srcLines.length - 1] === "") srcLines.pop();
  const trimmed = srcLines.map((l) => l.trim());

  entry.items.forEach((item, i) => {
    const where = `item[${i}]`;

    if (!item || typeof item.anchor !== "string" || item.anchor.trim().length === 0) {
      fail(`${where}: 缺少 anchor`);
      return;
    }

    if (i === 0) {
      if (!Array.isArray(item.raw)) {
        fail(`${where}: 首项必须有 raw 数组`);
        return;
      }
      if (item.raw.length !== 22) fail(`${where}: raw 行数为 ${item.raw.length}，应为 22`);
      if (item.raw[18] !== "//") fail(`${where}: 第 19 行应为 //，实际 -> ${item.raw[18]}`);
      const invs = item.raw.filter((l) => String(l).startsWith("// INV-"));
      if (invs.length !== 18) fail(`${where}: INV 条数为 ${invs.length}，应为 18`);
      for (let k = 0; k < 18; k += 1) {
        const nn = String(k + 1).padStart(2, "0");
        const line = String(item.raw[k]);
        if (!line.startsWith(`// INV-${nn} `)) fail(`${where}: INV-${nn} 缺失或顺序错`);
        if (!/；守住位置：.+；改错故障：.+。$/.test(line)) fail(`${where}: INV-${nn} 结构不符`);
      }
      item.raw.forEach((line, j) => {
        if (!(line === "//" || line.startsWith("// "))) fail(`${where}.raw[${j}]: 前缀不是注释`);
        checkText(`${where}.raw[${j}]`, line);
      });
      total += item.raw.length;
    } else {
      if (!Array.isArray(item.lines) || item.lines.length === 0) {
        fail(`${where}: 必须有 lines`);
        return;
      }
      item.lines.forEach((line, j) => {
        if (typeof line !== "string") fail(`${where}.lines[${j}]: 非字符串`);
        else checkText(`${where}.lines[${j}]`, line);
      });
      total += item.lines.length;
    }

    const anchor = item.anchor.trim();
    const hits = trimmed.reduce((acc, line, idx) => (line === anchor ? acc.concat(idx + 1) : acc), []);
    if (hits.length === 0) {
      fail(`${where}: anchor 无匹配 -> ${anchor}`);
      return;
    }
    if (item.nth !== undefined) {
      if (!Number.isInteger(item.nth) || item.nth < 1) fail(`${where}: nth 非法`);
      else if (item.nth > hits.length) fail(`${where}: nth 越界 ${item.nth}/${hits.length}`);
    } else if (hits.length !== 1) {
      fail(`${where}: anchor 出现 ${hits.length} 次，非唯一 -> ${anchor}`);
    }

    if (i === 0 && anchor !== trimmed[0]) {
      fail(`${where}: 首项 anchor 不等于文件首行 -> ${anchor} vs ${trimmed[0]}`);
    }
  });
}

if (total !== EXPECTED_TOTAL) fail(`总注释行数为 ${total}，应为 ${EXPECTED_TOTAL}`);

if (problems.length > 0) {
  console.error("FAIL");
  problems.forEach((p) => console.error("- " + p));
  process.exit(1);
}

console.log(`OK total=${total} items=${entry.items.length} anchors=valid file=${entry.file}`);
