// Phase 0 分批与基线脚本（读取 cc-inventory.json，生成 cc-plan.json / plan.md / 基线副本）
// 用法：node d:\code\_annot_baseline\plan-cc.mjs [--no-copy]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\claude-code-main';
const BASE = 'd:\\code\\_annot_baseline';
const inv = JSON.parse(fs.readFileSync(path.join(BASE, 'cc-inventory.json'), 'utf8'));
const byRel = new Map(inv.files.map((f) => [f.rel, f]));

// ---------- 1. 批次分组规则 ----------
const exact = new Map();
function E(paths, name) {
  for (const p of paths) exact.set(p, name);
}

// L1-C1 入口与 Turn 循环
E(
  [
    'main.tsx',
    'setup.ts',
    'replLauncher.tsx',
    'query.ts',
    'QueryEngine.ts',
    'context.ts',
    'dialogLaunchers.tsx',
    'interactiveHelpers.tsx',
    'projectOnboardingState.ts',
    'cost-tracker.ts',
    'costHook.ts',
  ],
  'L1-C1-入口与Turn循环',
);
// L1-C3 模型请求与重试（由 services/api 前缀覆盖，exact 仅留无）
// L1-C4 工具执行与权限
E(['Tool.ts', 'Task.ts', 'tools.ts'], 'L1-C4-工具执行与权限');
// L1-C5 结果投影与消息
E(
  ['utils/messages.ts', 'utils/toolResultStorage.ts', 'components/Message.tsx', 'components/Messages.tsx'],
  'L1-C5-结果投影与消息',
);
// L1-C6 上下文预算与压缩
E(
  [
    'query/tokenBudget.ts',
    'utils/context.ts',
    'utils/tokens.ts',
    'utils/attachments.ts',
    'utils/analyzeContext.ts',
    'utils/collapseReadSearch.ts',
  ],
  'L1-C6-上下文预算与压缩',
);
// L1-C7 持久化与冷恢复
E(
  [
    'utils/sessionStorage.ts',
    'utils/sessionRestore.ts',
    'utils/sessionState.ts',
    'utils/conversationRecovery.ts',
    'utils/crossProjectResume.ts',
    'utils/sessionStoragePortable.ts',
    'history.ts',
  ],
  'L1-C7-持久化与冷恢复',
);
// L1-C8 rewind / fork / checkpoint
E(
  ['utils/fileHistory.ts', 'components/MessageSelector.tsx', 'hooks/useFileHistorySnapshotInit.ts'],
  'L1-C8-rewind与fork',
);
// L1-C9 命令队列与轮次边界
E(
  [
    'utils/messageQueueManager.ts',
    'utils/queueProcessor.ts',
    'utils/QueryGuard.ts',
    'types/textInputTypes.ts',
    'hooks/useCommandQueue.ts',
    'hooks/useQueueProcessor.ts',
    'hooks/useInputBuffer.ts',
  ],
  'L1-C9-命令队列与轮次边界',
);
// L1-C10 后台任务与多 Agent
E(
  [
    'tasks.ts',
    'utils/tasks.ts',
    'utils/teammateMailbox.ts',
    'hooks/useTaskListWatcher.ts',
    'hooks/useTasksV2.ts',
    'hooks/useScheduledTasks.ts',
    'hooks/useBackgroundTaskNavigation.ts',
  ],
  'L1-C10-后台任务与多Agent',
);
// L1-C11 hooks 与信任
E(
  [
    'utils/hooks.ts',
    'hooks/useDeferredHookMessages.ts',
    'utils/sessionFileAccessHooks.ts',
    'utils/classifierApprovalsHook.ts',
    'utils/config.ts',
    'hooks/useCanUseTool.tsx',
  ],
  'L1-C11-Hooks与工作区信任',
);

