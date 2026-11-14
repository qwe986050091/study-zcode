import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b73-spec-05.json";
const targetPath = "d:/code/ZCode/packages/web/src/auth/zaiWebOAuthProvider.ts";
const EXPECTED_TOTAL = 60;

const FORBIDDEN_START = [
  "const", "let", "var", "function", "class", "import", "export", "return", "if", "else",
  "for", "while", "switch", "try", "catch", "await", "async", "throw", "new", "interface",
  "type", "enum",
];

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const src = fs.readFileSync(targetPath, "utf8");
const fileLines = src.split(/\r?\n/);

const errors = [];
let totalLines = 0;
let blockCount = 0;

for (const entry of spec.files) {
  const usedIndices = new Map();
  const plan = [];

  for (const item of entry.items) {
    blockCount += 1;
    const anchor = item.anchor;
    if (typeof anchor !== "string" || anchor.trim() === "") {
      errors.push(`anchor 无效: ${JSON.stringify(anchor)}`);
      continue;
    }
    const hits = [];
    for (let i = 0; i < fileLines.length; i += 1) {
      if (fileLines[i].trim() === anchor.trim()) hits.push(i);
    }
    let index;
    if (item.nth) {
      if (hits.length < item.nth) {
        errors.push(`anchor 第 ${item.nth} 次不存在: ${anchor}`);
        continue;
      }
      index = hits[item.nth - 1];
    } else {
      if (hits.length !== 1) {
        errors.push(`anchor 命中 ${hits.length} 次（需唯一）: ${anchor}`);
        continue;
      }
      index = hits[0];
    }
    if (usedIndices.has(index)) {
      errors.push(`重复插入下标 ${index}: ${anchor}`);
    }
    usedIndices.set(index, true);

    let produced = [];
    if (Array.isArray(item.raw)) {
      produced = item.raw.slice();
    } else if (Array.isArray(item.lines)) {
      const indentMatch = /^[ \t]*/.exec(fileLines[index]);
      const indent = indentMatch ? indentMatch[0] : "";
      produced = item.lines.map((l) => (l === "" ? `${indent}//` : `${indent}// ${l}`));
    } else {
      errors.push(`item 既无 raw 也无 lines: ${anchor}`);
      continue;
    }

    for (const line of produced) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("//")) errors.push(`插入行未以 // 开头: ${line}`);
      if (trimmed.includes("*/")) errors.push(`插入行含 */: ${line}`);
      if (trimmed.endsWith(";")) errors.push(`插入行以分号结尾: ${line}`);
      if (trimmed.includes("=>")) errors.push(`插入行含箭头: ${line}`);
      if (/\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(trimmed)) {
        errors.push(`插入行疑似调用表达式: ${line}`);
      }
      const body = trimmed.replace(/^\/+/, "").trim();
      const first = body.split(/\s+/)[0] || "";
      if (FORBIDDEN_START.includes(first)) errors.push(`插入行以禁止词 ${first} 开头: ${line}`);
    }

    if (item.raw) {
      if (item.raw.length !== 22) errors.push(`文件头 raw 长度 ${item.raw.length} 应为 22`);
      if (!item.raw[0].startsWith("// INV-01")) errors.push(`文件头首行不是 // INV-01: ${item.raw[0]}`);
      if (item.raw[18] !== "//") errors.push(`文件头第 19 行不是 //: ${JSON.stringify(item.raw[18])}`);
    }

    totalLines += produced.length;
    plan.push({ index, produced });
  }

  plan.sort((a, b) => a.index - b.index);
}

if (totalLines !== EXPECTED_TOTAL) errors.push(`插入总行数 ${totalLines} !== ${EXPECTED_TOTAL}`);

if (errors.length > 0) {
  console.log("FAIL");
  for (const e of errors) console.log("- " + e);
  process.exit(1);
}

console.log(`OK blocks=${blockCount} lines=${totalLines}`);
