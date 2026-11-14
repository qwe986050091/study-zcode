import { readFileSync } from "node:fs";

const specPath = "d:\\code\\_annot_baseline\\ZC-deep-b72-spec-08.json";
const targetPath = "d:\\code\\ZCode\\packages\\client\\src\\webRemoteControlRelayProtocol.ts";

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const source = readFileSync(targetPath, "utf8");
const srcLines = source.split(/\r?\n/);

const forbidden = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const callRe = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

const errors = [];
const usedIndices = new Set();
const insertions = [];
let totalLines = 0;
let blockCount = 0;
let headerRaw = null;

for (const file of spec.files) {
  if (file.file !== "packages/client/src/webRemoteControlRelayProtocol.ts") {
    errors.push(`unexpected file entry: ${file.file}`);
  }
  for (const item of file.items) {
    blockCount += 1;
    const anchorTrim = String(item.anchor).trim();
    const hits = [];
    for (let i = 0; i < srcLines.length; i += 1) {
      if (srcLines[i].trim() === anchorTrim) hits.push(i);
    }
    let index;
    if (item.nth !== undefined) {
      if (hits.length < item.nth) {
        errors.push(`anchor nth out of range: ${anchorTrim}`);
        continue;
      }
      index = hits[item.nth - 1];
    } else {
      if (hits.length === 0) {
        errors.push(`anchor not found: ${anchorTrim}`);
        continue;
      }
      if (hits.length !== 1) {
        errors.push(`anchor not unique (${hits.length}): ${anchorTrim}`);
        continue;
      }
      index = hits[0];
    }
    if (usedIndices.has(index)) {
      errors.push(`duplicate insertion index ${index}: ${anchorTrim}`);
      continue;
    }
    usedIndices.add(index);

    const indent = (srcLines[index].match(/^\s*/) ?? [""])[0];
    let rendered;
    if (Object.prototype.hasOwnProperty.call(item, "raw")) {
      if (headerRaw !== null) errors.push("multiple raw items");
      headerRaw = item.raw;
      if (item.lines !== undefined) errors.push("item has both raw and lines");
      rendered = item.raw.slice();
    } else {
      rendered = item.lines.map((line) =>
        line === "" ? `${indent}//` : `${indent}// ${line}`,
      );
    }
    totalLines += rendered.length;
    insertions.push({ index, anchor: anchorTrim, rendered });
  }
}

for (const ins of insertions) {
  for (const line of ins.rendered) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("//")) {
      errors.push(`line not a comment: ${line}`);
      continue;
    }
    if (trimmed.includes("*/")) {
      errors.push(`line contains */: ${line}`);
    }
    const text = trimmed.slice(2).trim();
    if (text.length === 0) continue;
    const firstWord = text.split(/[\s，。：；、（）()]+/)[0];
    if (forbidden.includes(firstWord)) {
      errors.push(`forbidden leading word "${firstWord}": ${line}`);
    }
    if (text.endsWith(";")) {
      errors.push(`line text ends with ;: ${line}`);
    }
    if (text.includes("=>")) {
      errors.push(`line contains =>: ${line}`);
    }
    if (callRe.test(text)) {
      errors.push(`line looks like a call expression: ${line}`);
    }
  }
}

if (totalLines !== 60) errors.push(`total inserted lines ${totalLines} !== 60`);
if (headerRaw === null) {
  errors.push("missing header raw item");
} else {
  if (headerRaw.length !== 22) errors.push(`header raw length ${headerRaw.length} !== 22`);
  if (!String(headerRaw[0]).startsWith("// INV-01")) errors.push("header first line is not // INV-01");
  if (headerRaw[18] !== "//") errors.push(`header line 19 is not "//": ${JSON.stringify(headerRaw[18])}`);
  const invs = headerRaw.slice(0, 18);
  invs.forEach((line, i) => {
    const expected = `// INV-${String(i + 1).padStart(2, "0")} `;
    if (!line.startsWith(expected)) errors.push(`header INV order broken at ${i + 1}: ${line}`);
    if (!line.includes("守住位置") || !line.includes("改错故障")) {
      errors.push(`header INV missing 守住位置/改错故障: ${line}`);
    }
  });
  const tail = headerRaw.slice(19);
  if (tail.length !== 3) errors.push(`header tail length ${tail.length} !== 3`);
  ["// 模块职责：", "// 状态所有权：", "// 阅读顺序："].forEach((prefix, i) => {
    if (!String(tail[i]).startsWith(prefix)) errors.push(`header tail line ${i + 1} bad: ${tail[i]}`);
  });
}

for (const ins of insertions) {
  const sizes = ins.rendered.length;
  const isHeader = sizes === 22 && String(ins.rendered[0]).startsWith("// INV-01");
  if (!isHeader && (sizes < 3 || sizes > 6)) {
    errors.push(`block size ${sizes} out of 3..6 at anchor: ${ins.anchor}`);
  }
}

if (errors.length > 0) {
  console.error("FAIL");
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}

console.log(`OK blocks=${blockCount} lines=${totalLines}`);