const prefixRules = [
  // L1-C10
  ['tasks/', 'L1-C10-后台任务与多Agent'],
  ['coordinator/', 'L1-C10-后台任务与多Agent'],
  ['utils/swarm/', 'L1-C10-后台任务与多Agent'],
  ['utils/task/', 'L1-C10-后台任务与多Agent'],
  ['utils/cron', 'L1-C10-后台任务与多Agent'],
  ['hooks/notifs/', 'L1-C10-后台任务与多Agent'],
  ['services/AgentSummary/', 'L1-C10-后台任务与多Agent'],
  ['tools/AgentTool/', 'L1-C10-后台任务与多Agent'],
  ['tools/shared/', 'L1-C10-后台任务与多Agent'],
  ['tools/TaskOutputTool/', 'L1-C10-后台任务与多Agent'],
  ['tools/TaskGetTool/', 'L1-C10-后台任务与多Agent'],
  ['tools/TaskListTool/', 'L1-C10-后台任务与多Agent'],
  ['tools/TaskCreateTool/', 'L1-C10-后台任务与多Agent'],
  ['tools/TaskUpdateTool/', 'L1-C10-后台任务与多Agent'],
  ['tools/TaskStopTool/', 'L1-C10-后台任务与多Agent'],
  ['tools/SendMessageTool/', 'L1-C10-后台任务与多Agent'],
  ['tools/TeamCreateTool/', 'L1-C10-后台任务与多Agent'],
  ['tools/TeamDeleteTool/', 'L1-C10-后台任务与多Agent'],
  ['tools/ScheduleCronTool/', 'L1-C10-后台任务与多Agent'],
  // L1-C11
  ['utils/hooks/', 'L1-C11-Hooks与工作区信任'],
  ['components/TrustDialog/', 'L1-C11-Hooks与工作区信任'],
  ['components/ManagedSettingsSecurityDialog/', 'L1-C11-Hooks与工作区信任'],
  // L1-C12
  ['services/mcp/', 'L1-C12-MCP与工具面'],
  ['utils/mcp/', 'L1-C12-MCP与工具面'],
  ['tools/MCPTool/', 'L1-C12-MCP与工具面'],
  ['tools/ListMcpResourcesTool/', 'L1-C12-MCP与工具面'],
  ['tools/ReadMcpResourceTool/', 'L1-C12-MCP与工具面'],
  ['tools/McpAuthTool/', 'L1-C12-MCP与工具面'],
  ['tools/ToolSearchTool/', 'L1-C12-MCP与工具面'],
  // L1-C4
  ['services/tools/', 'L1-C4-工具执行与权限'],
  ['utils/permissions/', 'L1-C4-工具执行与权限'],
  ['hooks/toolPermission/', 'L1-C4-工具执行与权限'],
  // L1-C3
  ['services/api/', 'L1-C3-模型请求与重试'],
  // L1-C5
  ['components/messages/', 'L1-C5-结果投影与消息'],
  ['components/StructuredDiff/', 'L1-C5-结果投影与消息'],
  // L1-C1
  ['entrypoints/', 'L1-C1-入口与Turn循环'],
  ['query/', 'L1-C1-入口与Turn循环'],
  // L1-C2
  ['cli/', 'L1-C2-非交互CLI'],
  // L1-C6
  ['services/compact/', 'L1-C6-上下文预算与压缩'],
  ['services/PromptSuggestion/', 'L1-C6-上下文预算与压缩'],
  ['utils/todo/', 'L1-C6-上下文预算与压缩'],
  // L1-C7
  ['screens/', 'L1-C7-持久化与冷恢复'],
  ['migrations/', 'L1-C7-持久化与冷恢复'],
  ['memdir/', 'L1-C7-持久化与冷恢复'],
  ['utils/filePersistence/', 'L1-C7-持久化与冷恢复'],
  // L1-C9
  ['utils/processUserInput/', 'L1-C9-命令队列与轮次边界'],
  // L1-C8
  ['commands/rewind/', 'L1-C8-rewind与fork'],
  ['commands/branch/', 'L1-C8-rewind与fork'],
  // L2-D1
  ['tools/BashTool/', 'L2-D1-Shell安全'],
  ['tools/PowerShellTool/', 'L2-D1-Shell安全'],
  ['utils/bash/', 'L2-D1-Shell安全'],
  ['utils/powershell/', 'L2-D1-Shell安全'],
  ['utils/shell/', 'L2-D1-Shell安全'],
  // L2-D2
  ['tools/FileEditTool/', 'L2-D2-文件与检索工具'],
  ['tools/FileReadTool/', 'L2-D2-文件与检索工具'],
  ['tools/FileWriteTool/', 'L2-D2-文件与检索工具'],
  ['tools/GlobTool/', 'L2-D2-文件与检索工具'],
  ['tools/GrepTool/', 'L2-D2-文件与检索工具'],
  ['tools/NotebookEditTool/', 'L2-D2-文件与检索工具'],
  ['tools/LSPTool/', 'L2-D2-文件与检索工具'],
  ['tools/REPLTool/', 'L2-D2-文件与检索工具'],
  ['tools/testing/', 'L2-D2-文件与检索工具'],
  ['services/lsp/', 'L2-D2-文件与检索工具'],
  // L2-D3 其余工具
  ['tools/', 'L2-D3-其余工具'],
  // L2-D4 配置/插件/认证/安装
  ['utils/plugins/', 'L2-D4-配置插件认证'],
  ['utils/settings/', 'L2-D4-配置插件认证'],
  ['utils/secureStorage/', 'L2-D4-配置插件认证'],
  ['utils/dxt/', 'L2-D4-配置插件认证'],
  ['utils/nativeInstaller/', 'L2-D4-配置插件认证'],
  ['utils/claudeInChrome/', 'L2-D4-配置插件认证'],
  ['utils/computerUse/', 'L2-D4-配置插件认证'],
  ['utils/deepLink/', 'L2-D4-配置插件认证'],
  ['utils/skills/', 'L2-D4-配置插件认证'],
  ['utils/memory/', 'L2-D4-配置插件认证'],
  ['utils/ultraplan/', 'L2-D4-配置插件认证'],
  // L2-D5 utils 其余
  ['utils/', 'L2-D5-Utils基础设施'],
  // L2-D6..D12
  ['components/', 'L2-D6-UI组件'],
  ['commands/', 'L2-D7-斜杠命令'],
  ['hooks/', 'L2-D8-Hooks目录'],
  ['ink/', 'L2-D9-Ink渲染器'],
  ['services/', 'L2-D10-Services其余'],
  ['bridge/', 'L2-D11-Bridge与远程'],
  ['remote/', 'L2-D11-Bridge与远程'],
  ['server/', 'L2-D11-Bridge与远程'],
  ['upstreamproxy/', 'L2-D11-Bridge与远程'],
  ['skills/', 'L2-D12-顶层杂项'],
  ['native-ts/', 'L2-D12-顶层杂项'],
  ['constants/', 'L2-D12-顶层杂项'],
  ['types/', 'L2-D12-顶层杂项'],
  ['bootstrap/', 'L2-D12-顶层杂项'],
  ['state/', 'L2-D12-顶层杂项'],
  ['context/', 'L2-D12-顶层杂项'],
  ['keybindings/', 'L2-D12-顶层杂项'],
  ['voice/', 'L2-D12-顶层杂项'],
  ['vim/', 'L2-D12-顶层杂项'],
  ['buddy/', 'L2-D12-顶层杂项'],
  ['moreright/', 'L2-D12-顶层杂项'],
  ['schemas/', 'L2-D12-顶层杂项'],
  ['plugins/', 'L2-D12-顶层杂项'],
  ['outputStyles/', 'L2-D12-顶层杂项'],
  ['assistant/', 'L2-D12-顶层杂项'],
];

