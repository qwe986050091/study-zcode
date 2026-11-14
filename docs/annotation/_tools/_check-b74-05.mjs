import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const specPath = join(here, "ZC-deep-b74-spec-05.json");
const targetPath = "D:/code/ZCode/packages/ui/src/store/zcodeSessionStoreTypes.ts";
const relPath = "packages/ui/src/store/zcodeSessionStoreTypes.ts";
const EXPECTED_TOTAL = 64;

const errors = [];
const err = (msg) => errors.push(msg);

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const targetLines = readFileSync(targetPath, "utf8").split(/\r?\n/);
const targetTrim = targetLines.map((l) => l.trim());

const BANNED_PREFIX = [
  "const", "let", "var", "function", "class", "import", "export",
  "return", "if", "else", "for", "while", "switch", "try", "catch",
  "await", "async", "throw", "new", "interface", "type", "enum",
];
const IDENT_CALL = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

if (!Array.isArray(spec.files) || spec.files.length !== 1) err("spec.files 必须恰好 1 个元素");
const file = spec.files[0];
if (file.file !== relPath) err(`file 路径不匹配: ${file.file}`);
if (!Array.isArray(file.items) || file.items.length < 2) err("items 数量不足");

const items = file.items;
let total = 0;

items.forEach((item, idx) => {
  const hasRaw = Object.prototype.hasOwnProperty.call(item, "raw");
  const hasLines = Object.prototype.hasOwnProperty.call(item, "lines");
  if (hasRaw === hasLines) err(`item#${idx} 必须且只能有 raw 或 lines 之一`);
  if (typeof item.anchor !== "string" || item.anchor.trim() === "") {
    err(`item#${idx} anchor 缺失`);
    return;
  }
  if (hasRaw && item.raw.length + (hasLines ? item.lines.length : 0) === 0) err(`item#${idx} 内容为空`);

  if (hasRaw) {
    const raw = item.raw;
    total += raw.length;
    raw.forEach((line, i) => {
      if (typeof line !== "string" || !line.startsWith("//")) {
        err(`item#${idx}.raw[${i}] 未以 // 开头: ${JSON.stringify(line)}`);
      }
    });
    if (idx !== 0) err(`item#${idx} 非首块不应使用 raw`);
    if (raw.length !== 22) err(`首块 raw 行数应为 22，实际 ${raw.length}`);
    const inv = raw.filter((l) => /^\/\/ INV-\d{2}\s/.test(l));
    const blank = raw.filter((l) => l === "//");
    if (inv.length !== 18) err(`首块 INV 行应为 18，实际 ${inv.length}`);
    if (blank.length !== 1) err(`首块纯空注释行应为 1，实际 ${blank.length}`);
    const invNums = inv.map((l) => l.match(/^\/\/ INV-(\d{2})/)[1]).join(",");
    const expectNums = Array.from({ length: 18 }, (_, i) => String(i + 1).padStart(2, "0")).join(",");
    if (invNums !== expectNums) err(`INV 编号应为 01..18 且顺序正确，实际 ${invNums}`);
    const tail = raw.slice(19);
    const keys = ["模块职责：", "状态所有权：", "阅读顺序："];
    if (tail.length !== 3) err(`首块尾部三行缺失，实际 ${tail.length}`);
    keys.forEach((k, i) => {
      if (!tail[i] || !tail[i].includes(k)) err(`首块尾部第 ${i + 1} 行缺少「${k}」`);
    });
  } else {
    const lines = item.lines;
    total += lines.length;
    lines.forEach((line, i) => {
      if (typeof line !== "string") err(`item#${idx}.lines[${i}] 不是字符串`);
      else if (line.startsWith("//")) err(`item#${idx}.lines[${i}] 不应自带 // 前缀`);
    });
    if (idx === 0) err("首块必须使用 raw");
  }

  // anchor 匹配：trim 后整行相等
  const nth = item.nth === undefined ? 1 : item.nth;
  if (!Number.isInteger(nth) || nth < 1) err(`item#${idx} nth 非法: ${item.nth}`);
  const hits = [];
  targetTrim.forEach((l, i) => {
    if (l === item.anchor.trim()) hits.push(i + 1);
  });
  if (idx === 0) {
    if (targetTrim[0] !== item.anchor.trim()) err("首块 anchor 必须等于目标文件第一行");
  } else {
    const t = item.anchor.trim();
    if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) {
      err(`item#${idx} anchor 落在注释行: ${t}`);
    }
  }
  if (item.nth === undefined) {
    if (hits.length !== 1) err(`item#${idx} anchor 应唯一，命中 ${hits.length} 次: ${item.anchor.trim()}`);
  } else if (hits.length < nth) {
    err(`item#${idx} anchor 命中不足 nth=${nth}，实际 ${hits.length} 次`);
  }

  // 注释禁令
  const bodies = hasRaw
    ? item.raw.map((l) => (l === "//" ? "" : l.replace(/^\/\/ ?/, "")))
    : item.lines;
  bodies.forEach((body, i) => {
    const where = `item#${idx}.${hasRaw ? "raw" : "lines"}[${i}]`;
    if (body.includes("*/")) err(`${where} 含 */`);
    if (body.trimEnd().endsWith(";")) err(`${where} 以 ; 结尾`);
    if (body.includes("=>")) err(`${where} 含 =>`);
    if (IDENT_CALL.test(body)) err(`${where} 含 标识符.标识符( 形态`);
    const first = body.trim().split(/\s+/)[0] || "";
    if (BANNED_PREFIX.includes(first)) err(`${where} 以禁用词开头: ${first}`);
  });
});

if (total !== EXPECTED_TOTAL) err(`总行数应为 ${EXPECTED_TOTAL}，实际 ${total}`);

if (errors.length > 0) {
  console.error("CHECK FAILED");
  errors.forEach((e) => console.error(" - " + e));
  process.exit(1);
}
console.log(`OK blocks=${items.length} lines=${total}`);
