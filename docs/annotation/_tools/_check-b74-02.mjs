import { readFileSync } from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b74-spec-02.json";
const ROOT = "d:/code/ZCode/";

const BAN_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const entry = spec.files[0];
const targetPath = ROOT + entry.file;
const srcLines = readFileSync(targetPath, "utf8").split(/\r?\n/);
const errors = [];

function contentOfRaw(line) {
  if (line === "") return "";
  return line.startsWith("// ") ? line.slice(3) : line === "//" ? "" : line;
}

function checkBanned(where, content) {
  if (content.includes("*/")) errors.push(`${where} 含 */`);
  if (content.includes("=>")) errors.push(`${where} 含 =>`);
  if (content.endsWith(";")) errors.push(`${where} 以 ; 结尾: ${content}`);
  if (CALL_RE.test(content)) errors.push(`${where} 形如 标识符.标识符( 调用: ${content}`);
  const trimmed = content.trim();
  if (trimmed) {
    const head = /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)(?![\w$])/.exec(trimmed);
    if (head) errors.push(`${where} 以禁词开头(${head[1]}): ${content}`);
  }
}

let total = 0;
let invCount = 0;

// --- 首块 raw 专项校验 ---
const first = entry.items[0];
if (!Array.isArray(first.raw)) errors.push("item#1 缺少 raw");
const raw = first.raw ?? [];
if (raw.length !== 22) errors.push(`首块 raw 行数 ${raw.length} !== 22`);
if (raw[18] !== "") errors.push(`首块第 19 行应为空字符串，实际 ${JSON.stringify(raw[18])}`);
invCount = raw.filter((l) => l.startsWith("// INV-")).length;
if (invCount !== 18) errors.push(`INV 行数 ${invCount} !== 18`);
for (let i = 0; i < 18; i += 1) {
  const want = `// INV-${String(i + 1).padStart(2, "0")}`;
  if (!String(raw[i] ?? "").startsWith(want + " ")) {
    errors.push(`首块第 ${i + 1} 行应为 ${want} 开头: ${raw[i]}`);
  }
}
for (const [i, line] of raw.entries()) {
  if (line === "") continue;
  if (!line.startsWith("//")) errors.push(`首块 L${i + 1} raw 行未以 // 开头: ${JSON.stringify(line)}`);
  else if (line !== "//" && !line.startsWith("// ")) errors.push(`首块 L${i + 1} 缺少 // 后空格: ${JSON.stringify(line)}`);
  checkBanned(`首块 L${i + 1}`, contentOfRaw(line));
}
// 首块锚点必须是文件第一行
if (first.anchor.trim() !== srcLines[0].trim()) {
  errors.push(`首块 anchor 不是文件第一行: ${JSON.stringify(first.anchor)}`);
}
total += raw.length;

// --- 后续块 ---
for (let idx = 1; idx < entry.items.length; idx += 1) {
  const item = entry.items[idx];
  const tag = `item#${idx + 1}`;
  if (item.raw !== undefined) errors.push(`${tag} 非首块不应使用 raw`);
  const lines = item.lines ?? [];
  if (lines.length === 0) errors.push(`${tag} lines 为空`);
  total += lines.length;

  const anchor = String(item.anchor ?? "");
  if (anchor.trim() === "") {
    errors.push(`${tag} anchor 为空`);
    continue;
  }
  if (anchor.trim().startsWith("//")) errors.push(`${tag} anchor 指向注释行: ${anchor}`);

  const hits = srcLines.reduce((acc, line, i) => (line.trim() === anchor.trim() ? [...acc, i] : acc), []);
  if (hits.length === 0) {
    errors.push(`${tag} anchor 在目标文件中不匹配: ${JSON.stringify(anchor)}`);
  } else if (hits.length > 1) {
    if (typeof item.nth !== "number") errors.push(`${tag} anchor 命中 ${hits.length} 次却缺 nth`);
    else if (item.nth < 1 || item.nth > hits.length) errors.push(`${tag} nth=${item.nth} 越界（共 ${hits.length}）`);
  } else if (item.nth !== undefined && item.nth !== 1) {
    errors.push(`${tag} anchor 唯一却给了 nth=${item.nth}`);
  }

  for (const [li, line] of lines.entries()) {
    const where = `${tag} L${li + 1}`;
    if (line.startsWith("//")) errors.push(`${where} lines 不应自带 // 前缀: ${JSON.stringify(line)}`);
    if (/^\s/.test(line)) errors.push(`${where} lines 不应自带缩进: ${JSON.stringify(line)}`);
    checkBanned(where, line);
  }
}

if (total !== 61) errors.push(`总行数 ${total} !== 61`);

if (errors.length > 0) {
  console.log(`FAIL blocks=${entry.items.length} lines=${total}`);
  for (const e of errors) console.log(" - " + e);
  process.exitCode = 1;
} else {
  console.log(`OK blocks=${entry.items.length} lines=${total}`);
}
