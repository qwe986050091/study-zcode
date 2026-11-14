import fs from "node:fs";

const SPEC_PATH = "d:\\code\\_annot_baseline\\ZC-deep-b75-spec-05.json";
const TARGET_PATH =
  "d:\\code\\ZCode\\packages\\web\\src\\web-remote-control\\app\\webRemoteControlEntry.ts";
const REL_PATH = "packages/web/src/web-remote-control/app/webRemoteControlEntry.ts";
const EXPECT_TOTAL = 60;
const EXPECT_HEADER = 22;

const FORBIDDEN =
  /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const CALL_EXPR = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

const errors = [];
const err = (m) => errors.push(m);

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
if (!Array.isArray(spec.files) || spec.files.length !== 1) {
  err("spec.files 必须恰好包含 1 个文件");
}
const entry = spec.files[0];
if (!entry || entry.file !== REL_PATH) {
  err("spec 中 file 路径与目标不一致");
}

const srcLines = fs
  .readFileSync(TARGET_PATH, "utf8")
  .split("\n")
  .map((l) => l.replace(/\r$/, ""));
const trimmed = srcLines.map((l) => l.trim());

let totalInserted = 0;
let blockCount = 0;
const usedIndexes = new Map();

// raw 模式：按原样插入，不补前缀，也不加缩进；仅校验正文内容。
const checkBody = (text, where) => {
  if (text.includes("*/")) err(`${where} 含 */`);
  if (FORBIDDEN.test(text)) err(`${where} 以禁止词开头: ${text}`);
  if (text.endsWith(";")) err(`${where} 以分号结尾: ${text}`);
  if (text.includes("=>")) err(`${where} 含箭头: ${text}`);
  if (CALL_EXPR.test(text)) err(`${where} 含调用表达式: ${text}`);
};

const items = entry.items || [];
items.forEach((item, itemIdx) => {
  blockCount += 1;
  const isRaw = Array.isArray(item.raw);
  const outgoing = isRaw ? item.raw : Array.isArray(item.lines) ? item.lines : null;
  if (!outgoing) {
    err(`item[${itemIdx}] 缺少 raw 或 lines`);
    return;
  }
  if (isRaw && Array.isArray(item.lines)) {
    err(`item[${itemIdx}] 不能同时使用 raw 与 lines`);
    return;
  }
  if (typeof item.anchor !== "string" || item.anchor.trim() === "") {
    err(`item[${itemIdx}] anchor 为空`);
    return;
  }
  if (!isRaw) {
    if (outgoing.length < 3 || outgoing.length > 6) {
      err(`item[${itemIdx}] lines 长度 ${outgoing.length} 不在 3~6`);
    }
  }

  const anchorTrim = item.anchor.trim();
  const matches = [];
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === anchorTrim) matches.push(i);
  }
  let targetIdx;
  if (item.nth !== undefined) {
    if (!Number.isInteger(item.nth) || item.nth < 1) {
      err(`item[${itemIdx}] nth 非法: ${item.nth}`);
      return;
    }
    if (matches.length < item.nth) {
      err(`item[${itemIdx}] anchor 命中 ${matches.length} 次，不足 nth=${item.nth}`);
      return;
    }
    targetIdx = matches[item.nth - 1];
  } else {
    if (matches.length === 0) {
      err(`item[${itemIdx}] anchor 未命中: ${anchorTrim}`);
      return;
    }
    if (matches.length > 1) {
      err(`item[${itemIdx}] anchor 命中 ${matches.length} 次（需唯一或指定 nth）: ${anchorTrim}`);
      return;
    }
    targetIdx = matches[0];
  }

  if (targetIdx > 0 && /^\s*\/\//.test(srcLines[targetIdx])) {
    err(`item[${itemIdx}] anchor 指向注释行: ${anchorTrim}`);
  }
  if (usedIndexes.has(targetIdx)) {
    err(`item[${itemIdx}] 插入下标 ${targetIdx} 与 item[${usedIndexes.get(targetIdx)}] 重复`);
  } else {
    usedIndexes.set(targetIdx, itemIdx);
  }

  const anchorLine = srcLines[targetIdx];
  const indentMatch = anchorLine.match(/^[ \t]*/);
  const indent = isRaw ? "" : indentMatch ? indentMatch[0] : "";

  outgoing.forEach((rawLine, lineIdx) => {
    totalInserted += 1;
    const where = `item[${itemIdx}].line[${lineIdx}]`;
    if (typeof rawLine !== "string") {
      err(`${where} 不是字符串`);
      return;
    }
    if (rawLine.includes("\n") || rawLine.includes("\r")) {
      err(`${where} 含换行`);
    }

    let finalLine;
    if (isRaw) {
      // 原样插入：必须已经自带 "//" 前缀，空注释行恰好是 "//"。
      finalLine = rawLine;
      if (rawLine !== "//" && !rawLine.startsWith("// ")) {
        err(`${where} raw 未自带 "// " 前缀: ${rawLine}`);
        return;
      }
      if (rawLine !== "//" && rawLine.trimEnd() !== rawLine) {
        err(`${where} raw 行尾有多余空白: ${JSON.stringify(rawLine)}`);
      }
    } else {
      finalLine = rawLine === "" ? `${indent}//` : `${indent}// ${rawLine}`;
    }

    const t = finalLine.trim();
    if (!t.startsWith("//")) err(`${where} 插入后不以 // 开头: ${t}`);
    const text = t === "//" ? "" : t.replace(/^\/\/\s?/, "").trim();
    checkBody(text, where);
  });
});

