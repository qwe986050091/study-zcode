import fs from "node:fs";
import path from "node:path";

const repo = "d:/code/ZCode";
const specPath = "d:/code/_annot_baseline/ZC-deep-b64-spec-11.json";
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

const BANNED_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

let total = 0;
const problems = [];

if (!Array.isArray(spec.files) || spec.files.length !== 1) problems.push("files 必须且只能有一项");
const entry = spec.files?.[0];
if (!entry || !Array.isArray(entry.items) || entry.items.length === 0) problems.push("items 为空");

const abs = entry ? path.join(repo, entry.file) : "";
if (!entry || !fs.existsSync(abs)) problems.push(`目标文件不存在: ${abs}`);
const srcLines = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8").split(/\r?\n/) : [];
const firstLine = (srcLines[0] ?? "").trim();

function checkText(text, where) {
  if (typeof text !== "string") {
    problems.push(`${where}: 非字符串`);
    return;
  }
  if (text.includes("*/")) problems.push(`${where}: 含 */`);
  const stripped = text.replace(/^\/\/ ?/, "");
  const first = stripped.split(/\s+/)[0] ?? "";
  if (BANNED_START.includes(first)) problems.push(`${where}: 以禁用词 ${first} 开头`);
  if (/;\s*$/.test(stripped)) problems.push(`${where}: 以 ; 结尾`);
  if (stripped.includes("=>")) problems.push(`${where}: 含 =>`);
  if (CALL_RE.test(stripped)) problems.push(`${where}: 含点号调用`);
}

if (entry && Array.isArray(entry.items)) {
  entry.items.forEach((item, i) => {
    const tag = `item[${i}]`;
    if (!item || typeof item.anchor !== "string" || item.anchor.length === 0) {
      problems.push(`${tag}: 缺少 anchor`);
      return;
    }
    const target = item.anchor.trim();
    const hits = [];
    srcLines.forEach((line, idx) => {
      if (line.trim() === target) hits.push(idx + 1);
    });
    if (hits.length === 0) {
      problems.push(`${tag}: anchor 无匹配 -> ${target}`);
    } else if (item.nth === undefined) {
      if (hits.length !== 1) problems.push(`${tag}: anchor 出现 ${hits.length} 次，非唯一 -> ${target}`);
    } else {
      if (!Number.isInteger(item.nth) || item.nth < 1) problems.push(`${tag}: nth 非法`);
      else if (item.nth > hits.length) problems.push(`${tag}: nth 越界 ${item.nth}/${hits.length}`);
    }

    if (i === 0) {
      if (target !== firstLine) problems.push(`${tag}: 首项 anchor 不等于文件首行`);
      if (!Array.isArray(item.raw) || item.raw.length === 0) {
        problems.push(`${tag}: 首项必须有 raw`);
        return;
      }
      if (item.raw.length !== 22) problems.push(`${tag}: raw 行数为 ${item.raw.length}，应为 22`);
      item.raw.forEach((line, j) => {
        if (!(line === "//" || line.startsWith("// "))) problems.push(`${tag}.raw[${j}]: 前缀不是注释`);
        checkText(line, `${tag}.raw[${j}]`);
      });
      const invs = item.raw.filter((l) => l.startsWith("// INV-"));
      if (invs.length !== 18) problems.push(`${tag}: INV 条数为 ${invs.length}，应为 18`);
      invs.forEach((line, k) => {
        const nn = String(k + 1).padStart(2, "0");
        if (!line.startsWith(`// INV-${nn} `)) problems.push(`${tag}: INV-${nn} 缺失或顺序错`);
        if (!/；守住位置：.+；改错故障：.+。$/.test(line)) problems.push(`${tag}: INV-${nn} 结构不符`);
      });
      total += item.raw.length;
    } else {
      if (!Array.isArray(item.lines) || item.lines.length === 0) {
        problems.push(`${tag}: 必须有 lines`);
        return;
      }
      item.lines.forEach((line, j) => checkText(line, `${tag}.lines[${j}]`));
      total += item.lines.length;
    }
  });
}

if (total !== 66) problems.push(`总注释行数为 ${total}，应为 66`);

if (problems.length > 0) {
  console.error("FAIL");
  problems.forEach((p) => console.error("- " + p));
  process.exit(1);
}
console.log(`OK total=${total} items=${entry.items.length} anchors=unique file=${entry.file}`);
