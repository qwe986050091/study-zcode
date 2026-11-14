import { readFileSync } from "node:fs";

const SPEC_PATH = "d:/code/_annot_baseline/ZC-deep-b69-spec-09.json";
const TARGET_PATH = "d:/code/ZCode/apps/zcode-cli/packages/core/src/tool/handlers/bash-read-file-sources.ts";
const EXPECTED_TOTAL = 63;
const FORBIDDEN_HEADS = new Set([
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
]);

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8"));
const rawFile = readFileSync(TARGET_PATH, "utf8");
const fileLines = rawFile.split("\n").map((line) => line.replace(/\r$/, ""));

const errors = [];
const fail = (msg) => errors.push(msg);

let total = 0;
let blockCount = 0;
const usedIndices = new Map();

for (const fileEntry of spec.files) {
  for (const [itemIndex, item] of fileEntry.items.entries()) {
    blockCount += 1;
    const anchor = item.anchor;
    const hits = [];
    for (let i = 0; i < fileLines.length; i += 1) {
      if (fileLines[i].trim() === anchor.trim()) hits.push(i);
    }
    if (hits.length === 0) {
      fail(`item#${itemIndex} anchor 未命中: ${anchor}`);
      continue;
    }
    let hitIndex;
    if (item.nth !== undefined) {
      if (item.nth < 1 || item.nth > hits.length) {
        fail(`item#${itemIndex} nth=${item.nth} 超出命中数 ${hits.length}: ${anchor}`);
        continue;
      }
      hitIndex = hits[item.nth - 1];
    } else {
      if (hits.length !== 1) {
        fail(`item#${itemIndex} anchor 不唯一(${hits.length} 次): ${anchor}`);
        continue;
      }
      hitIndex = hits[0];
    }
    if (usedIndices.has(hitIndex)) {
      fail(`插入下标重复 ${hitIndex}: item#${itemIndex} 与 item#${usedIndices.get(hitIndex)}`);
    } else {
      usedIndices.set(hitIndex, itemIndex);
    }

    const indentMatch = /^[ \t]*/.exec(fileLines[hitIndex]);
    const indent = indentMatch ? indentMatch[0] : "";

    let inserted;
    if (Array.isArray(item.raw)) {
      inserted = item.raw.slice();
    } else if (Array.isArray(item.lines)) {
      inserted = item.lines.map((text) => (text === "" ? `${indent}//` : `${indent}// ${text}`));
    } else {
      fail(`item#${itemIndex} 既无 raw 也无 lines`);
      continue;
    }

    total += inserted.length;

    if (Array.isArray(item.lines)) {
      if (item.lines.length < 3 || item.lines.length > 6) {
        fail(`item#${itemIndex} lines 长度 ${item.lines.length} 不在 3~6`);
      }
    }

    for (const line of inserted) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("//")) fail(`item#${itemIndex} 插入行未以 // 开头: ${line}`);
      if (line.includes("*/")) fail(`item#${itemIndex} 插入行含 */: ${line}`);
      if (/=>/.test(line)) fail(`item#${itemIndex} 插入行含 =>: ${line}`);
      if (trimmed.endsWith(";")) fail(`item#${itemIndex} 插入行以分号结尾: ${line}`);
      const body = trimmed.replace(/^\/\/+/, "").trimStart();
      const head = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(body);
      if (head && FORBIDDEN_HEADS.has(head[0])) {
        fail(`item#${itemIndex} 插入行注释文本以禁止词 ${head[0]} 开头: ${line}`);
      }
      if (/[A-Za-z0-9_$\])][.][A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(line)) {
        fail(`item#${itemIndex} 插入行疑似调用表达式: ${line}`);
      }
    }

    if (itemIndex === 0 && fileEntry.items[0] === item) {
      const raw = item.raw ?? [];
      if (raw.length !== 22) fail(`文件头 raw 长度 ${raw.length} 应为 22`);
      if (!String(raw[0] ?? "").startsWith("// INV-01")) fail("文件头首行不是 // INV-01");
      if (raw[18] !== "//") fail(`文件头第 19 行应为 //，实际: ${raw[18]}`);
      const invCount = raw.filter((line) => /^\/\/ INV-\d{2} /.test(line)).length;
      if (invCount !== 18) fail(`文件头 INV 行数 ${invCount} 应为 18`);
    }
  }
}

if (total !== EXPECTED_TOTAL) fail(`插入总行数 ${total} 应为 ${EXPECTED_TOTAL}`);

if (errors.length > 0) {
  console.error("FAIL");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`OK blocks=${blockCount} lines=${total}`);
