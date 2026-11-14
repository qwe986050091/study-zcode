import { readFileSync } from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b72-spec-02.json";
const spec = JSON.parse(readFileSync(specPath, "utf8"));

const banned = new Set([
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
]);

const callRe = /[A-Za-z_$][A-Za-z0-9_$]*\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\(/;

const failures = [];
let totalInserted = 0;
let blockCount = 0;
let headerRaw = null;

for (const entry of spec.files) {
  const abs = `d:/code/ZCode/${entry.file}`;
  const original = readFileSync(abs, "utf8").split(/\r?\n/);
  const isLastEmpty = original.length > 0 && original[original.length - 1] === "";

  const indices = new Set();
  let simulated = 0;

  for (const item of entry.items) {
    blockCount += 1;
    const hasRaw = Array.isArray(item.raw);
    const hasLines = Array.isArray(item.lines);
    if (hasRaw === hasLines) {
      failures.push(`item 必须且只能有 raw 或 lines 之一: ${item.anchor}`);
      continue;
    }
    const lines = hasRaw ? item.raw : item.lines;
    if (hasRaw && !hasLines && blockCount === 1) headerRaw = item.raw;

    if (!hasRaw) {
      if (lines.length < 3 || lines.length > 6) {
        failures.push(`lines 块行数不在 3~6: ${item.anchor} -> ${lines.length}`);
      }
    }

    const anchor = item.anchor;
    const matches = [];
    original.forEach((line, i) => {
      if (line.trim() === anchor.trim()) matches.push(i);
    });
    const nth = item.nth ?? 1;
    if (matches.length === 0) {
      failures.push(`anchor 未命中: ${anchor}`);
      continue;
    }
    if (matches.length > 1 && item.nth === undefined) {
      failures.push(`anchor 不唯一(${matches.length}): ${anchor}`);
      continue;
    }
    if (nth < 1 || nth > matches.length) {
      failures.push(`nth 越界: ${anchor} nth=${nth} 命中=${matches.length}`);
      continue;
    }
    const at = matches[nth - 1];
    if (original[at].trim() === "") {
      failures.push(`anchor 是空行: ${anchor}`);
      continue;
    }
    if (indices.has(at)) {
      failures.push(`重复插入下标 ${at}: ${anchor}`);
      continue;
    }
    indices.add(at);

    const indentMatch = original[at].match(/^[\t ]*/);
    const indent = indentMatch ? indentMatch[0] : "";

    lines.forEach((rawLine) => {
      let out;
      if (hasRaw) {
        if (/^[\t ]/.test(rawLine)) {
          failures.push(`raw 行不應带缩进: ${JSON.stringify(rawLine)}`);
        }
        out = rawLine;
      } else {
        out = rawLine === "" ? `${indent}//` : `${indent}// ${rawLine}`;
      }

      const trimmed = out.trim();
      if (!trimmed.startsWith("//")) failures.push(`插入行未以 // 开头: ${trimmed}`);
      if (out.includes("*/")) failures.push(`插入行含 */: ${trimmed}`);

      let text = trimmed.startsWith("//") ? trimmed.slice(2) : trimmed;
      text = text.trim();
      if (text.endsWith(";")) failures.push(`插入行以分号结尾: ${trimmed}`);
      if (text.includes("=>")) failures.push(`插入行含箭头: ${trimmed}`);
      if (callRe.test(text)) failures.push(`插入行疑似调用表达式: ${trimmed}`);

      const head = text.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
      if (head && banned.has(head[0].toLowerCase())) {
        failures.push(`插入行以禁止词开头(${head[0]}): ${trimmed}`);
      }

      totalInserted += 1;
      simulated += 1;
    });
  }

  if (simulated !== 62) failures.push(`总插入行数 ${simulated} !== 62`);

  if (!headerRaw) {
    failures.push("缺少文件头 raw");
  } else {
    if (headerRaw.length !== 22) failures.push(`文件头 raw 长度 ${headerRaw.length} !== 22`);
    if (!headerRaw[0].startsWith("// INV-01")) failures.push(`文件头首行不是 // INV-01: ${headerRaw[0]}`);
    if (headerRaw[18] !== "//") failures.push(`文件头第 19 行不是 //: ${JSON.stringify(headerRaw[18])}`);
    for (let i = 0; i < 18; i += 1) {
      const tag = `// INV-${String(i + 1).padStart(2, "0")}`;
      if (!headerRaw[i].startsWith(tag)) failures.push(`文件头第 ${i + 1} 行不是 ${tag}`);
      if (!headerRaw[i].includes("守住位置") || !headerRaw[i].includes("改错故障")) {
        failures.push(`文件头 ${tag} 缺少「守住位置」或「改错故障」`);
      }
    }
    for (let i = 19; i < 22; i += 1) {
      if (!/^\/\/ (模块职责|状态所有权|阅读顺序)：/u.test(headerRaw[i])) {
        failures.push(`文件头收尾行格式不符: ${headerRaw[i]}`);
      }
    }
  }

  const rebuilt = [];
  for (let i = 0; i < original.length; i += 1) {
    if (isLastEmpty && i === original.length - 1) continue;
    rebuilt.push(original[i]);
  }
  const insertedTotal = totalInserted;
  if (rebuilt.length + insertedTotal - (isLastEmpty ? 0 : 0) < rebuilt.length) {
    failures.push("行数模拟异常");
  }
}

if (totalInserted !== 62) failures.push(`全局总插入行数 ${totalInserted} !== 62`);

if (failures.length > 0) {
  console.error("FAIL");
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

console.log(`OK blocks=${blockCount} lines=${totalInserted}`);
