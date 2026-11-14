import { readFileSync } from "node:fs";

const SPEC_PATH = "d:/code/_annot_baseline/ZC-deep-b69-spec-12.json";
const TARGET_PATH = "d:/code/ZCode/packages/ui/src/app-shell/WorkflowRunSidePaneSections.tsx";
const EXPECTED_TOTAL = 65;
const FORBIDDEN_PREFIX =
  /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const CALL_EXPR = /\b[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/;

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
const source = readFileSync(TARGET_PATH, "utf8");
const lines = source.split(/\r?\n/);

const errors = [];
const entry = spec.files?.[0];
if (!entry) errors.push("spec 缺少 files[0]");
if (entry && entry.file !== "packages/ui/src/app-shell/WorkflowRunSidePaneSections.tsx") {
  errors.push(`file 字段不匹配: ${entry.file}`);
}
const items = entry?.items ?? [];

const insertions = [];
let total = 0;

items.forEach((item, idx) => {
  const anchorTrim = String(item.anchor).trim();
  if (!anchorTrim) errors.push(`item#${idx} anchor 为空`);
  const hits = [];
  lines.forEach((line, i) => {
    if (line.trim() === anchorTrim) hits.push(i);
  });
  if (hits.length === 0) {
    errors.push(`item#${idx} anchor 未命中: ${JSON.stringify(item.anchor)}`);
    return;
  }
  let hitIndex = -1;
  if (item.nth !== undefined) {
    const n = Number(item.nth);
    if (!Number.isInteger(n) || n < 1 || n > hits.length) {
      errors.push(`item#${idx} nth 越界: nth=${item.nth}, hits=${hits.length}`);
      return;
    }
    hitIndex = hits[n - 1];
  } else {
    if (hits.length !== 1) {
      errors.push(`item#${idx} anchor 不唯一: hits=${hits.length}, ${JSON.stringify(item.anchor)}`);
      return;
    }
    hitIndex = hits[0];
  }
  const isHead = idx === 0;
  if (!isHead && hitIndex <= 0) errors.push(`item#${idx} 锚点落在文件首行，无障碍插入`);
  if (isHead && !Array.isArray(item.raw)) errors.push("文件头 item 缺少 raw");
  if (!isHead && !Array.isArray(item.lines)) errors.push(`item#${idx} 缺少 lines`);
  if (isHead && Array.isArray(item.lines)) errors.push("文件头 item 不应使用 lines");
  if (!isHead && Array.isArray(item.raw)) errors.push(`item#${idx} 不应使用 raw`);

  let produced;
  if (isHead) {
    produced = item.raw.map((l) => String(l));
    if (item.raw.length !== 22) errors.push(`文件头 raw 长度应为 22，实为 ${item.raw.length}`);
    if (!String(item.raw[0] ?? "").trim().startsWith("// INV-01")) errors.push("文件头首行未以 // INV-01 开头");
    if (String(item.raw[18] ?? "") !== "//") errors.push("文件头第 19 行不是 //");
  } else {
    const anchorLine = lines[hitIndex];
    const indent = (anchorLine.match(/^[ \t]*/) ?? [""])[0];
    if (item.lines.length < 3 || item.lines.length > 6) {
      errors.push(`item#${idx} 块行数应为 3~6，实为 ${item.lines.length}`);
    }
    produced = item.lines.map((l) => {
      const text = String(l);
      return text === "" ? `${indent}//` : `${indent}// ${text}`;
    });
  }

  produced.forEach((p, j) => {
    const trim = p.trim();
    if (!trim.startsWith("//")) errors.push(`item#${idx} 第 ${j + 1} 行 trim 后不以 // 开头: ${trim}`);
    if (trim.includes("*/")) errors.push(`item#${idx} 第 ${j + 1} 行含 */: ${trim}`);
    const body = trim.replace(/^\/\/\s?/, "");
    if (body !== "") {
      if (FORBIDDEN_PREFIX.test(body)) errors.push(`item#${idx} 第 ${j + 1} 行以禁止词开头: ${body}`);
      if (body.endsWith(";")) errors.push(`item#${idx} 第 ${j + 1} 行以分号结尾: ${body}`);
      if (body.includes("=>")) errors.push(`item#${idx} 第 ${j + 1} 行含箭头: ${body}`);
      if (CALL_EXPR.test(body)) errors.push(`item#${idx} 第 ${j + 1} 行含调用表达式: ${body}`);
    }
  });

  total += produced.length;
  insertions.push({ item: idx, index: hitIndex, count: produced.length, anchor: anchorTrim });
});

const indexSeen = new Map();
insertions.forEach((ins) => {
  if (indexSeen.has(ins.index)) {
    errors.push(`重复插入下标 ${ins.index}: item#${indexSeen.get(ins.index)} 与 item#${ins.item}`);
  }
  indexSeen.set(ins.index, ins.item);
});

if (total !== EXPECTED_TOTAL) errors.push(`插入总行数应为 ${EXPECTED_TOTAL}，实为 ${total}`);

if (errors.length > 0) {
  console.error("FAIL");
  errors.forEach((e) => console.error(` - ${e}`));
  process.exit(1);
}

console.log(`OK items=${items.length} lines=${total}`);
