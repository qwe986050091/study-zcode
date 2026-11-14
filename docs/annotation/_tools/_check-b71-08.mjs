import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b71-spec-08.json";
const targetPath = "d:/code/ZCode/packages/ui/src/v4/sessionQuotaBannerState.ts";

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const rawFile = fs.readFileSync(targetPath, "utf8");
const fileLines = rawFile.split(/\r?\n/);

const FORBIDDEN_PREFIX =
  /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const CALL_EXPR = /[\w$]\.[\w$]+\s*\(/;

const errors = [];
let totalInserted = 0;
let blockCount = 0;
const usedIndexes = new Map();

function fail(msg) {
  errors.push(msg);
}

function checkLine(line, where) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("//")) fail(`${where}: 不以 // 开头 -> ${JSON.stringify(line)}`);
  if (trimmed.includes("*/")) fail(`${where}: 含 */ -> ${JSON.stringify(line)}`);
  if (/[;；]$/.test(trimmed)) fail(`${where}: 以分号结尾 -> ${JSON.stringify(line)}`);
  if (trimmed.includes("=>")) fail(`${where}: 含 => -> ${JSON.stringify(line)}`);
  const text = trimmed.slice(2).trim();
  if (FORBIDDEN_PREFIX.test(text)) fail(`${where}: 注释文本以禁止词开头 -> ${JSON.stringify(text)}`);
  if (CALL_EXPR.test(text)) fail(`${where}: 命中调用表达式模式 -> ${JSON.stringify(text)}`);
}

for (const file of spec.files) {
  if (file.file !== "packages/ui/src/v4/sessionQuotaBannerState.ts") fail(`意外的文件路径 ${file.file}`);

  // ---- 文件头专项断言 ----
  const header = file.items[0];
  if (!Array.isArray(header.raw)) fail("首个 item 必须使用 raw");
  else {
    if (header.raw.length !== 22) fail(`文件头 raw 长度应为 22，实际 ${header.raw.length}`);
    if (!header.raw[0].startsWith("// INV-01")) fail(`文件头首行应 // INV-01 开头 -> ${header.raw[0]}`);
    if (header.raw[18] !== "//") fail(`文件头第 19 行应为 //，实际 ${JSON.stringify(header.raw[18])}`);
    const invCount = header.raw.filter((l) => l.startsWith("// INV-")).length;
    if (invCount !== 18) fail(`文件头 INV 行数应为 18，实际 ${invCount}`);
    header.raw.forEach((l, i) => {
      if (i < 18 && !l.startsWith(`// INV-${String(i + 1).padStart(2, "0")} `)) {
        fail(`第 ${i + 1} 条 INV 编号不匹配 -> ${l.slice(0, 20)}`);
      }
    });
  }

  for (const [itemIndex, item] of file.items.entries()) {
    blockCount += 1;
    const anchor = item.anchor;
    const matches = [];
    fileLines.forEach((line, idx) => {
      if (line.trim() === anchor.trim()) matches.push(idx);
    });
    if (matches.length === 0) {
      fail(`item#${itemIndex}: anchor 未命中 -> ${JSON.stringify(anchor)}`);
      continue;
    }
    let insertAt;
    if (item.nth !== undefined) {
      if (matches.length < item.nth) {
        fail(`item#${itemIndex}: nth=${item.nth} 超出命中次数 ${matches.length} -> ${JSON.stringify(anchor)}`);
        continue;
      }
      insertAt = matches[item.nth - 1];
    } else {
      if (matches.length !== 1) {
        fail(`item#${itemIndex}: anchor 命中 ${matches.length} 次不唯一 -> ${JSON.stringify(anchor)}`);
        continue;
      }
      insertAt = matches[0];
    }
    if (usedIndexes.has(insertAt)) {
      fail(`item#${itemIndex}: 插入下标 ${insertAt} 与 item#${usedIndexes.get(insertAt)} 重复`);
    }
    usedIndexes.set(insertAt, itemIndex);

    const hasRaw = Array.isArray(item.raw);
    const hasLines = Array.isArray(item.lines);
    if (hasRaw === hasLines) {
      fail(`item#${itemIndex}: raw 与 lines 必须二选一`);
      continue;
    }
    const inserted = hasRaw
      ? item.raw.slice()
      : item.lines.map((l) => (l === "" ? "//" : `// ${l}`));
    if (inserted.length < 3 || inserted.length > 6) {
      if (itemIndex !== 0) fail(`item#${itemIndex}: 块行数 ${inserted.length} 不在 3~6`);
    }
    totalInserted += inserted.length;
    inserted.forEach((line, i) => checkLine(line, `item#${itemIndex}[${i}]`));
  }

  const outputCount = fileLines.length + totalInserted;
  if (totalInserted !== 63) fail(`新增总行数应为 63，实际 ${totalInserted}`);
  if (outputCount !== fileLines.length + 63) fail("输出行数校验失败");
}

if (errors.length > 0) {
  console.error("FAILED");
  errors.forEach((e) => console.error(` - ${e}`));
  process.exit(1);
}

console.log(`blocks=${blockCount} lines=${totalInserted} targetLines=${fileLines.length}`);
console.log("OK");