function groupOf(rel) {
  if (exact.has(rel)) return exact.get(rel);
  for (const [p, name] of prefixRules) if (rel.startsWith(p)) return name;
  return 'L2-D12-顶层杂项';
}

// ---------- 2. 新增行数预估 ----------
function estimate(f) {
  const missing = Math.max(0, f.exports - f.exportsWithChinese);
  const upgraded = f.level !== 'none';
  if (f.totalLines > 800) {
    // 超大文件：只做文件头 + 主干锚点 + 导出级说明
    const anchored = Math.min(f.exports, 15);
    return upgraded ? 4 + Math.min(missing, 12) * 3 : 10 + anchored * 3;
  }
  if (f.exports === 0) return upgraded ? 8 : 12;
  return Math.max(8, (upgraded ? 4 : 12) + missing * 3);
}

// ---------- 3. 分组 + 装箱 ----------
const groups = new Map();
for (const f of inv.files) {
  if (f.isBarrel) continue; // barrel 不注
  const g = groupOf(f.rel);
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(f);
}

const LIMIT_FILES = 120;
const LIMIT_LINES = 2000;
const batches = [];
for (const [gname, files] of groups) {
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  let cur = [];
  let curEst = 0;
  const flush = () => {
    if (!cur.length) return;
    batches.push({ group: gname, files: cur, est: curEst });
    cur = [];
    curEst = 0;
  };
  for (const f of files) {
    const est = estimate(f);
    if (cur.length && (cur.length + 1 > LIMIT_FILES || curEst + est > LIMIT_LINES)) flush();
    cur.push(f);
    curEst += est;
  }
  flush();
}

