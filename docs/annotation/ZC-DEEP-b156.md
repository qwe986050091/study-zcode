# ZC-DEEP-B156（4 文件，+155 行）

> 范围：switch_mode 计划卡片、会话选择引用、TTFT 结算记录与会话调试旁路（合计 660 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b156\orig`；清单：`ZC-deep-b156-files.txt`。
> 目标密度 31.4%，实际落点 31.15%~31.78%。

## 1. 验收输出

```text
[ok] packages/ui/src/ToolCallBlocks/renderers/switch-mode.tsx: 7 blocks, 40 lines
[ok] packages/ui/src/v4/composer/useConversationSelectionReferences.ts: 6 blocks, 38 lines
[ok] packages/ui/src/v4/telemetry/localTtftRecord.ts: 6 blocks, 39 lines
[ok] apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-debug.ts: 6 blocks, 38 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=155
TOTAL added=155 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.72% code=145 comment=46 packages/ui/src/ToolCallBlocks/renderers/switch-mode.tsx
31.15% code=122 comment=38 packages/ui/src/v4/composer/useConversationSelectionReferences.ts
31.78% code=129 comment=41 packages/ui/src/v4/telemetry/localTtftRecord.ts
31.58% code=152 comment=48 apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-debug.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/ToolCallBlocks/renderers/switch-mode.tsx` | 渲染 switch_mode 工具调用的计划卡片与降级输出 | 卡片按钮语义、子控件交互判定、回车与空格、复制能力检测、正文与渐隐同节点、快照提示常驻 | 40 |
| `packages/ui/src/v4/composer/useConversationSelectionReferences.ts` | 把会话选择引用与上限提示接到 React 状态 | 惰性初始化、会话/工作区/草稿三段作用域、事件订阅与卸载清理、函数式更新、只按 id 删除 | 38 |
| `packages/ui/src/v4/telemetry/localTtftRecord.ts` | 把待定 TTFT 采样结算成含阶段区间的记录 | 时钟漂移阈值、校准四项条件、未对齐只记缺失、区间逆序判无效、详情截断与质量标记 | 39 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-debug.ts` | 旁路观察网络事件并维护有界调试快照 | 事件与会话过滤、WeakMap 惰性状态、去重集合与滑窗、主回合限定、命中率未知即置空 | 38 |

## 3. 说明

- `switch-mode.tsx` 含 JSX，新块只插在模块级函数与组件内语句层，未进入 JSX 子节点或属性区。
- `useConversationSelectionReferences.ts` 有两个 `useEffect(` 锚点，分别用 `nth: 1` 与 `nth: 2` 定位。
- `session-debug.ts` 首行 `import {` 在文件中出现两次，文件头使用 `nth: 1`。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
