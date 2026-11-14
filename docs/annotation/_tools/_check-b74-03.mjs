// 干跑校验 b74-03：只读 spec 与目标文件，模拟整行锚点匹配与插入，不写仓库。
// 用法：node d:\code\_annot_baseline\_check-b74-03.mjs
import fs from "node:fs";
import path from "node:path";

const REPO = "D:/code/ZCode";
const SPEC = "D:/code/_annot_baseline/ZC-deep-b74-spec-03.json";
const EXPECTED_FILE = "packages/ui/src/settings/pluginStoreListing.ts";
const HEADER_LINES = 22;
const TOTAL_LINES = 62;

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const KEYWORDS = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const START_RE = new RegExp(`^(?:${KEYWORDS.join("|")})\\b`);
const CALL_RE = /[A-Za-z0-9_$)\]]\s*\.\s*[A-Za-z_$][\w$]*\s*\(/;

const stripPrefix = (line) => line.replace(/^\/\/ ?/, "");

const checkText = (text, where) => {
  if (text.includes("*/")) fail(`${where} 含禁词 */`);
  if (START_RE.test(text)) fail(`${where} 以关键字开头: ${text}`);
  if (/;\s*$/.test(text)) fail(`${where} 以 ; 结尾: ${text}`);
  if (text.includes("=>")) fail(`${where} 含 =>: ${text}`);
  const m = text.match(CALL_RE);
  if (m) fail(`${where} 含调用式片段 ${m[0]}: ${text}`);
};

const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
if (!Array.isArray(spec.files) || spec.files.length !== 1) fail("files 必须只有一个文件项");
const entry = spec.files[0];
if (entry.file !== EXPECTED_FILE) fail(`file 不符: ${entry.file}`);

const targetPath = path.join(REPO, entry.file);
const srcLines = fs.readFileSync(targetPath, "utf8").split(/\r?\n/);
const trims = srcLines.map((line) => line.trim());
const firstLine = trims[0];

const items = entry.items;
if (!Array.isArray(items) || items.length === 0) fail("items 为空");

let added = 0;
let rawLen = 0;
let linesLen = 0;
const inserts = new Map();

items.forEach((item, index) => {
  const where = `items[${index}]`;
  if (typeof item.anchor !== "string" || item.anchor.trim() === "") fail(`${where} anchor 缺失`);

  const hasRaw = Array.isArray(item.raw);
  const hasLines = Array.isArray(item.lines);
  let rendered;

  if (index === 0) {
    if (!hasRaw) fail(`${where} 首项必须提供 raw`);
    if (hasLines) fail(`${where} 首项不应同时提供 lines`);
    if (item.raw.length !== HEADER_LINES) {
      fail(`${where} raw 行数 ${item.raw.length} 不等于 ${HEADER_LINES}`);
    }
    // 第 19 行是空注释：raw 为空串时渲染成 //，直接写 // 亦等价。
    if (!(item.raw[18] === "" || item.raw[18] === "//")) {
      fail(`${where} raw[18] 不是空行注释: ${JSON.stringify(item.raw[18])}`);
    }
    let invCount = 0;
    item.raw.forEach((line, i) => {
      if (typeof line !== "string") fail(`${where} raw[${i}] 不是字符串`);
      if (i < 18) {
        const tag = `// INV-${String(i + 1).padStart(2, "0")} `;
        if (!line.startsWith(tag)) fail(`${where} raw[${i}] 缺少 ${tag}`);
        if (!line.includes("守住位置")) fail(`${where} raw[${i}] 缺少 守住位置`);
        if (!line.includes("改错故障")) fail(`${where} raw[${i}] 缺少 改错故障`);
        invCount += 1;
      } else if (i === 18) {
        // 空行注释本身不检查正文
      } else {
        if (!line.startsWith("// ")) fail(`${where} raw[${i}] 缺少注释前缀`);
        checkText(stripPrefix(line), `${where} raw[${i}]`);
      }
    });
    if (invCount !== 18) fail(`${where} INV 行数 ${invCount} 不等于 18`);
    if (!item.raw[19].includes("模块职责")) fail(`${where} raw[19] 不是模块职责`);
    if (!item.raw[20].includes("状态所有权")) fail(`${where} raw[20] 不是状态所有权`);
    if (!item.raw[21].includes("阅读顺序")) fail(`${where} raw[21] 不是阅读顺序`);
    if (item.anchor.trim() !== firstLine) fail(`${where} 首项 anchor 不等于文件首行`);
    // raw 逐字使用，必须已是合法整行注释
    item.raw.forEach((line, i) => {
      if (line === "" ) return;
      if (!line.trim().startsWith("//")) fail(`${where} raw[${i}] 不是整行注释: ${JSON.stringify(line)}`);
    });
    rendered = item.raw.slice();
  } else {
    if (!hasLines) fail(`${where} 必须提供 lines`);
    if (hasRaw) fail(`${where} 非首项不应提供 raw`);
    if (item.lines.length === 0) fail(`${where} lines 为空`);
    item.lines.forEach((line, i) => {
      if (typeof line !== "string") fail(`${where} lines[${i}] 不是字符串`);
      if (line.trim() === "") return;
      if (line.startsWith("//")) fail(`${where} lines[${i}] 不应自带注释前缀`);
      checkText(line, `${where} lines[${i}]`);
    });
    rendered = item.lines;
  }

  if (item.nth !== undefined && (!Number.isInteger(item.nth) || item.nth < 1)) {
    fail(`${where} nth 非法: ${item.nth}`);
  }

  const anchor = item.anchor.trim();
  const hits = [];
  trims.forEach((line, i) => {
    if (line === anchor) hits.push(i);
  });
  if (hits.length === 0) fail(`${where} anchor 未命中: ${JSON.stringify(item.anchor)}`);
  let idx;
  if (item.nth === undefined) {
    if (hits.length > 1) fail(`${where} anchor 命中 ${hits.length} 次（行 ${hits.map((h) => h + 1).join(",")}），需指定 nth`);
    idx = hits[0];
  } else {
    if (item.nth > hits.length) fail(`${where} nth=${item.nth} 越界，命中 ${hits.length} 次`);
    idx = hits[item.nth - 1];
  }
  // 锚点不得落在注释行，否则会变成给注释加注释
  if (trims[idx].startsWith("//") || trims[idx].startsWith("/*") || trims[idx].startsWith("*")) {
    fail(`${where} anchor 指向注释行: ${JSON.stringify(item.anchor)}`);
  }
  if (inserts.has(idx)) fail(`${where} 插入点重复: 第 ${idx + 1} 行`);
  inserts.set(idx, rendered);
  added += rendered.length;
  if (index === 0) rawLen = rendered.length;
  else linesLen += rendered.length;
  console.log(
    `${where} anchor@${idx + 1} hits=${hits.length}${item.nth ? ` nth=${item.nth}` : ""} lines=${rendered.length}`,
  );
});

if (rawLen !== HEADER_LINES) fail(`首块 raw 行数 ${rawLen} 不等于 ${HEADER_LINES}`);
if (linesLen + HEADER_LINES !== TOTAL_LINES) {
  fail(`lines 合计 ${linesLen} + ${HEADER_LINES} 不等于 ${TOTAL_LINES}`);
}
if (added !== TOTAL_LINES) fail(`总插入行数 ${added} 不等于 ${TOTAL_LINES}`);

console.log(`file: ${entry.file}`);
console.log(`OK blocks=${items.length} lines=${TOTAL_LINES}`);
