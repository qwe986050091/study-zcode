import fs from "node:fs";

const rows = JSON.parse(
  fs.readFileSync("d:/code/_annot_baseline/b130-legacy-queue.json", "utf8").replace(/^\uFEFF/, ""),
);

const D = "packages/desktop/src/main/index.ts";
const E = "apps/zcode-cli/packages/core/src/tool/handlers/edit.ts";
const C = "packages/ui/src/lib/chatErrorBannerTelemetry.ts";
const T = "packages/ui/src/lib/taskNotificationOrchestrator.ts";
const M = "packages/ui/src/ModelTrajectoryExpandedContent.tsx";

// 合并类分组：poem run / 折行续句 / 与 JSDoc 重复
const mergeGroups = [
  { rel: C, from: 45, to: 49, kind: "P" },
  { rel: C, from: 75, to: 79, kind: "P" },
  { rel: C, from: 133, to: 137, kind: "P" },
  { rel: C, from: 174, to: 178, kind: "P" },
  { rel: T, from: 35, to: 39, kind: "P" },
  { rel: T, from: 56, to: 60, kind: "P" },
  { rel: T, from: 101, to: 105, kind: "P" },
  { rel: T, from: 212, to: 216, kind: "P" },
  { rel: M, from: 43, to: 47, kind: "P" },
  { rel: M, from: 83, to: 87, kind: "P" },
  { rel: D, from: 2, to: 3, kind: "F", span: "2–3" },
  { rel: D, from: 424, to: 424, kind: "F", span: "423–425" },
  { rel: D, from: 484, to: 484, kind: "F", span: "484–485" },
  { rel: D, from: 569, to: 569, kind: "F", span: "568–569" },
  { rel: D, from: 713, to: 713, kind: "F", span: "713–714" },
  { rel: D, from: 729, to: 729, kind: "F", span: "728–729" },
  { rel: D, from: 817, to: 817, kind: "F", span: "817–818" },
  { rel: D, from: 861, to: 861, kind: "F", span: "859–861" },
  { rel: D, from: 897, to: 897, kind: "F", span: "896–897" },
  { rel: D, from: 1396, to: 1396, kind: "F", span: "1395–1396" },
  { rel: E, from: 593, to: 593, kind: "F", span: "593–594" },
  { rel: E, from: 965, to: 965, kind: "D", span: "960–965" },
  { rel: M, from: 39, to: 39, kind: "F", span: "38–39" },
];

const keepLines = new Set([`${M}:20`, `${T}:21`, `${C}:21`, `${D}:1`]);
const anchorLines = new Set([`${E}:30`, `${D}:2063`]);

const order = [D, E, C, T, M];
const sorted = rows
  .filter((r) => order.includes(r.rel))
  .sort((a, b) => order.indexOf(a.rel) - order.indexOf(b.rel) || a.line - b.line);

const mergeKeys = new Set();
for (const g of mergeGroups) for (let n = g.from; n <= g.to; n += 1) mergeKeys.add(`${g.rel}:${n}`);

const verdictOf = (r) => {
  const k = `${r.rel}:${r.line}`;
  if (mergeKeys.has(k)) return "合并";
  if (keepLines.has(k)) return "保留-规范条款";
  if (anchorLines.has(k)) return "补锚点";
  return "保留-已充分";
};

const counts = { 合并: 0, 补锚点: 0, "保留-已充分": 0, "保留-规范条款": 0 };
for (const r of sorted) counts[verdictOf(r)] += 1;

const fileTitle = {
  [D]: "packages/desktop/src/main/index.ts",
  [E]: "apps/zcode-cli/packages/core/src/tool/handlers/edit.ts",
  [C]: "packages/ui/src/lib/chatErrorBannerTelemetry.ts",
  [T]: "packages/ui/src/lib/taskNotificationOrchestrator.ts",
  [M]: "packages/ui/src/ModelTrajectoryExpandedContent.tsx",
};

// 审查批（沿用 LC 编号），需改写行数按判定统计
const batches = [
  { id: "LC-1", rels: [D], from: 1, to: 1351, pick: (r) => r.rel === D && r.line <= 1351, line: "desktop 补深批完成后的同一条写入线", status: "等 DP-desktop" },
  { id: "LC-2", rels: [D], from: 1396, to: 2936, pick: (r) => r.rel === D && r.line > 1351, line: "desktop（接 LC-1）", status: "等 LC-1" },
  { id: "LC-3", rels: [E], from: 30, to: 608, pick: (r) => r.rel === E && r.line <= 608, line: "edit.ts（B130 已补深）", status: "已完成" },
  { id: "LC-4", rels: [E, C], from: 621, to: 79, pick: (r) => (r.rel === E && r.line > 608) || (r.rel === C && r.line <= 79), line: "edit.ts → chatErrorBanner", status: "可开工" },
  { id: "LC-5", rels: [C, T], from: 133, to: 60, pick: (r) => (r.rel === C && r.line > 79) || (r.rel === T && r.line <= 60), line: "chatErrorBanner → taskNotification", status: "等 LC-4" },
  { id: "LC-6", rels: [T, M], from: 101, to: 87, pick: (r) => (r.rel === T && r.line > 60) || r.rel === M, line: "taskNotification → ModelTrajectory", status: "等 LC-5" },
];

