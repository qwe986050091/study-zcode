import fs from "node:fs";

const specPath = "d:/code/_annot_baseline/ZC-deep-b60-spec-11.json";
const srcPath = "d:/code/ZCode/packages/ui/src/plugin-ui/components/PluginUiLauncherItems.tsx";

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const srcLines = fs.readFileSync(srcPath, "utf8").split(/\r?\n/);

const file = spec.files[0];
const items = file.items;

let total = 0;
const errors = [];
const BANNED_START = [
  "const", "let", "var", "function", "class", "import", "export",
  "return", "if", "else", "for", "while", "switch", "try", "catch",
  "await", "async", "throw", "new", "interface", "type", "enum",
];
const CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

function checkCommentLine(text, itemIdx, lineIdx) {
  // text 为去掉前导 "//" 与一个空格后的内容
  const body = text.replace(/^\/\/\s?/, "").trim();
  if (body === "") return;
  for (const w of BANNED_START) {
    if (body === w || body.startsWith(w + " ") || body.startsWith(w + "(") || body.startsWith(w + "{")) {
      errors.push(`[禁词] item#${itemIdx} line#${lineIdx} 以 ${w} 开头: ${body}`);
    }
  }
  if (body.endsWith(";")) errors.push(`[分号] item#${itemIdx} line#${lineIdx}: ${body}`);
  if (body.includes("=>")) errors.push(`[箭头] item#${itemIdx} line#${lineIdx}: ${body}`);
  if (body.includes("*/")) errors.push(`[块注释闭合] item#${itemIdx} line#${lineIdx}: ${body}`);
  if (CALL_RE.test(body)) errors.push(`[调用形态] item#${itemIdx} line#${lineIdx}: ${body}`);
}

items.forEach((item, itemIdx) => {
  const anchor = item.anchor;
  const trimmed = anchor.trim();
  const hits = [];
  srcLines.forEach((l, i) => {
    if (l.trim() === trimmed) hits.push(i + 1);
  });
  const nth = item.nth ?? 1;
  if (hits.length === 0) errors.push(`[anchor 缺失] item#${itemIdx}: ${trimmed}`);
  if (item.nth === undefined && hits.length > 1) {
    errors.push(`[anchor 不唯一] item#${itemIdx} 命中 ${hits.length} 次但未给 nth: ${trimmed}`);
  }
  if (item.nth !== undefined && (nth < 1 || nth > hits.length)) {
    errors.push(`[nth 越界] item#${itemIdx} nth=${nth} 命中=${hits.length}: ${trimmed}`);
  }

  const lines = item.raw ? item.raw : item.lines;
  if (!Array.isArray(lines)) errors.push(`[结构] item#${itemIdx} 缺少 lines/raw`);
  total += lines.length;
  lines.forEach((l, i) => checkCommentLine(l, itemIdx, i));
});

const invCount = items[0].raw.filter((l) => /^\/\/\s*INV-\d{2}\s/.test(l)).length;
const rawCheck = items[0].raw.some((l) => !l.startsWith("//"));

console.log(`files: ${spec.files.length}`);
console.log(`file: ${file.file}`);
console.log(`items: ${items.length}`);
console.log(`total lines: ${total}`);
console.log(`INV count: ${invCount}`);
console.log(`raw 行全部以 // 开头: ${!rawCheck}`);
console.log(`anchor 全部匹配: ${!errors.some((e) => e.includes("anchor") || e.includes("nth"))}`);
console.log(`禁词/分号/箭头/块注释/调用形态问题数: ${errors.filter((e) => /\[\S+\]/.exec(e) && !e.includes("anchor") && !e.includes("nth")).length}`);
console.log(errors.length === 0 ? "SELF-CHECK PASS" : "SELF-CHECK FAIL");
errors.forEach((e) => console.log(" - " + e));

const ok =
  items.length >= 1 &&
  total === 70 &&
  invCount >= 18 &&
  invCount <= 20 &&
  errors.length === 0;
process.exit(ok ? 0 : 1);
