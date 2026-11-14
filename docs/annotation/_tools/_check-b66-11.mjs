import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b66-spec-11.json";
const repoRoot = "d:/code/ZCode";
const targetFile = "packages/ui/src/store/whiteboardStore.ts";
const expectedTotal = 64;

const failures = [];
const fail = (msg) => failures.push(msg);

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

if (!Array.isArray(spec.files)) fail("spec.files 不是数组");
if (spec.files.length !== 1) fail(`spec.files 数量应为 1，实际 ${spec.files.length}`);

const entry = spec.files[0] ?? {};
if (entry.file !== targetFile) fail(`文件路径不符：${entry.file}`);

const sourceLines = fs
  .readFileSync(`${repoRoot}/${targetFile}`, "utf8")
  .split(/\r?\n/);
const trimmedSource = sourceLines.map((line) => line.trim());

const bannedHeads = [
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
const callExpr = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const items = entry.items;
if (!Array.isArray(items) || items.length === 0) fail("items 为空");

let totalLines = 0;
let anchorCount = 0;

items.forEach((item, index) => {
  const raw = Array.isArray(item.raw) ? item.raw : null;
  const lines = Array.isArray(item.lines) ? item.lines : null;

  if ((raw && lines) || (!raw && !lines)) {
    fail(`第 ${index + 1} 项必须且只能有 raw 或 lines 之一`);
    return;
  }

  const payload = raw ?? lines;
  totalLines += payload.length;

  if (index === 0) {
    if (!raw) fail("第 1 项必须使用 raw");
    if (payload.length !== 22) fail(`第 1 项应为 22 行，实际 ${payload.length}`);
    if (sourceLines[0].trim() !== String(item.anchor).trim()) {
      fail("第 1 项 anchor 不等于文件首行");
    }
  }

  if (typeof item.anchor !== "string" || item.anchor.trim() === "") {
    fail(`第 ${index + 1} 项 anchor 无效`);
    return;
  }

  const needle = item.anchor.trim();
  const matches = [];
  trimmedSource.forEach((line, i) => {
    if (line === needle) matches.push(i);
  });

  if (matches.length === 0) {
    fail(`第 ${index + 1} 项 anchor 在文件中不存在：${needle}`);
    return;
  }

  if (item.nth !== undefined) {
    if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > matches.length) {
      fail(`第 ${index + 1} 项 nth 越界：${item.nth}（共 ${matches.length} 处）`);
      return;
    }
  } else if (matches.length !== 1) {
    fail(`第 ${index + 1} 项 anchor 不唯一（${matches.length} 处）：${needle}`);
    return;
  }

  anchorCount += 1;

  payload.forEach((line, lineIndex) => {
    const where = `第 ${index + 1} 项第 ${lineIndex + 1} 行`;
    if (typeof line !== "string") {
      fail(`${where} 不是字符串`);
      return;
    }
    // lines 项由插入器补 "// " 前缀（空串补 "//"），raw 项自带前缀
    const effective = raw ? line : line === "" ? "//" : `// ${line}`;
    if (!effective.startsWith("//")) {
      fail(`${where} 不以 // 开头`);
      return;
    }
    if (effective.includes("*/")) fail(`${where} 含 */`);
    if (/\s$/.test(effective)) fail(`${where} 结尾有空白`);

    const body = effective.replace(/^\/\/\s?/, "");
    const head = body.split(/\s+/)[0];
    if (bannedHeads.includes(head)) fail(`${where} 以禁词开头：${head}`);
    if (body.endsWith(";")) fail(`${where} 以 ; 结尾`);
    if (effective.includes("=>")) fail(`${where} 含 =>`);
    if (callExpr.test(effective)) fail(`${where} 含调用表达式：${effective}`);
  });
});

if (totalLines !== expectedTotal) {
  fail(`注释总行数应为 ${expectedTotal}，实际 ${totalLines}`);
}

if (failures.length > 0) {
  console.error("FAILED");
  failures.forEach((msg) => console.error(`- ${msg}`));
  process.exit(1);
}

console.log(
  `OK items=${items.length} totalLines=${totalLines} anchors=${anchorCount} file=${entry.file}`,
);