const typeName = { P: "poem 堆叠", F: "折行续句", D: "重复 JSDoc", R: "单行 W/L", K: "规范条款" };

let md = "";
md += "# ZC legacy-cleanup 队列（B130 遗留 109 处 / 142 行）\n\n";
md += "> 来源：`zc-gate.mjs --scan ZC-fix-b130\\_files.txt`（留档 `_annot_baseline/b130-gate-raw.txt`）。\n";
md += "> 归属判定：逐行与 `git show HEAD:<rel>` 比对，HEAD 中不存在该行文本即 OWN，存在即 UPSTREAM（禁止改）。\n";
md += "> 结论：**142 行全部 OWN，UPSTREAM = 0**。\n\n";

md += "## 1. 账目对齐\n\n";
md += "| 项 | 数量 |\n| --- | ---: |\n";
md += "| gate 命中记录 | 109（W/L 99 条 + POEM 10 组） |\n";
md += "| W/L 去重后唯一行 | 92（7 处同一行被 W、L 各记一次） |\n";
md += "| POEM 展开行 | 50（10 组 × 5 行） |\n";
md += "| **队列总行数** | **142** |\n";
md += "| OWN / UPSTREAM | 142 / 0 |\n\n";

md += "## 2. 逐行判定\n\n";
md += "判据按「这行有没有让读者少犯一次错」，不看有没有“因为/因此”这类谓词。\n";
md += "拿不准时选「保留-已充分」——漏判的代价是一行没改，误判的代价是把完整句子改坏。\n\n";
md += "| 判定 | 行数 |\n| --- | ---: |\n";
md += `| 合并（poem / 折行 / 重复 JSDoc） | ${counts["合并"]} |\n`;
md += `| 补锚点 | ${counts["补锚点"]} |\n`;
md += `| 保留-已充分 | ${counts["保留-已充分"]} |\n`;
md += `| 保留-规范条款 | ${counts["保留-规范条款"]} |\n`;
md += `| **合计** | **${sorted.length}** |\n\n`;
md += "补锚点只有 2 行：`edit.ts:30`（职责列举无后果）与 `desktop/index.ts:2063`（三档高度纯列举）。\n";
md += "其余 72 行已带标识符或后果，按「已充分」只登记不改；4 行规范条款（模块职责/状态所有权/文件职责）确认原样保留。\n\n";

md += "| 文件 | 行数 | 合并 | 补锚点 | 保留-已充分 | 保留-规范条款 |\n| --- | ---: | ---: | ---: | ---: | ---: |\n";
for (const rel of order) {
  const list = sorted.filter((r) => r.rel === rel);
  const c = { 合并: 0, 补锚点: 0, "保留-已充分": 0, "保留-规范条款": 0 };
  for (const r of list) c[verdictOf(r)] += 1;
  md += `| \`${rel}\` | ${list.length} | ${c["合并"]} | ${c["补锚点"]} | ${c["保留-已充分"]} | ${c["保留-规范条款"]} |\n`;
}
md += `| **合计** | **${sorted.length}** | **${counts["合并"]}** | **${counts["补锚点"]}** | **${counts["保留-已充分"]}** | **${counts["保留-规范条款"]}** |\n\n`;

md += "## 3. 逐文件清单\n\n";
md += "> 每行都带判定词，后续复核判定本身即可。\n\n";

