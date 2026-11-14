import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b69-spec-04.json";
const filePath = "d:/code/ZCode/packages/ui/src/ToolCallBlocks/renderers/skill.tsx";

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

const BANNED = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const failures = [];
const fail = (msg) => failures.push(msg);

if (!spec.files || !Array.isArray(spec.files) || spec.files.length < 1) {
  fail("spec.files 缺失");
  console.log(failures.join("\n"));
  process.exit(1);
}

const items = spec.files[0].items || [];
if (!Array.isArray(items) || items.length < 2) fail("items 数量异常");

const used = new Set();
let total = 0;

items.forEach((item, idx) => {
  const tag = `item[${idx}]`;
  const anchor = typeof item.anchor === "string" ? item.anchor : "";
  if (anchor.trim().length === 0) {
    fail(`${tag} anchor 为空`);
    return;
  }
  const key = anchor.trim();
  const hits = [];
  lines.forEach((line, i) => {
    if (line.trim() === key) hits.push(i);
  });
  if (hits.length === 0) {
    fail(`${tag} anchor 未命中: ${key}`);
    return;
  }
  let pos;
  if (item.nth != null) {
    if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
      fail(`${tag} nth 非法: ${item.nth}（命中 ${hits.length} 次）`);
      return;
    }
    pos = hits[item.nth - 1];
  } else if (hits.length !== 1) {
    fail(`${tag} anchor 不唯一（命中 ${hits.length} 次）: ${key}`);
    return;
  } else {
    pos = hits[0];
  }
  if (used.has(pos)) fail(`${tag} 重复插入下标 ${pos}`);
  used.add(pos);

  const isRaw = Array.isArray(item.raw);
  const ins = isRaw ? item.raw : item.lines;
  if (!Array.isArray(ins) || ins.length === 0) {
    fail(`${tag} 无插入行`);
    return;
  }
  total += ins.length;

  const anchorIndent = (lines[pos].match(/^[ \t]*/) || [""])[0];
  const rendered = ins.map((src) => {
    if (isRaw) return src;
    if (typeof src !== "string") return src;
    return src.trim().length === 0 ? `${anchorIndent}//` : `${anchorIndent}// ${src}`;
  });

  rendered.forEach((raw, j) => {
    const where = `${tag}.line[${j}]`;
    if (typeof raw !== "string") {
      fail(`${where} 非字符串`);
      return;
    }
    const t = raw.trim();
    if (!t.startsWith("//")) fail(`${where} 不是整行注释: ${t}`);
    if (t.includes("*/")) fail(`${where} 含 */: ${t}`);
    if (t.endsWith(";")) fail(`${where} 以分号结尾: ${t}`);
    if (t.includes("=>")) fail(`${where} 含箭头: ${t}`);
    if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(t)) fail(`${where} 含调用表达式: ${t}`);
    if (/[A-Za-z_$][\w$]*\s*\(/.test(t.replace(/^\/\//, ""))) fail(`${where} 含英文括号调用形态: ${t}`);
    const body = t.slice(2).trim();
    if (body.length === 0) return;
    const first = body.split(/[\s，。；：、,.;:]/u)[0];
    if (BANNED.includes(first)) fail(`${where} 以禁止词开头(${first}): ${t}`);
  });
});

// 文件头专项校验
const header = items[0];
if (!Array.isArray(header.raw)) {
  fail("首 item 必须使用 raw");
} else {
  if (header.raw.length !== 22) fail(`文件头 raw 长度 ${header.raw.length} !== 22`);
  if (!header.raw[0].startsWith("// INV-01")) fail(`文件头首行异常: ${header.raw[0]}`);
  if (header.raw[18] !== "//") fail(`文件头第 19 行应为 //，实际: ${header.raw[18]}`);
  for (let i = 0; i < 18; i += 1) {
    if (!/^\/\/ INV-\d\d /.test(header.raw[i])) fail(`INV 行格式异常(${i + 1}): ${header.raw[i]}`);
    if (header.raw[i] !== header.raw[i].trim()) fail(`INV 行含缩进(${i + 1})`);
    if (!header.raw[i].includes("守住位置") || !header.raw[i].includes("改错故障")) {
      fail(`INV 行缺少位置/故障说明(${i + 1})`);
    }
  }
}

items.slice(1).forEach((item, k) => {
  const n = (item.lines || []).length;
  if (n < 3 || n > 6) fail(`item[${k + 1}] 行数 ${n} 不在 3~6`);
});

if (total !== 64) fail(`插入总行数 ${total} !== 64`);

if (failures.length > 0) {
  console.log(failures.join("\n"));
  process.exit(1);
}

console.log(`OK blocks=${items.length} lines=${total}`);
