import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/code/ZCode";
const SPEC = "D:/code/_annot_baseline/ZC-deep-b70-spec-05.json";
const EXPECTED_TOTAL = 62;
const FORBIDDEN = [
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

const fail = (msg) => {
  console.error("FAIL " + msg);
  process.exit(1);
};

const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
const stage = spec.files.find(
  (f) => f.file === "packages/ui/src/settings/MemorySettingsViewer.tsx",
);
if (!stage) fail("spec missing target file");

const abs = path.join(ROOT, stage.file);
if (!fs.existsSync(abs)) fail("target file not found: " + abs);
const raw = fs.readFileSync(abs, "utf8");
const sourceLines = raw.split(/\r?\n/);

const plan = [];
let totalInserted = 0;

for (const item of stage.items) {
  const anchor = String(item.anchor ?? "").trim();
  if (!anchor) fail("empty anchor");

  const hits = [];
  for (let i = 0; i < sourceLines.length; i++) {
    if (sourceLines[i].trim() === anchor) hits.push(i);
  }
  const nth = item.nth || 1;
  if (hits.length < nth || (!item.nth && hits.length !== 1)) {
    fail(`anchor hit ${hits.length} times (nth=${nth}): ${anchor}`);
  }
  const idx = hits[nth - 1];

  let out;
  if (item.raw) {
    out = item.raw;
  } else {
    const indent = /^[ \t]*/.exec(sourceLines[idx])[0];
    out = item.lines.map((t) => (t === "" ? indent + "//" : indent + "// " + t));
  }

  totalInserted += out.length;
  plan.push({ anchor, idx, out, isRaw: Boolean(item.raw) });
}

// (b) 无重复插入下标
const seen = new Set();
for (const p of plan) {
  if (seen.has(p.idx)) fail("duplicate insert index " + p.idx);
  seen.add(p.idx);
}

// (a) 每个 anchor 已在上方校验；再确认没有任何 anchor 落空
if (plan.length !== stage.items.length) fail("plan length mismatch");

// (c)(d) 插入行合法性
const callExpr = /[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+\s*\(/;
for (const p of plan) {
  for (const line of p.out) {
    if (!line.trim().startsWith("//")) fail("not a line comment: " + line);
    if (line.includes("*/")) fail("contains block-comment terminator: " + line);

    const text = line.trim().replace(/^\/\//, "").trim();
    if (text === "") continue;
    for (const word of FORBIDDEN) {
      if (new RegExp("^" + word + "\\b").test(text)) {
        fail(`forbidden leading word "${word}": ${line}`);
      }
    }
    if (text.endsWith(";")) fail("trailing semicolon: " + line);
    if (text.includes("=>")) fail("arrow function: " + line);
    if (callExpr.test(text)) fail("call expression: " + line);
  }
}

// (e) 总行数
if (totalInserted !== EXPECTED_TOTAL) {
  fail(`inserted lines ${totalInserted} !== ${EXPECTED_TOTAL}`);
}

// (f) 文件头
const header = stage.items[0];
if (!header.raw) fail("first item must use raw");
if (header.raw.length !== 22) fail("header raw length " + header.raw.length);
if (!header.raw[0].startsWith("// INV-01")) fail("header first line wrong");
if (header.raw[18] !== "//") fail("header line 19 is not bare //");
for (let i = 0; i < 18; i++) {
  if (!header.raw[i].startsWith("// INV-" + String(i + 1).padStart(2, "0") + " ")) {
    fail("header INV numbering broken at " + (i + 1));
  }
}
if (!header.raw[19].startsWith("// 模块职责：")) fail("header missing 模块职责");
if (!header.raw[20].startsWith("// 状态所有权：")) fail("header missing 状态所有权");
if (!header.raw[21].startsWith("// 阅读顺序：")) fail("header missing 阅读顺序");

// 非 raw 块长度 3~6
for (const item of stage.items.slice(1)) {
  if (!item.lines || item.lines.length < 3 || item.lines.length > 6) {
    fail("block size out of range: " + JSON.stringify(item.anchor));
  }
}

// 模拟插入后的完整性：原有行必须全部按序保留
const next = sourceLines.slice();
const sorted = plan.slice().sort((a, b) => b.idx - a.idx);
for (const p of sorted) next.splice(p.idx, 0, ...p.out);
const inserted = plan.reduce((sum, p) => sum + p.out.length, 0);
if (inserted !== totalInserted) fail("inserted count mismatch");
const originalSurvived = sourceLines.every((line) => next.includes(line));
if (!originalSurvived) fail("original line lost during simulation");

console.log(
  `OK blocks=${plan.length} lines=${totalInserted} header=${header.raw.length} rawLines=${sourceLines.length} nextLines=${next.length}`,
);
