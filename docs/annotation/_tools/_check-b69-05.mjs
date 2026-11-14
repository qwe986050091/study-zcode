import fs from "node:fs";

const SPEC_PATH = "d:\\code\\_annot_baseline\\ZC-deep-b69-spec-05.json";
const ROOT = "d:\\code\\ZCode";
const EXPECTED_TOTAL = 63;

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
const failures = [];
const fail = (msg) => failures.push(msg);

const FORBIDDEN_STARTS = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];
const CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

let totalLines = 0;
let blockCount = 0;
let headerChecked = false;

if (!Array.isArray(spec.files) || spec.files.length !== 1) {
  fail(`spec.files 必须恰好 1 个，实际 ${Array.isArray(spec.files) ? spec.files.length : "非数组"}`);
}

for (const entry of spec.files ?? []) {
  const absPath = `${ROOT}\\${entry.file.replace(/\//g, "\\")}`;
  if (!fs.existsSync(absPath)) {
    fail(`目标文件不存在：${absPath}`);
    continue;
  }
  const rawText = fs.readFileSync(absPath, "utf8");
  const fileLines = rawText.split(/\r?\n/);
  const trimmed = fileLines.map((l) => l.trim());

  const usedIndices = new Map();
  let fileTotal = 0;

  entry.items.forEach((item, itemIdx) => {
    blockCount += 1;
    const anchorTrim = String(item.anchor ?? "").trim();
    if (!anchorTrim) {
      fail(`item#${itemIdx} anchor 为空`);
      return;
    }
    const hits = [];
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === anchorTrim) hits.push(i);
    }
    if (hits.length === 0) {
      fail(`item#${itemIdx} anchor 未命中：${JSON.stringify(item.anchor)}`);
      return;
    }
    let target;
    if (typeof item.nth === "number") {
      if (item.nth < 1 || item.nth > hits.length) {
        fail(`item#${itemIdx} nth=${item.nth} 超出命中数 ${hits.length}`);
        return;
      }
      target = hits[item.nth - 1];
    } else {
      if (hits.length !== 1) {
        fail(`item#${itemIdx} anchor 命中 ${hits.length} 次不唯一：${JSON.stringify(item.anchor)}`);
        return;
      }
      target = hits[0];
    }
    if (usedIndices.has(target)) {
      fail(`重复插入下标 ${target}（item#${usedIndices.get(target)} 与 item#${itemIdx}）`);
    } else {
      usedIndices.set(target, itemIdx);
    }

    const hasRaw = Array.isArray(item.raw);
    const hasLines = Array.isArray(item.lines);
    if (hasRaw === hasLines) {
      fail(`item#${itemIdx} 必须且只能用 raw 或 lines 之一`);
      return;
    }
    const out = hasRaw ? item.raw.slice() : item.lines.map((t) => (t === "" ? "//" : `// ${t}`));
    if (!hasRaw) {
      if (out.length < 3 || out.length > 6) {
        fail(`item#${itemIdx} lines 块长度 ${out.length} 不在 3~6`);
      }
    }
    fileTotal += out.length;

    out.forEach((line, li) => {
      const t = String(line).trim();
      const where = `item#${itemIdx} line#${li}`;
      if (!t.startsWith("//")) fail(`${where} 未以 // 开头：${JSON.stringify(line)}`);
      if (t.includes("*/")) fail(`${where} 含 */：${JSON.stringify(line)}`);
      const body = t.startsWith("//") ? t.slice(2).trim() : t;
      const first = body.split(/\s+/)[0] ?? "";
      if (FORBIDDEN_STARTS.includes(first)) fail(`${where} 注释正文以禁止词开头（${first}）`);
      if (t.endsWith(";")) fail(`${where} 以分号结尾`);
      if (t.includes("=>")) fail(`${where} 含箭头 =>`);
      if (CALL_RE.test(t)) fail(`${where} 疑似调用表达式：${JSON.stringify(t)}`);
    });

    if (itemIdx === 0) {
      headerChecked = true;
      const raw = item.raw;
      if (!Array.isArray(raw)) {
        fail("文件头必须使用 raw");
      } else {
        if (raw.length !== 22) fail(`文件头 raw 长度应为 22，实际 ${raw.length}`);
        if (!String(raw[0]).startsWith("// INV-01")) fail(`文件头首行应为 // INV-01，实际 ${JSON.stringify(raw[0])}`);
        if (raw[18] !== "//") fail(`文件头第 19 行应为 "//"，实际 ${JSON.stringify(raw[18])}`);
        for (let k = 0; k < 18; k++) {
          const expect = `// INV-${String(k + 1).padStart(2, "0")}`;
          if (!String(raw[k]).startsWith(expect)) {
            fail(`文件头第 ${k + 1} 行应以 ${expect} 开头，实际 ${JSON.stringify(raw[k])}`);
          }
        }
        for (let k = 19; k < 22; k++) {
          if (!String(raw[k]).startsWith("// ")) fail(`文件头尾部第 ${k + 1} 行应以 "// " 开头`);
        }
        if (raw.length >= 22 && !raw.slice(19).some((l) => l.includes("模块职责："))) fail("文件头缺少「模块职责：」");
        if (raw.length >= 22 && !raw.slice(19).some((l) => l.includes("状态所有权："))) fail("文件头缺少「状态所有权：」");
        if (raw.length >= 22 && !raw.slice(19).some((l) => l.includes("阅读顺序："))) fail("文件头缺少「阅读顺序：」");
      }
    }
  });

  totalLines += fileTotal;
}

if (!headerChecked) fail("缺少文件头 item");

if (totalLines !== EXPECTED_TOTAL) {
  fail(`插入总行数应为 ${EXPECTED_TOTAL}，实际 ${totalLines}`);
}

if (failures.length > 0) {
  console.error("FAIL");
  for (const f of failures) console.error(` - ${f}`);
  console.error(`blocks=${blockCount} lines=${totalLines}`);
  process.exit(1);
}

console.log(`OK blocks=${blockCount} lines=${totalLines}`);