const header = items[0];
if (!header || !Array.isArray(header.raw)) {
  err("第一个 item 必须使用 raw 并作为文件头");
} else {
  if (header.raw.length !== EXPECT_HEADER) {
    err(`文件头 raw 长度 ${header.raw.length} != ${EXPECT_HEADER}`);
  }
  if (header.raw[18] !== "//") {
    err(`文件头第 19 行必须恰好是 "//"，实际: ${JSON.stringify(header.raw[18])}`);
  }
  let invCount = 0;
  for (let i = 0; i < 18; i += 1) {
    const want = `// INV-${String(i + 1).padStart(2, "0")} `;
    if (!String(header.raw[i]).startsWith(want)) {
      err(`文件头 INV 序号错位: 期望 ${want}，实际 ${header.raw[i]}`);
    } else {
      invCount += 1;
    }
    if (!String(header.raw[i]).includes("守住位置") || !String(header.raw[i]).includes("改错故障")) {
      err(`文件头 INV-${i + 1} 缺少 守住位置/改错故障`);
    }
  }
  if (invCount !== 18) err(`INV 行数 ${invCount} != 18`);
  const tail = header.raw.slice(19, 22);
  if (tail.length !== 3) err("文件头尾部职责说明不足 3 行");
  const prefixes = ["// 模块职责：", "// 状态所有权：", "// 阅读顺序："];
  tail.forEach((line, i) => {
    if (!String(line).startsWith(prefixes[i])) {
      err(`文件头第 ${20 + i} 行未以 ${prefixes[i]} 开头: ${line}`);
    }
  });
  if (!String(header.raw[0]).startsWith("// INV-01 ")) {
    err("文件头首行未以 // INV-01 开头");
  }
  if (header.anchor.trim() !== srcLines[0].trim()) {
    err(`首块 anchor 必须是文件首行: ${header.anchor}`);
  }
}

if (totalInserted !== EXPECT_TOTAL) {
  err(`插入总行数 ${totalInserted} != ${EXPECT_TOTAL}`);
}

if (errors.length > 0) {
  console.error("FAIL");
  for (const e of errors) console.error(" - " + e);
  process.exit(1);
}
console.log(`OK blocks=${blockCount} lines=${totalInserted}`);
