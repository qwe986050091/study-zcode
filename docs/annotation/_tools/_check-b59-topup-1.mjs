import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/code/ZCode";
const specPath = "D:/code/_annot_baseline/ZC-deep-b59-topup-1.json";
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

const expected = {
  "packages/ui/src/store/hooksStore.ts": 4,
  "packages/desktop/src/main/about.ts": 3,
  "packages/ui/src/hooks/useClaudeSessionMigration.ts": 3,
  "packages/ui/src/ToolCallBlocks/renderers/read.tsx": 3,
};

const FORBIDDEN_START = [
  "const", "let", "var", "function", "class", "import", "export", "return",
  "if", "else", "for", "while", "switch", "try", "catch", "await", "async",
  "throw", "new", "interface", "type", "enum",
];

let failed = false;
const fail = (msg) => {
  failed = true;
  console.log("[FAIL] " + msg);
};

for (const f of spec.files) {
  const abs = path.join(ROOT, f.file);
  if (!fs.existsSync(abs)) {
    fail(`${f.file}: 文件不存在`);
    continue;
  }
  const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
  let total = 0;
  const usedIdx = new Set();
  for (const item of f.items) {
    const anchor = String(item.anchor ?? "").trim();
    if (!anchor) fail(`${f.file}: 空 anchor`);
    if (anchor.startsWith("//")) fail(`${f.file}: anchor 是注释行: ${anchor}`);
    const hits = [];
    lines.forEach((l, i) => {
      if (l.trim() === anchor) hits.push(i);
    });
    const nth = item.nth || 1;
    if (!item.nth && hits.length !== 1) {
      fail(`${f.file}: anchor 命中 ${hits.length} 次: ${anchor}`);
      continue;
    }
    if (hits.length < nth) {
      fail(`${f.file}: anchor 命中不足 nth=${nth}: ${anchor}`);
      continue;
    }
    const idx = hits[nth - 1];
    if (usedIdx.has(idx)) fail(`${f.file}: 同一 anchor 行重复插入: ${anchor}`);
    usedIdx.add(idx);
    const prev = lines[idx - 1]?.trim() ?? "";
    if (prev.startsWith("//")) {
      console.log(`[warn] ${f.file}: anchor 上方已是注释（可能重复覆盖）: ${anchor}`);
    }
    for (const t of item.lines) {
      total += 1;
      if (t === "") continue;
      if (t.includes("*/")) fail(`${f.file}: 注释含 */: ${t}`);
      if (t.includes("=>")) fail(`${f.file}: 注释含 =>: ${t}`);
      if (t.trimEnd().endsWith(";")) fail(`${f.file}: 注释以 ; 结尾: ${t}`);
      const first = FORBIDDEN_START.find((w) => new RegExp(`^${w}\\b`).test(t.trim()));
      if (first) fail(`${f.file}: 注释以禁词 ${first} 开头: ${t}`);
      if (/^[\w$]+\.[\w$]+\(/.test(t.trim())) fail(`${f.file}: 注释呈调用形态: ${t}`);
      if (t.length > 120) console.log(`[warn] ${f.file}: 注释过长 ${t.length}: ${t.slice(0, 20)}...`);
    }
  }
  if (total !== expected[f.file]) {
    fail(`${f.file}: 行数 ${total}，期望 ${expected[f.file]}`);
  } else {
    console.log(`[ok] ${f.file}: ${total} 行，anchor ${f.items.length} 个`);
  }
}

console.log(failed ? "RESULT: FAILED" : "RESULT: ALL PASS");
process.exit(failed ? 1 : 0);
