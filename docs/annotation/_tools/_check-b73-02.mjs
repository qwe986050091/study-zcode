import fs from "node:fs";

const specPath = "d:\\code\\_annot_baseline\\ZC-deep-b73-spec-02.json";
const repoRoot = "d:\\code\\ZCode";

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const FORBIDDEN =
  /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;
const CALL_EXPR = /\b[A-Za-z_$][\w$]*\s*\.\s*[A-Za-z_$][\w$]*\s*\(/;

let failures = [];
const fail = (msg) => failures.push(msg);

let totalLines = 0;
let totalItems = 0;

for (const entry of spec.files) {
  const abs = `${repoRoot}\\${entry.file.replace(/\//g, "\\")}`;
  if (!fs.existsSync(abs)) {
    fail(`file missing: ${abs}`);
    continue;
  }
  const sourceLines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  const insertIndexes = new Set();

  entry.items.forEach((item, itemIndex) => {
    totalItems += 1;
    const key = `[${entry.file}] item#${itemIndex + 1} anchor="${item.anchor}"`;
    const anchorTrim = item.anchor.trim();
    if (anchorTrim === "") {
      fail(`${key} anchor is empty`);
      return;
    }
    const hits = [];
    sourceLines.forEach((line, i) => {
      if (line.trim() === anchorTrim) hits.push(i);
    });
    if (hits.length === 0) {
      fail(`${key} anchor not found`);
      return;
    }
    let lineIndex;
    if (item.nth !== undefined) {
      if (!Number.isInteger(item.nth) || item.nth < 1 || item.nth > hits.length) {
        fail(`${key} nth=${item.nth} invalid (hits=${hits.length})`);
        return;
      }
      lineIndex = hits[item.nth - 1];
    } else {
      if (hits.length !== 1) {
        fail(`${key} anchor not unique (hits=${hits.length})`);
        return;
      }
      lineIndex = hits[0];
    }
    if (insertIndexes.has(lineIndex)) {
      fail(`${key} duplicate insertion index ${lineIndex}`);
      return;
    }
    insertIndexes.add(lineIndex);

    const inserted =
      item.raw !== undefined
        ? item.raw.map((l) => l)
        : item.lines.map((l) => {
            const indent = sourceLines[lineIndex].match(/^\s*/)[0];
            return l === "" ? `${indent}//` : `${indent}// ${l}`;
          });

    if (item.raw !== undefined && item.lines !== undefined) {
      fail(`${key} both raw and lines present`);
    }
    if (inserted.length < 1) {
      fail(`${key} inserts nothing`);
    }

    for (const line of inserted) {
      const t = line.trim();
      if (!t.startsWith("//")) fail(`${key} line not comment: ${JSON.stringify(line)}`);
      if (t.includes("*/")) fail(`${key} line contains */: ${JSON.stringify(line)}`);
      const text = t.replace(/^\/\/\s?/, "");
      if (FORBIDDEN.test(text)) fail(`${key} forbidden leading word: ${JSON.stringify(line)}`);
      if (t.endsWith(";")) fail(`${key} line ends with semicolon: ${JSON.stringify(line)}`);
      if (text.includes("=>")) fail(`${key} line contains arrow: ${JSON.stringify(line)}`);
      if (CALL_EXPR.test(text)) fail(`${key} line looks like a call: ${JSON.stringify(line)}`);
    }

    totalLines += inserted.length;
  });

  // header contract
  const header = entry.items[0];
  if (!header || !Array.isArray(header.raw)) {
    fail(`[${entry.file}] first item must use raw`);
  } else {
    if (header.raw.length !== 22) fail(`header raw length=${header.raw.length}, expected 22`);
    if (!header.raw[0].startsWith("// INV-01")) fail(`header first line: ${header.raw[0]}`);
    if (header.raw[18] !== "//") fail(`header 19th line: ${JSON.stringify(header.raw[18])}`);
    for (let k = 0; k < 18; k += 1) {
      const expected = `// INV-${String(k + 1).padStart(2, "0")} `;
      if (!header.raw[k].startsWith(expected)) fail(`header INV-${k + 1} mismatch: ${header.raw[k]}`);
      if (!header.raw[k].includes("守住位置") || !header.raw[k].includes("改错故障")) {
        fail(`header INV-${k + 1} missing 守住位置/改错故障`);
      }
    }
    for (let k = 19; k < 22; k += 1) {
      const prefixes = ["// 模块职责：", "// 状态所有权：", "// 阅读顺序："];
      if (!header.raw[k].startsWith(prefixes[k - 19])) {
        fail(`header line ${k + 1} must start with ${prefixes[k - 19]}`);
      }
    }
  }
}

if (totalLines !== 60) fail(`total inserted lines=${totalLines}, expected 60`);

if (failures.length > 0) {
  for (const f of failures) process.stdout.write(`FAIL ${f}\n`);
  process.stdout.write(`FAILED ${failures.length}\n`);
  process.exit(1);
}

process.stdout.write(`OK blocks=${totalItems} lines=${totalLines}\n`);
