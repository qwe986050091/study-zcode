import fs from 'node:fs';

const j = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/ZC-deep-svc-base/baseline.json', 'utf8'));
const rows = j.rows;
const below = rows.filter((r) => r.measured < 30).sort((a, b) => b.need - a.need || a.path.localeCompare(b.path));
const totalCode = rows.reduce((s, r) => s + r.code, 0);
const totalComment = rows.reduce((s, r) => s + r.comment, 0);
const needLines = below.reduce((s, r) => s + r.need, 0);
const ratios = rows.map((r) => r.measured).sort((a, b) => a - b);
const median = ratios.length % 2 ? ratios[(ratios.length - 1) / 2] : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2;

const by = new Map();
for (const r of rows) {
  const parts = r.path.split('/');
  const key = parts.length === 4 ? '(root)' : parts[3];
  const cur = by.get(key) || { files: 0, below: 0, code: 0, comment: 0, need: 0 };
  cur.files++;
  cur.code += r.code;
  cur.comment += r.comment;
  if (r.measured < 30) {
    cur.below++;
    cur.need += r.need;
  }
  by.set(key, cur);
}
const groups = [...by.entries()].sort((a, b) => b[1].need - a[1].need);

const lines = [];
lines.push('# ZC 深度注释计划：packages/services');
lines.push('');
lines.push('> 规范母本：`d:\\code\\opensource\\redb\\docs\\annotation\\DEEP-SPEC.md`（v1）。');
lines.push('> 范围：`packages/services/src/**` 下全部生产 `.ts/.tsx`；排除 `*.test.ts(x)`、`*.spec.ts(x)`、`test-fixture.ts`、`dist/`、`node_modules/`、`__tests__/`、`fixtures/`。');
lines.push('> `packages/core/**`、`apps/**` 不在本计划内，由其他会话负责。');
lines.push('');
lines.push('## 1. 基线（2026-11-06，ZC-deep-svc-base 快照）');
lines.push('');
lines.push('```text');
lines.push('node d:\\code\\_annot_baseline\\deep-density.mjs d:\\code\\ZCode \\');
lines.push('  --baseline d:\\code\\_annot_baseline\\ZC-deep-svc-base \\');
lines.push('  --root packages/services/src --ext .ts,.tsx --threshold 30 --mode code \\');
lines.push('  --exclude "packages/services/src/**/*.test.ts,packages/services/src/**/*.test.tsx,packages/services/src/**/*.spec.ts,packages/services/src/**/*.spec.tsx,packages/services/src/**/test-fixture.ts"');
lines.push('```');
lines.push('');
lines.push('| 指标 | 值 |');
lines.push('| --- | ---: |');
lines.push(`| 受测文件数 | ${rows.length} |`);
lines.push(`| 低于 30%（coreBelow30） | ${below.length} |`);
lines.push(`| 缺口行数 needLines | ${needLines} |`);
lines.push(`| 最低密度 min | ${j.rows.length ? Math.min(...ratios).toFixed(2) : 0}% |`);
lines.push(`| 中位密度 median | ${median.toFixed(2)}% |`);
lines.push(`| 当前注释行 / 代码行 | ${totalComment} / ${totalCode}（${((totalComment / totalCode) * 100).toFixed(2)}%） |`);
lines.push('');
lines.push('口径：`注释行 / 代码行 ≥ 30%`（DEEP-SPEC 第 3 节 C1，`--mode code`）；缺口 `need = ceil(code × 30%) − comment`，逐文件求和，不允许大文件超额抵扣小文件。');
lines.push('');
lines.push('## 2. 按目录的缺口分布');
lines.push('');
lines.push('| 目录 | 文件数 | 低于 30% | 代码行 | 注释行 | 缺口 |');
lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const [k, v] of groups) {
  lines.push(`| \`${k}\` | ${v.files} | ${v.below} | ${v.code} | ${v.comment} | ${v.need} |`);
}
lines.push('');
lines.push('## 3. 按缺口排序的文件清单');
lines.push('');
lines.push('| # | 缺口 | 代码行 | 注释行 | 当前密度 | 文件 |');
lines.push('| ---: | ---: | ---: | ---: | ---: | --- |');
below.forEach((r, i) => {
  lines.push(`| ${i + 1} | ${r.need} | ${r.code} | ${r.comment} | ${r.measured.toFixed(2)}% | \`${r.path.replace('packages/services/src/', '')}\` |`);
});
lines.push('');
lines.push('## 4. 分批计划');
lines.push('');
lines.push('按「目录归属 + 缺口大小」切批，每批单独快照到 `d:\\code\\_annot_baseline\\ZC-deep-svc-bN\\`（`packages/services/src/...` 相对路径 + `_files.txt`），批内逐文件过双校验后才更新索引。');
lines.push('');
lines.push('| 批次 | 范围 | 预估缺口 | 说明 |');
lines.push('| --- | --- | ---: | --- |');
lines.push('| b1 | `bots/botsService.ts` | 2464 | 单文件近万行，按「文件头 INV 表 + 主干锚点 + 公开 item 级」分层，不灌水 |');
lines.push('| b2 | `zcode-agent/zcodeAgentService.ts`、`zcodeTaskServiceAdapter.ts` | 2536 | 进程生命周期 / V4 协议转换两条主链路 |');
lines.push('| b3 | `bots/providers/**`、`bots/**` 其余 | 2423 | 渠道适配（飞书/微信/Telegram）与群消息投递时序 |');
lines.push('| b4 | `session/**` | 2748 | 任务库 schema/迁移、automation、off-peak、Claude 导入 |');
lines.push('| b5 | `conversation-share/**`、`settings-sync/**`、`model-provider/**` | 3258 | 分享包完整性、设置同步合并、provider 凭据与路由 |');
lines.push('| b6 | `git/**`、`usage-stats/**`、`process/**`、`node.ts`、`telemetry/**` | 2944 | 子进程/命令行、用量统计、进程树所有权 |');
lines.push('| b7 | 其余小目录 | ~1787 | 按目录逐个清零 |');
lines.push('');
lines.push('每批完成后在 `docs/annotation/ZC-DEEP-svc-bN.md` 记录「路径｜职责｜注释主题｜+行数」，明细合计必须与 `deep-density` 的 `newComments` 对齐。');
lines.push('');
lines.push('## 5. 每批固定校验');
lines.push('');
lines.push('1. 快照：`ZC-deep-svc-bN/packages/services/src/...` + `_files.txt`；');
lines.push('2. 增量：逐文件 `git --no-pager diff --no-index --numstat <基线> <当前>`，删除列必须为 0；');
lines.push('3. 新增行仅整行 `//` 注释（不含 `*/`），不改代码 token / 缩进 / 字符串 / import 顺序；');
lines.push('4. 语法：TypeScript compiler API `parseDiagnostics === 0`，缺解析器即 fail-closed；');
lines.push('5. 密度：`deep-density.mjs --mode code --threshold 30`，逐文件达标；');
lines.push('6. 抽查 5 处最复杂逻辑，确认 INV 表与 `[并发]`/`[事务]`/`[资源]`/`[失败路径]`/`[权衡]` 标记覆盖。');
lines.push('');
lines.push('本计划不做 git 提交。');
lines.push('');

fs.writeFileSync('d:/code/ZCode/docs/annotation/ZC-DEEP-SERVICES-PLAN.md', lines.join('\n'), 'utf8');
console.log('wrote plan, below=' + below.length + ' need=' + needLines + ' byDir=' + groups.length);
