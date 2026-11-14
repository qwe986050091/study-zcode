import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const specPath = resolve("d:/code/_annot_baseline/ZC-deep-b65-spec-02.json");
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const EXPECTED_TOTAL = 65;
const REL = "packages/desktop/src/main/forceUpdateGuard.ts";

const bannedStart =
  /^(?:const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const dottedCall = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const errors = [];
const files = spec?.files ?? [];
if (!Array.isArray(files) || files.length !== 1) errors.push(`files 必须只有 1 项，实际 ${files.length}`);
if (files[0]?.file !== REL) errors.push(`file 字段不是 ${REL}`);

let totalLines = 0;
let anchorCount = 0;

const checkBody = (text, where) => {
  const body = String(text).replace(/^\/\/ ?/, "").trim();
  if (body.includes("*/")) errors.push(`${where}: 含 */`);
  if (body.endsWith(";")) errors.push(`${where}: 以 ; 结尾`);
  if (body.includes("=>")) errors.push(`${where}: 含 =>`);
  if (bannedStart.test(body)) errors.push(`${where}: 禁用开头词 -> ${body.slice(0, 24)}`);
  if (dottedCall.test(body)) errors.push(`${where}: 含方法调用形态 -> ${body.slice(0, 32)}`);
};

for (const entry of files) {
  const abs = resolve("d:/code/ZCode", entry.file);
  const rawLines = readFileSync(abs, "utf8").split(/\r?\n/);
  const items = entry.items ?? [];
  if (!Array.isArray(items) || items.length === 0) {
    errors.push(`${entry.file}: items 为空`);
    continue;
  }

  items.forEach((item, i) => {
    anchorCount += 1;
    const anchorTrim = String(item.anchor).trim();
    const hits = rawLines
      .map((l, idx) => (l.trim() === anchorTrim ? idx + 1 : 0))
      .filter((n) => n > 0);
    if (hits.length === 0) errors.push(`item ${i}: anchor 未匹配 -> ${anchorTrim}`);
    const nth = item.nth ?? 1;
    if (nth > hits.length) errors.push(`item ${i}: nth ${nth} 越界（命中 ${hits.length}）`);
    if (hits.length > 1 && !item.nth) errors.push(`item ${i}: anchor 不唯一（命中 ${hits.length}）`);
    if (i === 0 && Number(item.nth ?? 1) !== 1) errors.push("首项 nth 必须为 1");

    if (i === 0) {
      if (rawLines[0]?.trim() !== anchorTrim) errors.push("首项 anchor 不等于文件第一行");
      if (!Array.isArray(item.raw) || item.raw.length === 0) {
        errors.push("首项缺少 raw");
        return;
      }
      if (item.lines) errors.push("首项不应同时提供 lines");
      if (item.raw.length !== 22) errors.push(`首项 raw 必须 22 行，实际 ${item.raw.length}`);
      item.raw.forEach((line, j) => {
        if (!/^\/\/(?: |$)/.test(line)) errors.push(`raw[${j}]: 未以 // 开头 -> ${line.slice(0, 24)}`);
        checkBody(line, `raw[${j}]`);
      });
      totalLines += item.raw.length;
    } else {
      if (!Array.isArray(item.lines) || item.lines.length === 0) {
        errors.push(`item ${i}: 缺少 lines`);
        return;
      }
      if (item.raw) errors.push(`item ${i}: 不应提供 raw`);
      item.lines.forEach((line, j) => {
        if (line.startsWith("//")) errors.push(`item ${i}.lines[${j}]: 不应自带 // 前缀`);
        checkBody(line, `item ${i}.lines[${j}]`);
      });
      totalLines += item.lines.length;
    }
  });
}

if (totalLines !== EXPECTED_TOTAL) errors.push(`总行数 ${totalLines} !== ${EXPECTED_TOTAL}`);

if (errors.length > 0) {
  console.error("FAIL");
  for (const e of errors) console.error(" - " + e);
  process.exit(1);
}

console.log("OK");
console.log(`blocks=${files[0].items.length} totalLines=${totalLines} anchors=${anchorCount}`);
