import { readFileSync } from "node:fs";

const root = "d:/code";
const specPath = `${root}/_annot_baseline/ZC-deep-b70-spec-12.json`;
const spec = JSON.parse(readFileSync(specPath, "utf8"));

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};

const entry = spec.files[0];
const relPath = entry.file;

const filePath = `${root}/ZCode/${relPath}`;
const src = readFileSync(filePath, "utf8");
const srcLines = src.split(/\r?\n/);
const trimmed = srcLines.map((l) => l.trim());

const FORBIDDEN_HEAD =
  /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const CALL_EXPR = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

let totalInserted = 0;
const usedIndexes = new Map();
let blockCount = 0;

entry.items.forEach((item, itemIdx) => {
  const anchorTrim = item.anchor.trim();
  const hits = [];
  trimmed.forEach((l, i) => {
    if (l === anchorTrim) hits.push(i);
  });
  if (hits.length === 0) {
    fail(`item#${itemIdx} anchor 未命中: ${JSON.stringify(item.anchor)}`);
    return;
  }
  const nth = item.nth;
  let index;
  if (nth === undefined) {
    if (hits.length !== 1) {
      fail(`item#${itemIdx} anchor 命中 ${hits.length} 次但未指定 nth: ${JSON.stringify(item.anchor)}`);
      return;
    }
    index = hits[0];
  } else {
    if (!Number.isInteger(nth) || nth < 1 || nth > hits.length) {
      fail(`item#${itemIdx} nth=${nth} 非法，命中 ${hits.length} 次`);
      return;
    }
    index = hits[nth - 1];
  }
  if (usedIndexes.has(index)) {
    fail(`插入下标重复: ${index} (item#${usedIndexes.get(index)} 与 item#${itemIdx})`);
    return;
  }
  usedIndexes.set(index, itemIdx);

  // 模拟插入器：raw 原样，lines 套锚点缩进并加 "// " 前缀
  const indentMatch = srcLines[index].match(/^\s*/);
  const indent = indentMatch ? indentMatch[0] : "";
  const inserted = [];
  if (item.raw !== undefined) {
    if (item.lines !== undefined) fail(`item#${itemIdx} 同时含 raw 与 lines`);
    item.raw.forEach((rawLine, rawIdx) => {
      if (rawIdx === 0 && rawLine.startsWith("//") && itemIdx === 0 && indent !== "") {
        fail(`文件头 raw 不应加缩进，锚点缩进为 ${JSON.stringify(indent)}`);
      }
      inserted.push(rawLine);
    });
  } else if (item.lines !== undefined) {
    item.lines.forEach((text) => {
      inserted.push(text === "" ? `${indent}//` : `${indent}// ${text}`);
    });
  } else {
    fail(`item#${itemIdx} 既无 raw 也无 lines`);
    return;
  }

  blockCount += 1;
  totalInserted += inserted.length;

  inserted.forEach((line, k) => {
    if (!line.trim().startsWith("//")) {
      fail(`item#${itemIdx} 第 ${k + 1} 行不以 // 开头: ${JSON.stringify(line)}`);
    }
    if (line.includes("*/")) {
      fail(`item#${itemIdx} 第 ${k + 1} 行含 */: ${JSON.stringify(line)}`);
    }
    const body = line.trim().replace(/^\/\/\s?/, "").trim();
    if (body === "") return;
    if (FORBIDDEN_HEAD.test(body)) {
      fail(`item#${itemIdx} 第 ${k + 1} 行以禁止词开头: ${JSON.stringify(body)}`);
    }
    if (body.endsWith(";")) {
      fail(`item#${itemIdx} 第 ${k + 1} 行以分号结尾: ${JSON.stringify(body)}`);
    }
    if (body.includes("=>")) {
      fail(`item#${itemIdx} 第 ${k + 1} 行含箭头: ${JSON.stringify(body)}`);
    }
    if (CALL_EXPR.test(body)) {
      fail(`item#${itemIdx} 第 ${k + 1} 行含 foo.bar( 形式调用: ${JSON.stringify(body)}`);
    }
  });
});

// (e) 总行数
if (totalInserted !== 65) fail(`插入总行数 ${totalInserted} !== 65`);

// (f) 文件头结构
const header = entry.items[0];
if (!Array.isArray(header.raw) || header.raw.length !== 22) {
  fail(`文件头 raw 长度 ${header.raw ? header.raw.length : "N/A"} !== 22`);
} else {
  if (!header.raw[0].startsWith("// INV-01")) fail(`文件头首行不是 // INV-01: ${JSON.stringify(header.raw[0])}`);
  if (header.raw[18] !== "//") fail(`文件头第 19 行不是 //: ${JSON.stringify(header.raw[18])}`);
  const invSeq = header.raw.slice(0, 18).map((l, i) => {
    const expected = `// INV-${String(i + 1).padStart(2, "0")} `;
    return l.startsWith(expected);
  });
  if (invSeq.some((ok) => !ok)) fail("文件头 INV 序号不连续或格式不符");
  if (!header.raw[19].startsWith("// 模块职责：")) fail("文件头缺少模块职责");
  if (!header.raw[20].startsWith("// 状态所有权：")) fail("文件头缺少状态所有权");
  if (!header.raw[21].startsWith("// 阅读顺序：")) fail("文件头缺少阅读顺序");
}

if (process.exitCode && process.exitCode !== 0) {
  console.error("CHECK FAILED");
} else {
  console.log(`OK blocks=${blockCount} lines=${totalInserted}`);
}
