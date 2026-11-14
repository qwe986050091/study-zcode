// 生成 TS SDK 免注清单（MCP-EXEMPT-LIST.md）：逐文件当前密度 + 不注理由。
import fs from 'node:fs';

const j = JSON.parse(fs.readFileSync('D:/code/_annot_baseline/mcp-inventory.json', 'utf8'));
const rows = [];
for (const x of j.prod) {
  const isCodemod = x.rel.startsWith('packages/codemod/');
  if (x.density < 0.3 && !isCodemod) continue; // 补充范围，不列入免注
  let reason;
  if (isCodemod) reason = '迁移 codemod 开发期工具，不在 SDK 运行时协议链路内';
  else if (x.density >= 0.5) reason = '上游 JSDoc/块注释已写满，重注等于抄写';
  else reason = '已达 30% 门槛，补齐到 33% 的边际收益低于改动风险';
  rows.push({ rel: x.rel, total: x.total, code: x.code, comment: x.comment, density: x.density, reason });
}
for (const g of j.gen) {
  rows.push({ rel: g.rel, total: g.total, code: g.code, comment: g.comment, density: g.density, reason: '规范生成物，文件头声明 DO NOT EDIT，会被 fetch:spec-types 覆盖' });
}
rows.sort((a, b) => a.rel.localeCompare(b.rel));

const lines = [];
lines.push('# MCP TypeScript SDK 免注清单');
lines.push('');
lines.push('> 口径：`注释行 ÷ 代码行`（整行注释，行尾注释不计）。列入本清单 = 本工程不改动。');
lines.push('> 生成时间：2026-11-08，来源 `d:\\code\\_annot_baseline\\mcp-inventory.json`。');
lines.push('');
lines.push('## 一、统计');
lines.push('');
const gen = rows.filter((r) => r.reason.startsWith('规范生成物'));
const codemod = rows.filter((r) => r.reason.startsWith('迁移 codemod'));
const full = rows.filter((r) => r.reason.startsWith('上游 JSDoc'));
const pass = rows.filter((r) => r.reason.startsWith('已达 30%'));
lines.push('| 分类 | 文件数 | 理由 |');
lines.push('|---|---|---|');
lines.push(`| 规范生成物 | ${gen.length} | 机器生成，不可手改 |`);
lines.push(`| codemod 迁移工具 | ${codemod.length} | 开发期工具，非 SDK 运行时协议链路 |`);
lines.push(`| 上游注释已写满（≥50%） | ${full.length} | 重注等于抄写，无新增信息 |`);
lines.push(`| 已达门槛（30%~50%） | ${pass.length} | 硬门槛已满足，深注收益低 |`);
lines.push(`| **合计** | **${rows.length}** | |`);
lines.push('');
lines.push('## 二、逐文件清单');
lines.push('');
lines.push('| 文件 | 总行 | 代码行 | 注释行 | 密度 | 不注理由 |');
lines.push('|---|---|---|---|---|---|');
for (const r of rows) {
  lines.push(`| \`${r.rel}\` | ${r.total} | ${r.code} | ${r.comment} | ${(r.density * 100).toFixed(1)}% | ${r.reason} |`);
}
lines.push('');
lines.push('## 三、备注');
lines.push('');
lines.push('- `packages/server-legacy/src/auth/clients.ts` 曾被脚本按 `automatically generated` 误判为生成物（该短语出现在 JSDoc 正文）。已核实为手写接口文件，密度已达标，不纳入批次。');
lines.push('- 低于 30% 的 54 个非 codemod 文件进入补充批次 `MCP-deep-b01..b14`；24 个 codemod 文件按本清单豁免。');
lines.push('');

const out = 'D:/code/opensource/mcp-sdk/docs/annotation/MCP-EXEMPT-LIST.md';
fs.writeFileSync(out, lines.join('\n'), 'utf8');
console.log('rows=' + rows.length + ' -> ' + out);
