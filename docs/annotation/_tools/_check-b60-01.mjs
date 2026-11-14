import fs from "node:fs";
import path from "node:path";

const REPO = "d:/code/ZCode";
const SPEC = "d:/code/_annot_baseline/ZC-deep-b60-spec-01.json";

const FORBIDDEN_START =
  /^(const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch|await|async|throw|new|interface|type|enum)\b/;

const spec = JSON.parse(fs.readFileSync(SPEC, "utf8"));
const errors = [];
let grandTotal = 0;
let itemCount = 0;

if (!Array.isArray(spec.files) || spec.files.length === 0) errors.push("spec.files 为空");

for (const entry of spec.files) {
  const abs = path.join(REPO, entry.file);
  if (!fs.existsSync(abs)) {
    errors.push(`文件不存在: ${entry.file}`);
    continue;
  }
  const raw = fs.readFileSync(abs, "utf8");
  const srcLines = raw.split(/\r?\n/).map((l) => l.trim());
  const counts = new Map();
  for (const l of srcLines) counts.set(l, (counts.get(l) ?? 0) + 1);

  let total = 0;
  entry.items.forEach((item, idx) => {
    itemCount += 1;
    const isRaw = Array.isArray(item.raw);
    const body = isRaw ? item.raw : item.lines;
    if (!Array.isArray(body) || body.length === 0) {
      errors.push(`#${idx + 1} 缺少 lines/raw`);
      return;
    }
    total += body.length;

    if (isRaw && idx !== 0) errors.push(`#${idx + 1} raw 只允许用于文件头`);
    if (isRaw && item.nth != null) errors.push(`#${idx + 1} raw 不应带 nth`);
    if (!isRaw && idx === 0) errors.push("首个 item 必须是 raw 文件头");

    const anchor = item.anchor;
    if (typeof anchor !== "string" || anchor.trim() !== anchor) {
      errors.push(`#${idx + 1} anchor 必须是 trim 后的原文`);
    }
    const occ = counts.get(anchor) ?? 0;
    if (occ === 0) {
      errors.push(`#${idx + 1} anchor 未匹配: ${JSON.stringify(anchor)}`);
    } else if (item.nth != null) {
      if (!Number.isInteger(item.nth) || item.nth < 1) errors.push(`#${idx + 1} nth 非法`);
      if (occ < item.nth) errors.push(`#${idx + 1} nth=${item.nth} 超出出现次数 ${occ}`);
    } else if (occ > 1) {
      errors.push(`#${idx + 1} anchor 出现 ${occ} 次但未给 nth: ${JSON.stringify(anchor)}`);
    }

    body.forEach((line, li) => {
      if (typeof line !== "string") {
        errors.push(`#${idx + 1}.${li + 1} 不是字符串`);
        return;
      }
      if (line.includes("*/")) errors.push(`#${idx + 1}.${li + 1} 含 */`);
      if (line.includes(";")) errors.push(`#${idx + 1}.${li + 1} 含 ASCII 分号`);
      if (line.includes("=>")) errors.push(`#${idx + 1}.${li + 1} 含 =>`);
      if (/\w+\.\w+\s*\(/.test(line)) errors.push(`#${idx + 1}.${li + 1} 疑似 标识符.标识符( 形态`);
      if (isRaw) {
        if (line !== "" && !line.startsWith("//")) {
          errors.push(`#${idx + 1}.${li + 1} raw 行必须是 // 注释: ${JSON.stringify(line)}`);
          return;
        }
      } else if (line.startsWith("//")) {
        errors.push(`#${idx + 1}.${li + 1} 普通 item 行不应自带 //: ${JSON.stringify(line)}`);
        return;
      }
      const text = line.startsWith("//") ? line.slice(2) : line;
      if (text.trim() !== "" && FORBIDDEN_START.test(text.trim())) {
        errors.push(`#${idx + 1}.${li + 1} 以禁用词开头: ${JSON.stringify(text.trim())}`);
      }
    });
  });
  grandTotal += total;
  console.log(`文件 ${entry.file}: items=${entry.items.length}, 行数=${total}`);
}

if (grandTotal < 74 || grandTotal > 76) errors.push(`总行数 ${grandTotal} 不在 74~76`);

// INV 数量检查
const head = spec.files[0].items[0].raw ?? [];
const invCount = head.filter((l) => /^\/\/ INV-\d\d /.test(l)).length;
if (invCount < 18 || invCount > 20) errors.push(`INV 条数 ${invCount} 不在 18~20`);
if (head[head.length - 1] !== undefined && head[head.length - 1].trim() === "") errors.push("文件头末行为空");

console.log(`items 总数=${itemCount}, 总行数=${grandTotal}, INV=${invCount}`);
if (errors.length) {
  console.log("校验失败:");
  for (const e of errors) console.log(" - " + e);
  process.exit(1);
}
console.log("校验通过");
