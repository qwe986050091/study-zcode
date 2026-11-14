import fs from "node:fs";
import path from "node:path";

const SPEC_PATH = "d:/code/_annot_baseline/ZC-deep-b63-spec-09.json";
const REPO_ROOT = "d:/code/ZCode";
const EXPECTED_TOTAL = 66;

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
if (!spec || !Array.isArray(spec.files) || spec.files.length === 0) {
  throw new Error("spec.files 为空");
}
const fileEntry = spec.files[0];
const items = fileEntry.items;
if (!Array.isArray(items) || items.length === 0) {
  throw new Error("items 非空校验失败");
}

const absFile = path.join(REPO_ROOT, fileEntry.file);
const sourceLines = fs.readFileSync(absFile, "utf8").split(/\r?\n/);

const KEYWORD_RE =
  /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const DOTTED_CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const problems = [];
let total = 0;

items.forEach((item, idx) => {
  const isFirst = idx === 0;
  if (isFirst) {
    if (!Array.isArray(item.raw) || item.raw.length === 0) {
      problems.push("首项缺少 raw");
      return;
    }
    item.raw.forEach((line, i) => {
      if (!/^\/\/ /.test(line) && line !== "//") {
        problems.push(`首项 raw[${i}] 未以 // 开头: ${line}`);
      }
    });
    total += item.raw.length;
  } else {
    if (!Array.isArray(item.lines) || item.lines.length === 0) {
      problems.push(`第 ${idx + 1} 项缺少 lines`);
      return;
    }
    total += item.lines.length;
  }

  // 锚点唯一性
  if (typeof item.anchor !== "string" || item.anchor.trim() === "") {
    problems.push(`第 ${idx + 1} 项 anchor 为空`);
    return;
  }
  const anchor = item.anchor.trim();
  const matches = [];
  sourceLines.forEach((line, i) => {
    if (line.trim() === anchor) matches.push(i + 1);
  });
  const nth = item.nth ?? 1;
  if (!Number.isInteger(nth) || nth < 1) {
    problems.push(`第 ${idx + 1} 项 nth 非法: ${item.nth}`);
  } else if (matches.length === 0) {
    problems.push(`第 ${idx + 1} 项 anchor 未匹配: ${anchor}`);
  } else if (matches.length < nth) {
    problems.push(
      `第 ${idx + 1} 项 nth 越界(${nth} > ${matches.length}): ${anchor}`,
    );
  } else if (matches.length > 1 && item.nth === undefined) {
    problems.push(
      `第 ${idx + 1} 项 anchor 重复(${matches.join(",")}): ${anchor}`,
    );
  }

  // 禁词
  const bodies = isFirst
    ? item.raw.map((l) => l.replace(/^\/\/ ?/, ""))
    : item.lines;
  bodies.forEach((body, i) => {
    const text = String(body);
    if (text.includes("*/")) {
      problems.push(`第 ${idx + 1} 项第 ${i + 1} 行含 */`);
    }
    if (KEYWORD_RE.test(text.trim())) {
      problems.push(`第 ${idx + 1} 项第 ${i + 1} 行以关键字开头: ${text}`);
    }
    if (text.trim().endsWith(";")) {
      problems.push(`第 ${idx + 1} 项第 ${i + 1} 行以分号结尾`);
    }
    if (text.includes("=>")) {
      problems.push(`第 ${idx + 1} 项第 ${i + 1} 行含 =>`);
    }
    if (DOTTED_CALL_RE.test(text)) {
      problems.push(`第 ${idx + 1} 项第 ${i + 1} 行含点号调用: ${text}`);
    }
  });
});

if (total !== EXPECTED_TOTAL) {
  problems.push(`总行数 ${total} !== ${EXPECTED_TOTAL}`);
}

const codeLines = sourceLines.filter(
  (l) => l.trim() !== "" && !l.trim().startsWith("//"),
).length;
const existingComments = sourceLines.filter((l) => l.trim().startsWith("//"))
  .length;
const ratio = (existingComments + total) / codeLines;
const ratioPctExact = (ratio * 100).toFixed(2);
const ratioPct = Math.round(ratio * 1000) / 10;

console.log(
  `anchors=${items.length} inserted=${total} comments=${existingComments + total} codeLines=${codeLines} ratio=${ratioPctExact}% (${ratioPct}%)`,
);

if (problems.length > 0) {
  console.error("FAIL");
  problems.forEach((p) => console.error(" - " + p));
  process.exit(1);
}
if (ratioPct < 31.2 || ratioPct > 31.6) {
  console.error(`FAIL ratio ${ratioPctExact}% 不在 31.2%~31.6%`);
  process.exit(1);
}
console.log("OK");