// 批次命名：同组多批时追加 -1/-2
const groupCount = {};
for (const b of batches) groupCount[b.group] = (groupCount[b.group] || 0) + 1;
const seen = {};
for (const b of batches) {
  if (groupCount[b.group] > 1) {
    seen[b.group] = (seen[b.group] || 0) + 1;
    b.name = `${b.group}-${seen[b.group]}`;
  } else b.name = b.group;
}

// 排序：L1 链路顺序，再 L2 目录顺序
const L1_ORDER = [
  'L1-C1-入口与Turn循环',
  'L1-C2-非交互CLI',
  'L1-C3-模型请求与重试',
  'L1-C4-工具执行与权限',
  'L1-C5-结果投影与消息',
  'L1-C6-上下文预算与压缩',
  'L1-C7-持久化与冷恢复',
  'L1-C8-rewind与fork',
  'L1-C9-命令队列与轮次边界',
  'L1-C10-后台任务与多Agent',
  'L1-C11-Hooks与工作区信任',
  'L1-C12-MCP与工具面',
];
const rank = (b) => {
  const base = b.name.replace(/-\d+$/, '');
  const i = L1_ORDER.indexOf(base);
  if (i >= 0) return i;
  const m = /^L2-D(\d+)/.exec(base);
  return 1000 + (m ? Number(m[1]) : 99);
};
batches.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

// ---------- 4. 写出 plan.json ----------
const plan = {
  root: ROOT,
  generatedAt: new Date().toISOString(),
  totals: inv.totals,
  barrels: inv.files.filter((f) => f.isBarrel).map((f) => f.rel),
  batches: batches.map((b) => ({
    name: b.name,
    files: b.files.length,
    lines: b.files.reduce((s, f) => s + f.totalLines, 0),
    exports: b.files.reduce((s, f) => s + f.exports, 0),
    est: b.est,
    fileList: b.files.map((f) => f.rel),
  })),
};
fs.writeFileSync(path.join(BASE, 'cc-plan.json'), JSON.stringify(plan, null, 2), 'utf8');

