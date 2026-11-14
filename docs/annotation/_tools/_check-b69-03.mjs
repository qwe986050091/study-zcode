import fs from "node:fs";

const SPEC = "d:\\code\\_annot_baseline\\ZC-deep-b69-spec-03.json";
const ROOT = "d:\\code\\ZCode\\";
const EXPECTED_LINES = 63;
const FORBIDDEN_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
const errors = [];
let totalLines = 0;
let blockCount = 0;
let headerChecked = false;

for (const entry of spec.files) {
  const filePath = ROOT + entry.file.split("/").join("\\");
  const fileLines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const trimmed = fileLines.map((l) => l.trim());
  const usedInsertIndexes = new Map();

  for (const item of entry.items) {
    blockCount += 1;
    const anchor = item.anchor;
    const matches = [];
    trimmed.forEach((line, i) => {
      if (line === anchor.trim()) matches.push(i);
    });
    if (matches.length === 0) {
      errors.push(`anchor 未命中: ${anchor}`);
      continue;
    }
    let idx;
    if (item.nth) {
      if (item.nth < 1 || item.nth > matches.length) {
        errors.push(`nth 越界: ${anchor} nth=${item.nth} 命中=${matches.length}`);
        continue;
      }
      idx = matches[item.nth - 1];
    } else {
      if (matches.length !== 1) {
        errors.push(`anchor 不唯一: ${anchor} 命中=${matches.length} 行=${matches.map((n) => n + 1).join(",")}`);
        continue;
      }
      idx = matches[0];
    }
    if (usedInsertIndexes.has(idx)) {
      errors.push(`重复插入下标 ${idx + 1}: ${anchor}`);
    }
    usedInsertIndexes.set(idx, anchor);

    const isRaw = Array.isArray(item.raw);
    const emitted = isRaw
      ? item.raw.slice()
      : item.lines.map((l) => (l === "" ? "//" : `// ${l}`));

    if (isRaw) {
      if (!headerChecked) {
        headerChecked = true;
        if (emitted.length !== 22) errors.push(`文件头 raw 长度=${emitted.length}，应为 22`);
        if (!emitted[0].startsWith("// INV-01")) errors.push("文件头首行未以 // INV-01 开头");
        if (emitted[18] !== "//") errors.push(`文件头第 19 行="${emitted[18]}"，应为 //`);
        const invSeq = emitted.slice(0, 18).map((l, i) => {
          const want = `// INV-${String(i + 1).padStart(2, "0")}`;
          return l.startsWith(want) ? null : `INV 序号错: 行 ${i + 1}="${l.slice(0, 12)}" 期望 ${want}`;
        }).filter(Boolean);
        errors.push(...invSeq);
      } else {
        errors.push("出现多个 raw 文件头");
      }
    } else {
      if (emitted.length < 3 || emitted.length > 6) {
        errors.push(`块长度越界 ${emitted.length}: ${anchor}`);
      }
    }

    for (const line of emitted) {
      totalLines += 1;
      const t = line.trim();
      if (!t.startsWith("//")) errors.push(`插入行未以 // 开头: ${line}`);
      if (t.includes("*/")) errors.push(`插入行含 */: ${line}`);
      const body = t.replace(/^\/\/+/, "").trim();
      if (body.length > 0) {
        const first = body.split(/[\s：:，,。]/)[0];
        if (FORBIDDEN_START.includes(first)) errors.push(`禁止起始词 ${first}: ${line}`);
        if (/[;；]\s*$/.test(t) && t.endsWith(";")) errors.push(`以分号结尾: ${line}`);
        if (t.endsWith(";")) errors.push(`以分号结尾: ${line}`);
      }
      if (t.includes("=>")) errors.push(`含箭头: ${line}`);
      if (/[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(t)) {
        errors.push(`含调用表达式: ${line}`);
      }
    }
  }
}

if (headerChecked !== true) errors.push("缺少 raw 文件头块");
if (totalLines !== EXPECTED_LINES) {
  errors.push(`插入总行数=${totalLines}，应精确等于 ${EXPECTED_LINES}`);
}

if (errors.length > 0) {
  console.error("FAIL");
  for (const e of errors) console.error(" - " + e);
  process.exit(1);
}
console.log(`OK blocks=${blockCount} lines=${totalLines}`);
