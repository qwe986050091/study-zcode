import { readFileSync } from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b66-spec-06.json";
const SRC = "d:/code/ZCode/apps/zcode-cli/packages/tui/src/app-events.ts";
const EXPECT_TOTAL = 67;
const EXPECT_FIRST = 22;

const FORBIDDEN_START =
  /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const CALL_EXPR = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

function fail(msg) {
  console.error("FAIL: " + msg);
  process.exit(1);
}

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
if (!Array.isArray(spec.files) || spec.files.length !== 1) fail("files 必须且只能有一项");
const entry = spec.files[0];
if (entry.file !== "apps/zcode-cli/packages/tui/src/app-events.ts") fail("file 路径不符");
if (!Array.isArray(entry.items) || entry.items.length === 0) fail("items 为空");

const srcLines = readFileSync(SRC, "utf8").split(/\r?\n/);
const firstLine = srcLines[0].trim();

let total = 0;
entry.items.forEach((item, index) => {
  if (typeof item.anchor !== "string") fail(`item[${index}] 缺少 anchor`);
  const anchor = item.anchor.trim();

  if (index === 0 && anchor !== firstLine) {
    fail(`第一项 anchor 不等于文件首行\n  期望: ${firstLine}\n  实际: ${anchor}`);
  }

  const hits = [];
  srcLines.forEach((line, i) => {
    if (line.trim() === anchor) hits.push(i);
  });
  if (hits.length === 0) fail(`item[${index}] anchor 在文件中不存在: ${anchor}`);

  const nth = item.nth;
  if (nth !== undefined) {
    if (!Number.isInteger(nth) || nth < 1 || nth > hits.length) {
      fail(`item[${index}] nth 非法: ${nth}（命中数 ${hits.length}）`);
    }
  } else if (hits.length > 1) {
    fail(`item[${index}] anchor 重复 ${hits.length} 次且未给 nth: ${anchor}`);
  }

  const hasRaw = Array.isArray(item.raw);
  const hasLines = Array.isArray(item.lines);
  if (hasRaw === hasLines) fail(`item[${index}] 必须且只能有 raw 或 lines 之一`);

  const bucket = hasRaw ? item.raw : item.lines;
  if (bucket.length === 0) fail(`item[${index}] 内容为空`);
  if (index === 0) {
    if (!hasRaw) fail("第一项必须使用 raw");
    if (bucket.length !== EXPECT_FIRST) {
      fail(`第一项必须 ${EXPECT_FIRST} 行，实际 ${bucket.length}`);
    }
  }

  bucket.forEach((line, j) => {
    if (typeof line !== "string") fail(`item[${index}][${j}] 非字符串`);
    const rendered = hasRaw ? line : line === "" ? "//" : "// " + line;
    const body = rendered.trim().replace(/^\/\/\s?/, "");

    if (rendered.includes("*/") || body.includes("*/")) fail(`item[${index}][${j}] 含 */`);
    if (body.trimEnd().endsWith(";")) fail(`item[${index}][${j}] 以 ; 结尾: ${body}`);
    if (body.includes("=>")) fail(`item[${index}][${j}] 含 =>: ${body}`);
    if (FORBIDDEN_START.test(body.trim())) fail(`item[${index}][${j}] 以禁词开头: ${body}`);
    if (CALL_EXPR.test(body)) fail(`item[${index}][${j}] 含调用表达式: ${body}`);
    if (body.trim() === "") return;
    if (/TODO|待补充/.test(body)) fail(`item[${index}][${j}] 含空话或 TODO`);
  });

  total += bucket.length;
});

if (total !== EXPECT_TOTAL) fail(`总行数 ${total} ≠ ${EXPECT_TOTAL}`);

console.log(`OK items=${entry.items.length} total=${total} first=${entry.items[0].raw.length}`);
