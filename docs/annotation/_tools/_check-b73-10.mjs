import { readFileSync } from "node:fs";

const SPEC = "d:/code/_annot_baseline/ZC-deep-b73-spec-10.json";
const TARGET = "d:/code/ZCode/packages/desktop/src/main/pluginSandbox/protocol.ts";

const spec = JSON.parse(readFileSync(SPEC, "utf8"));
const src = readFileSync(TARGET, "utf8");
const fileLines = src.split(/\r?\n/);

const forbidden = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

const errors = [];
const usedIndexes = new Map();
let totalInserted = 0;
let blockCount = 0;

const entry = spec.files[0];
if (entry.file !== "packages/desktop/src/main/pluginSandbox/protocol.ts") {
  errors.push("spec file path mismatch");
}

entry.items.forEach((item, itemIdx) => {
  blockCount += 1;
  const anchorTrim = String(item.anchor).trim();
  if (!anchorTrim) errors.push(`item ${itemIdx}: empty anchor`);

  const hits = [];
  fileLines.forEach((line, i) => {
    if (line.trim() === anchorTrim) hits.push(i);
  });
  if (hits.length === 0) {
    errors.push(`item ${itemIdx}: anchor not found -> ${anchorTrim}`);
    return;
  }
  let target = hits[0];
  if (typeof item.nth === "number") {
    if (item.nth < 1 || item.nth > hits.length) {
      errors.push(`item ${itemIdx}: nth ${item.nth} out of range (${hits.length})`);
      return;
    }
    target = hits[item.nth - 1];
  } else if (hits.length > 1) {
    errors.push(`item ${itemIdx}: anchor not unique (${hits.length} hits) -> ${anchorTrim}`);
    return;
  }

  const isRaw = Array.isArray(item.raw);
  const inserted = isRaw ? item.raw : item.lines;
  if (!Array.isArray(inserted)) {
    errors.push(`item ${itemIdx}: missing raw/lines`);
    return;
  }
  if (!isRaw && (inserted.length < 3 || inserted.length > 6)) {
    errors.push(`item ${itemIdx}: lines block size ${inserted.length} out of 3..6`);
  }
  totalInserted += inserted.length;
  if (usedIndexes.has(target)) {
    errors.push(`item ${itemIdx}: duplicate insert index ${target}`);
  } else {
    usedIndexes.set(target, itemIdx);
  }

  inserted.forEach((rawLine, k) => {
    const text = typeof rawLine === "string" ? rawLine : "";
    if (isRaw) {
      const t = text.trim();
      if (!t.startsWith("//")) errors.push(`item ${itemIdx} raw[${k}]: not a // line`);
      if (t.includes("*/")) errors.push(`item ${itemIdx} raw[${k}]: contains */`);
      checkBody(itemIdx, `raw[${k}]`, t, errors);
    } else {
      const t = ("// " + text).trim();
      if (!t.startsWith("//")) errors.push(`item ${itemIdx} lines[${k}]: not a // line`);
      if (t.includes("*/")) errors.push(`item ${itemIdx} lines[${k}]: contains */`);
      checkBody(itemIdx, `lines[${k}]`, t, errors);
    }
  });
});

function checkBody(itemIdx, where, line, errs) {
  if (line.includes("=>")) errs.push(`item ${itemIdx} ${where}: contains =>`);
  if (line.endsWith(";")) errs.push(`item ${itemIdx} ${where}: ends with ;`);
  const body = line.replace(/^\/\/+/, "").trim();
  if (body) {
    const first = body.split(/[\s:：,，.。]/)[0];
    if (forbidden.includes(first)) {
      errs.push(`item ${itemIdx} ${where}: starts with forbidden word ${first}`);
    }
  }
  if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(line)) {
    errs.push(`item ${itemIdx} ${where}: call expression lookalike`);
  }
}

const head = entry.items[0];
if (!Array.isArray(head.raw) || head.raw.length !== 22) {
  errors.push(`head raw length ${head.raw ? head.raw.length : "n/a"} !== 22`);
} else {
  if (!head.raw[0].trim().startsWith("// INV-01")) errors.push("head raw[0] not // INV-01");
  if (head.raw[18].trim() !== "//") errors.push("head raw[18] not //");
  for (let i = 0; i < 18; i += 1) {
    const expect = `// INV-${String(i + 1).padStart(2, "0")}`;
    if (!head.raw[i].trim().startsWith(expect)) {
      errors.push(`head raw[${i}] not starting with ${expect}`);
    }
  }
  if (!head.raw[19].trim().startsWith("// 模块职责")) errors.push("head raw[19] not 模块职责");
  if (!head.raw[20].trim().startsWith("// 状态所有权")) errors.push("head raw[20] not 状态所有权");
  if (!head.raw[21].trim().startsWith("// 阅读顺序")) errors.push("head raw[21] not 阅读顺序");
}

if (totalInserted !== 61) errors.push(`total inserted ${totalInserted} !== 61`);

if (errors.length) {
  console.error("FAIL");
  errors.forEach((e) => console.error(" - " + e));
  process.exit(1);
}
console.log(`OK blocks=${blockCount} lines=${totalInserted}`);