for (const rel of order) {
  const list = sorted.filter((r) => r.rel === rel);
  md += `### ${fileTitle[rel]}\n\n共 ${list.length} 行。\n\n`;
  md += "| 行号 | 判据 | 类型 | 判定 | 原句 |\n| --- | --- | --- | --- | --- |\n";
  const emitted = new Set();
  for (const r of list) {
    const key = `${r.rel}:${r.line}`;
    if (emitted.has(key)) continue;
    const g = mergeGroups.find((x) => x.rel === r.rel && (x.kind === "P" ? r.line >= x.from && r.line <= x.to : x.from === r.line));
    if (g && g.kind === "P") {
      const texts = [];
      for (let n = g.from; n <= g.to; n += 1) {
        const row = list.find((x) => x.line === n);
        if (row) {
          emitted.add(`${rel}:${n}`);
          texts.push(row.text.replace(/^\/\/\s*/, ""));
        }
      }
      md += `| ${g.from}–${g.to} | POEM | poem 堆叠 | 合并 | ${texts.join(" ｜ ")} |\n`;
      continue;
    }
    if (g && (g.kind === "F" || g.kind === "D")) {
      emitted.add(key);
      const extra = g.span !== String(r.line) ? `（合并 ${g.span}）` : "";
      md += `| ${r.line} | ${g.kind} | ${typeName[g.kind]}${extra} | 合并 | ${r.text.replace(/^\/\/\s*/, "")} |\n`;
      continue;
    }
    emitted.add(key);
    const v = verdictOf(r);
    const gg = mergeGroups.find((x) => x.rel === r.rel && r.line >= x.from && r.line <= x.to);
    const typeKey = v === "保留-规范条款" ? "K" : v === "合并" && gg ? gg.kind : "R";
    md += `| ${r.line} | ${r.type} | ${typeName[typeKey]} | ${v} | ${r.text.replace(/^\/\/\s*/, "")} |\n`;
  }
  md += "\n";
}

md += "## 4. 分批与写入线\n\n";
md += "硬规则：**同一文件同一时间只允许一条写入线**。desktop 先做关键文件补深（约 60 行），完成后再做 LC-1/LC-2，\n";
md += "避免父语句与块内子语句解释同一事实，导致 DUP 与密度虚高。`edit.ts` 的补深已在 B130 完成，LC-3 直接开工。\n\n";
md += "| 顺序 | 批次 | 文件 | 写入线 | 审查行 | 需改写 | 状态 |\n| ---: | --- | --- | --- | ---: | ---: | --- |\n";
md += `| 1 | DP-desktop | desktop/index.ts | desktop（补深，先行） | — | 约 60 行新增 | 待做 |\n`;
let seq = 2;
for (const b of batches) {
  const picked = sorted.filter(b.pick);
  const rewrite = picked.filter((r) => verdictOf(r) === "合并" || verdictOf(r) === "补锚点").length;
  md += `| ${seq} | ${b.id} | ${b.rels.map((x) => "`" + fileTitle[x].split("/").pop() + "`").join(" + ")} | ${b.line} | ${picked.length} | ${rewrite} | ${b.status} |\n`;
  seq += 1;
}
md += "\n";

md += "## 5. 改写规则与门禁\n\n";
md += "1. **改写不是删除**：先保留原信息，再合并成连贯段落；合并后仍要回答“守的是什么、写错会怎样”。\n";
md += "2. 与上游 JSDoc 重复的自建行合并进一行，不重复陈述 JSDoc 已有内容。\n";
md += "3. 补锚点只补真实标识符与后果，不新增第二行，不靠形容词凑长度。\n";
md += "4. 每批跑 `zc-verify.mjs --rewrite <batch>`：`codeTokenDiff=0`、`codeDeletion=0`、`upstreamCommentDeleted=0`、`literalCommentDeletion=0`、`nonCommentAdded=0`、`syntaxErrorFiles=0`。\n";
md += "5. 改写后重跑 `zc-gate --scan`，确认 `legacyHits` 下降且 `newHits=0`。\n";
md += "6. `Edit` 整段替换前确认 `old_string` 不含上游注释行（B129 误删过一次）。\n\n";

md += "## 6. 执行记录\n\n";
md += "### LC-3（edit.ts，2026-11-09）\n\n";
md += "| 位置 | 判定 | 改法 |\n| --- | --- | --- |\n";
md += "| 30 | 补锚点 | 补 `normalizeLineEndings` / `findEditMatch`，并写明“不刷新读缓存会让下一次 Edit 判 stale” |\n";
md += "| 593–594 | 合并 | 两行并为一段：滚动数组 + 不做阈值提前退出的理由与代价，补 `levenshteinDistance` |\n";
md += "| 964–965 | 合并 | 两行并一行：保留 `input.read?.lineEndings` 兜底事实与“不用正则/split”的内存理由，JSDoc 已有的平局规则不再复述 |\n\n";
md += "```\nSUMMARY files=1 rewrittenSegments=3 deletedOwnCommentLines=5 codeTokenDiff=0 headTokenDrift=0\n";
md += "        codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0\n";
md += "        starSlash=0 syntaxErrorFiles=0\n";
md += "gate: addedCommentLines=246 waterLines=33 waterRate=13.41%（本文件命中从 36 降至 33，newHits=0）\n```\n\n";
md += "本批未改动的 19 行按判定保留（其中 `edit.ts:40/273/330/347` 等已带标识符与后果）。\n";

fs.writeFileSync("d:/code/ZCode/docs/annotation/ZC-legacy-cleanup-queue.md", md, "utf8");
console.log(JSON.stringify(counts), "total=", sorted.length);
