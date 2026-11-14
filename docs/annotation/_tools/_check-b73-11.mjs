import fs from "node:fs";

const SPEC_PATH = "d:/code/_annot_baseline/ZC-deep-b73-spec-11.json";
const ROOT = "d:/code/ZCode";

const FORBIDDEN_START = [
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

const CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

const failures = [];
const fail = (msg) => failures.push(msg);

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
if (!Array.isArray(spec.files) || spec.files.length !== 1) fail("spec.files 必须只有一个文件");
const entry = spec.files[0];

const absPath = `${ROOT}/${entry.file}`;
if (!fs.existsSync(absPath)) fail(`目标文件不存在: ${absPath}`);
const source = fs.readFileSync(absPath, "utf8");
const originalLines = source.split(/\r?\n/);

const expectedTotal = 61;
let totalInserted = 0;
const insertAt = new Map(); // index -> lines[]
let headerChecked = false;
let blockCount = 0;

const normalise = (trimmedAnchor, line) => trimmedAnchor === line.trim();

entry.items.forEach((item, itemIndex) => {
  blockCount += 1;
  const anchor = item.anchor;
  if (typeof anchor !== "string" || anchor.trim().length === 0) {
    fail(`item#${itemIndex}: anchor 为空`);
    return;
  }
  const matches = [];
  originalLines.forEach((line, idx) => {
    if (normalise(anchor, line)) matches.push(idx);
  });
  const isRaw = Array.isArray(item.raw);
  if (isRaw === Array.isArray(item.lines)) {
    fail(`item#${itemIndex}: 必须且只能提供 raw 或 lines 之一`);
    return;
  }
  let target;
  if (typeof item.nth === "number") {
    if (item.nth < 1 || item.nth > matches.length) {
      fail(`item#${itemIndex}: nth=${item.nth} 超出命中数 ${matches.length}`);
      return;
    }
    target = matches[item.nth - 1];
  } else {
    if (matches.length !== 1) {
      fail(`item#${itemIndex}: anchor 命中 ${matches.length} 次（需唯一）: ${anchor}`);
      return;
    }
    target = matches[0];
  }

  const anchorLine = originalLines[target];
  const indentMatch = /^[ \t]*/.exec(anchorLine);
  const indent = indentMatch ? indentMatch[0] : "";
  const body = isRaw ? item.raw : item.lines;
  if (!Array.isArray(body) || body.length === 0) {
    fail(`item#${itemIndex}: 内容为空`);
    return;
  }

  const produced = body.map((text) => {
    if (typeof text !== "string") {
      fail(`item#${itemIndex}: 出现非字符串行`);
      return "//";
    }
    if (isRaw) return text;
    return text === "" ? `${indent}//` : `${indent}// ${text}`;
  });

  produced.forEach((line, lineIndex) => {
    const where = `item#${itemIndex} 行#${lineIndex}`;
    const trimmed = line.trim();
    if (!trimmed.startsWith("//")) fail(`${where}: 不以 // 开头 -> ${line}`);
    if (trimmed.includes("*/")) fail(`${where}: 含 */ -> ${line}`);
    if (trimmed.endsWith(";")) fail(`${where}: 以分号结尾 -> ${line}`);
    if (trimmed.includes("=>")) fail(`${where}: 含 => -> ${line}`);
    if (CALL_RE.test(trimmed)) fail(`${where}: 疑似调用表达式 -> ${line}`);
    const after = trimmed.slice(2).trimStart();
    const firstWord = /^[A-Za-z_$][\w$]*/.exec(after);
    if (firstWord && FORBIDDEN_START.includes(firstWord[0])) {
      fail(`${where}: 注释正文以禁止词 ${firstWord[0]} 开头 -> ${line}`);
    }
  });

  if (isRaw) {
    if (itemIndex !== 0) fail("raw 只允许出现在第一个 item（文件头）");
    headerChecked = true;
    if (produced.length !== 22) fail(`文件头 raw 长度必须 22，实际 ${produced.length}`);
    if (!produced[0].startsWith("// INV-01")) fail(`文件头首行必须以 // INV-01 开头: ${produced[0]}`);
    if (produced[18] !== "//") fail(`文件头第 19 行必须是 //，实际: ${produced[18]}`);
    for (let i = 0; i < 18; i += 1) {
      const tag = `// INV-${String(i + 1).padStart(2, "0")} `;
      if (!produced[i].startsWith(tag)) fail(`文件头第 ${i + 1} 行缺少 ${tag}`);
      if (!produced[i].includes("守住位置")) fail(`文件头第 ${i + 1} 行缺少「守住位置」`);
      if (!produced[i].includes("改错故障")) fail(`文件头第 ${i + 1} 行缺少「改错故障」`);
    }
    if (!produced[19].startsWith("// 模块职责：")) fail("文件头缺少 模块职责 行");
    if (!produced[20].startsWith("// 状态所有权：")) fail("文件头缺少 状态所有权 行");
    if (!produced[21].startsWith("// 阅读顺序：")) fail("文件头缺少 阅读顺序 行");
  } else if (produced.length < 3 || produced.length > 6) {
    fail(`item#${itemIndex}: lines 块长度 ${produced.length} 不在 3~6 之间`);
  }

  if (insertAt.has(target)) {
    fail(`item#${itemIndex}: 插入下标 ${target} 与其他 item 重复`);
  } else {
    insertAt.set(target, produced);
  }
  totalInserted += produced.length;
});

if (!headerChecked) fail("缺少文件头 raw item");
if (totalInserted !== expectedTotal) fail(`插入总行数 ${totalInserted} !== ${expectedTotal}`);

// 模拟插入：只新增行，原行必须逐行保持
const out = [];
const order = [...insertAt.keys()].sort((a, b) => a - b);
let cursor = 0;
for (const idx of order) {
  while (cursor < idx) {
    out.push(originalLines[cursor]);
    cursor += 1;
  }
  out.push(...insertAt.get(idx));
}
while (cursor < originalLines.length) {
  out.push(originalLines[cursor]);
  cursor += 1;
}
if (out.length !== originalLines.length + totalInserted) {
  fail(`模拟插入后行数 ${out.length} 与预期 ${originalLines.length + totalInserted} 不符`);
}

// 反向校验：删除插入行后应与原文逐行一致
const rebuilt = [];
for (let i = 0; i < out.length; ) {
  const idx = order.find((start) => {
    const span = insertAt.get(start).length;
    return rebuilt.length + span <= out.length && out.slice(i, i + span).join("\n") === insertAt.get(start).join("\n");
  });
  if (idx === undefined) {
    rebuilt.push(out[i]);
    i += 1;
  } else {
    i += insertAt.get(idx).length;
    order.splice(order.indexOf(idx), 1);
  }
}
if (rebuilt.length !== originalLines.length) fail("插入只增不删校验失败：行数不一致");

if (failures.length > 0) {
  console.log(`FAIL (${failures.length})`);
  failures.forEach((msg) => console.log(` - ${msg}`));
  process.exit(1);
}
console.log(`OK blocks=${blockCount} lines=${totalInserted}`);