// ---------- 5. 复制基线快照 ----------
const doCopy = !process.argv.includes('--no-copy');
if (doCopy) {
  for (const b of plan.batches) {
    const dir = path.join(BASE, 'CC-' + b.name);
    for (const rel of b.fileList) {
      const src = path.join(ROOT, rel);
      const dst = path.join(dir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
    fs.writeFileSync(path.join(dir, '_files.txt'), b.fileList.join('\n') + '\n', 'utf8');
  }
}

// ---------- 6. 生成 plan.md ----------
const pad = (s, n) => String(s).padEnd(n);
const dirRows = Object.entries(inv.byDir)
  .sort((a, b) => b[1].lines - a[1].lines)
  .map(([d, s]) => `| \`${d}\` | ${s.files} | ${s.lines} | ${s.none} | ${s.header} | ${s.l2} | ${s.exports} |`)
  .join('\n');

const bigRows = inv.bigFiles
  .map((f) => `| \`${f.rel}\` | ${f.totalLines} | ${f.exports} | ${f.level === 'none' ? '无' : f.level === 'header' ? '头/锚点' : '导出级'} |`)
  .join('\n');

const levelRows = plan.batches
  .map((b, i) => {
    const kind = b.name.startsWith('L1') ? 'L1 深注' : 'L2 中注';
    const dep =
      b.name.startsWith('L1-C10') ? 'C1、C9'
      : b.name.startsWith('L1-C11') ? 'C1、C4'
      : b.name.startsWith('L1-C12') ? 'C1、C4'
      : b.name.startsWith('L1-C1-') ? '—'
      : b.name.startsWith('L1-C2') ? 'C1'
      : b.name.startsWith('L1-C3') ? 'C1'
      : b.name.startsWith('L1-C4') ? 'C1、C3'
      : b.name.startsWith('L1-C5') ? 'C1、C4'
      : b.name.startsWith('L1-C6') ? 'C1、C5'
      : b.name.startsWith('L1-C7') ? 'C1、C5'
      : b.name.startsWith('L1-C8') ? 'C1、C7'
      : b.name.startsWith('L1-C9') ? 'C1、C3'
      : '全部 L1 后（无强依赖）';
    return `| ${i + 1} | \`${b.name}\` | ${kind} | ${b.files} | ${b.lines} | ${b.exports} | +${b.est} | ${dep} |`;
  })
  .join('\n');

const fileSections = plan.batches
  .map(
    (b) =>
      `### \`${b.name}\`（${b.files} 文件 / ${b.lines} 行 / 预估 +${b.est}）\n\n\`\`\`text\n${b.fileList.join('\n')}\n\`\`\`\n`,
  )
  .join('\n');

const md = `# Claude Code 全量中文注释工程 —— Phase 0 盘点与批次方案

> 生成脚本：\`d:/code/_annot_baseline/inventory-cc.mjs\` + \`plan-cc.mjs\`（只读仓库；基线副本在 \`d:/code/_annot_baseline/CC-<批次名>/\`）。
> 注释口径沿用 ZCode 工程：L1 深注（文件头四段 + 关键函数语义/失败路径/顺序敏感点/反直觉）、L2 中注（文件头 + 每个导出 ≥3 行说明 + 复杂分支就近注释）；只新增注释行，逐文件 numstat 删除列必须为 0。

## 一、结论

- 非测试 \`.ts/.tsx\` 文件：**${inv.totals.files}** 个，总行数 **${inv.totals.lines}**（代码行 ${inv.totals.codeLines}，可识别中文注释行 ${inv.totals.chineseCommentLines}）。
- 导出符号合计 ${inv.totals.exports} 个。
- 注释覆盖现状：**完全无中文注释 ${inv.totals.none} 个**；**已有文件头/主干锚点级 ${inv.totals.header} 个**（其中 \`ink/screen.ts\`、\`utils/computerUse/appNames.ts\` 只有 1~2 行零散中文，实际按未注处理）；**按导出口径疑似 L2 ${inv.totals.l2} 个**（含前序批次中的短文件，仍按 L2 复核）。
- 前序批次共 **96 个文件**（链路 0/1、2/3、6/7、8/9、10），这 96 个文件共有 765 个导出，其中仅 135 个导出上方有中文注释（17.6%），**整体仍属“文件头级”，需按 L2 补齐**，不重写、不重复灌水。
- 切成 **${plan.batches.length} 批**：L1 深注 ${plan.batches.filter((b) => b.name.startsWith('L1')).length} 批 + L2 中注 ${plan.batches.filter((b) => b.name.startsWith('L2')).length} 批。
- 总预估新增注释行 **+${plan.batches.reduce((s, b) => s + b.est, 0)}**（不含空行与后续复核补注）。
- 排除：4 个 barrel 文件（\`components/CustomSelect/index.ts\`、\`components/mcp/index.ts\`、\`components/Spinner/index.ts\`、\`utils/crypto.ts\`）。
- 快照中 **0 个 \`*.test.*\` / \`*.spec.*\`，0 个 \`.d.ts\`**；无 \`package.json\` / \`tsconfig.json\`，不能编译，只能做语法解析校验。

## 二、盘点

### 2.1 总览

| 指标 | 数值 |
| --- | --- |
| 非测试源码文件 | ${inv.totals.files} |
| 总行数 | ${inv.totals.lines} |
| 代码行（去空行/注释行） | ${inv.totals.codeLines} |
| 导出符号 | ${inv.totals.exports} |
| 中文注释行 | ${inv.totals.chineseCommentLines} |
| 完全无注释 | ${inv.totals.none} |
| 文件头/主干锚点级 | ${inv.totals.header} |
| 疑似 L2（导出口径启发式） | ${inv.totals.l2} |
| > 800 行文件 | ${inv.bigFiles.length}（占 ${((inv.bigFiles.reduce((s, f) => s + f.totalLines, 0) / inv.totals.lines) * 100).toFixed(1)}% 行数） |

**分类口径**（可复算）：中文注释行按注释状态机统计（\`//\`、\`/* */\`、\`*\`、JSX \`{/* */}\`）；疑似 L2 = 导出符号上方 10 行内有中文注释的比例 ≥ 50% 且中文注释行密度 ≥ 3%。这是启发式，不代替逐导出人工复核。

### 2.2 按目录

| 目录 | 文件数 | 总行数 | 无注释 | 头/锚点级 | 疑似 L2 | 导出数 |
| --- | --- | --- | --- | --- | --- | --- |
${dirRows}

### 2.3 超过 800 行的文件（${inv.bigFiles.length}）

这些文件只做“文件头 + 主干锚点 + 导出级说明”，不逐行展开。

| 路径 | 行数 | 导出数 | 当前注释 |
| --- | --- | --- | --- |
${bigRows}

## 三、批次方案

### 3.1 切批规则

- 优先按“链路 + 目录聚合”，不拆散同一条链路的上下游；L1 批在前，L2 批在后。
- 每批 ≤ ${LIMIT_FILES} 个文件且预估新增 ≤ ${LIMIT_LINES} 行；核心链路专项批次允许文件数低于 50，以链路完整性优先。
- 前序 96 个文件按 L2 标准“补齐缺口”：已有文件头保留，只补缺失导出的说明与分支锚点；预估行数按 \`missingExports*3\` 计算。
- 每批执行顺序内部为：先补/建文件头 → 再逐导出补说明 → 再做分支锚点 → 最后语法与 numstat 校验。
- 依赖关系只表达“阅读/概念依赖”，注释工作本身可并行；但同文件不得跨批，避免基线冲突。

### 3.2 批次总表

| # | 批次名 | 级别 | 文件数 | 批内总行 | 导出数 | 预估新增 | 概念依赖 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${levelRows}

### 3.3 执行顺序

1. 先做 L1-C1 → C2 → C3 → C4 → C5，建立“入口 / 请求 / 工具 / 结果”主干。
2. 再做 L1-C6 → C7 → C8 → C9 → C10 → C11 → C12（预算、持久化、回退、队列、后台、hooks、MCP）。
3. L1 全部完成后按目录顺序做 L2-D1 → D12；L2 内部无强依赖，可按批并行。
4. 每批完成后立即跑 \`node d:/code/_annot_baseline/cc-verify.mjs <批次名>\`，失败文件从该批基线副本恢复后重做。

## 四、每批文件清单

${fileSections}

## 五、基线快照与校验

- 基线目录：\`d:/code/_annot_baseline/CC-<批次名>/\`，按仓库相对路径镜像；每批根目录有 \`_files.txt\` 清单。
- 校验脚本：\`d:/code/_annot_baseline/cc-verify.mjs <批次名>\`，逐文件执行
  \`git --no-pager diff --no-index --numstat -- <基线文件> <工作区文件>\`，
  并调用 \`ts.createSourceFile\`（TS 编译器来自 \`d:/code/ZCode/node_modules/typescript\`）检查 \`parseDiagnostics\`。
- 输出末行固定为：
  \`SUMMARY files=<n> added=<sum> deletedNonZero=<count> syntaxErr=<count>\`
- 验收：\`deletedNonZero=0\` 且 \`syntaxErr=0\`。

## 六、盘点中发现的异常

1. **快照不完整**：没有 \`package.json\` / \`tsconfig.json\`，没有测试文件，也没有 \`.d.ts\`；文件末尾带 base64 \`sourceMappingURL\`，部分文件是编译产物（React Compiler memo cache 等），不能直接运行。
2. **超大文件集中**：129 个文件（6.8%）占 40.2% 行数；\`cli/print.ts\`（5595）、\`utils/messages.ts\`（5560）、\`utils/sessionStorage.ts\`（5106）、\`utils/hooks.ts\`（5103）这类文件必须限制为锚点式注释，否则单批新增会失控。
3. **前序注释深度不均**：96 个已注文件里，\`utils/messages.ts\` 有 40 行中文注释却覆盖 106 个导出（导出覆盖率 3.8%）；\`services/mcp/auth.ts\`（2578 行）有 101 行中文注释覆盖 13 个导出，仍属“文件头 + 少量函数锚点”，需按 L2 补齐，但不要覆盖已有注释。
4. **文档与代码轻微不一致**：\`docs/annotation/链路6-7-回退与队列.md\` 提到 \`types/messageQueueTypes.ts\` 不存在（\`messageQueueManager.ts\` 仍 import 它），属快照缺失类型文件；注释时只能引用现有符号。
5. **目录命名不规范**：顶层混有 \`components/\`、\`screens/\`（UI）与 \`utils/\` 巨型杂项目录（564 文件、18.2 万行）；\`moreright/\`、\`buddy/\`、\`vim/\`、\`voice/\` 等为实验/附属模块，已归入 L2-D12，避免拉高 L1 成本。
6. **中文计数存在噪声**：\`utils/computerUse/appNames.ts\` 的英文注释里出现“微信”等示例词，会被启发式计为 1 行中文注释；这类文件不要按“已有注释”处理。

## 七、Phase 0 未改动声明

本阶段仅新增以下仓库内文件：本文件（\`docs/annotation/plan.md\`）；未修改任何源码、未执行 \`git commit\` / \`git push\`。
`;

fs.writeFileSync(path.join(ROOT, 'docs', 'annotation', 'plan.md'), md, 'utf8');

console.log('batches=' + plan.batches.length + ' estTotal=' + plan.batches.reduce((s, b) => s + b.est, 0) + ' copied=' + doCopy);
for (const b of plan.batches) console.log(pad(b.name, 32) + pad(b.files + 'f', 6) + pad(b.lines + 'L', 8) + pad('+' + b.est, 7));
