// 校验 ZC-deep-b67-spec-07.json：单文件、anchor 存在且唯一、首个 anchor 为文件首行、总行数 65、注释行合规。
// 用法：node _check-b67-07.mjs
import fs from "node:fs";

const repo = "D:/code/ZCode";
const specPath = "D:/code/_annot_baseline/ZC-deep-b67-spec-07.json";
const expectedFile = "packages/ui/src/v4/useV4SessionQuotaBanner.ts";
const expectedTotal = 65;

const BANNED_PREFIX =
  /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const CALL_EXPR = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

let bad = 0;
const fail = (msg) => {
  bad += 1;
  console.log("FAIL " + msg);
};

let spec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
} catch (err) {
  console.log("FAIL JSON 解析失败: " + err.message);
  process.exit(1);
}

if (!Array.isArray(spec.files) || spec.files.length !== 1) {
  fail("files 必须且只能包含 1 个文件，实际 " + (Array.isArray(spec.files) ? spec.files.length : "non-array"));
}
const entry = (spec.files || [])[0];
if (!entry || entry.file !== expectedFile) fail("file 路径不符：" + (entry && entry.file));
if (!entry || !Array.isArray(entry.items) || entry.items.length === 0) fail("items 缺失");

const abs = repo + "/" + (entry ? entry.file : expectedFile);
const fileLines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
const firstLine = (fileLines[0] || "").trim();

let total = 0;
const items = entry && Array.isArray(entry.items) ? entry.items : [];

items.forEach((item, idx) => {
  const anchor = String(item.anchor == null ? "" : item.anchor);
  const raw = item.raw;
  const lines = item.lines;
  const isRaw = Array.isArray(raw);
  const body = isRaw ? raw : Array.isArray(lines) ? lines : null;
  if (!body) {
    fail(`#${idx + 1} 缺少 raw/lines`);
    return;
  }
  if (raw !== undefined && lines !== undefined) fail(`#${idx + 1} raw 与 lines 同时存在`);
  total += body.length;

  const hits = [];
  for (let i = 0; i < fileLines.length; i += 1) {
    if (fileLines[i].trim() === anchor.trim()) hits.push(i + 1);
  }
  if (hits.length === 0) {
    fail(`#${idx + 1} anchor 未找到: ${anchor}`);
  } else if (item.nth !== undefined) {
    if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
      fail(`#${idx + 1} nth 非法: ${item.nth}（命中 ${hits.length} 处）`);
    }
  } else if (hits.length !== 1) {
    fail(`#${idx + 1} anchor 不唯一(${hits.length}): ${anchor} 行 ${hits.join(",")}`);
  }

  if (idx === 0 && anchor.trim() !== firstLine) {
    fail("首个 anchor 不等于文件首行: " + anchor);
  }

  body.forEach((line, li) => {
    if (typeof line !== "string") {
      fail(`#${idx + 1}.${li + 1} 非字符串`);
      return;
    }
    if (isRaw && line !== "" && !line.trimStart().startsWith("//")) {
      fail(`#${idx + 1}.${li + 1} raw 行未以 // 开头: ${line}`);
    }
    const content = line.replace(/^\s*\/\/\s?/, "").trimEnd();
    if (line.includes("*/")) fail(`#${idx + 1}.${li + 1} 含 */: ${line}`);
    if (content.trim() === "") return;
    if (content.endsWith(";")) fail(`#${idx + 1}.${li + 1} 以分号结尾: ${content}`);
    if (content.includes("=>")) fail(`#${idx + 1}.${li + 1} 含 =>: ${content}`);
    if (CALL_EXPR.test(content)) fail(`#${idx + 1}.${li + 1} 含 obj.method( 调用: ${content}`);
    if (BANNED_PREFIX.test(content)) fail(`#${idx + 1}.${li + 1} 以禁词开头: ${content}`);
    if (content.startsWith("//")) fail(`#${idx + 1}.${li + 1} 重复注释前缀: ${content}`);
  });
});

if (total !== expectedTotal) fail(`总行数应为 ${expectedTotal}，实际 ${total}`);

if (bad === 0) {
  console.log(`OK blocks=${items.length} lines=${total}`);
  process.exit(0);
}
console.log(`CHECK FAIL ${bad}`);
process.exit(1);
