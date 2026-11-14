# ZC-DEEP-B124（4 文件，+169 行）

> 范围：`packages/ui/src` 的任务通知编排、MCP 存储辅助、CUA 结果解析与磁盘卡片。
> 快照：`d:\code\_annot_baseline\ZC-deep-b124\orig`；清单：`ZC-deep-b124-files.txt`。
> 目标密度 31.4%，实际落点 31.08%~31.22%。

## 1. 验收输出

```text
[ok] packages/ui/src/lib/taskNotificationOrchestrator.ts: 5 blocks, 42 lines
[ok] packages/ui/src/store/mcpStoreHelpers.ts: 5 blocks, 42 lines
[ok] packages/ui/src/ToolCallBlocks/renderers/cuaResultState.ts: 5 blocks, 43 lines
[ok] packages/ui/src/resource-manager/storage/StorageDiskCard.tsx: 5 blocks, 42 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=169
TOTAL added=169 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.21% code=141 comment=44 packages/ui/src/lib/taskNotificationOrchestrator.ts
31.08% code=148 comment=46 packages/ui/src/store/mcpStoreHelpers.ts
31.22% code=189 comment=59 packages/ui/src/ToolCallBlocks/renderers/cuaResultState.ts
31.11% code=135 comment=42 packages/ui/src/resource-manager/storage/StorageDiskCard.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/lib/taskNotificationOrchestrator.ts` | 会话终态与待处理交互的通知载荷编排 | 终态三阶段映射、前后状态比较、审批识别与已见过滤 | 42 |
| `packages/ui/src/store/mcpStoreHelpers.ts` | MCP 配置本地持久化与服务器列表合并 | 键名集中、读取兜底、作用域取末两级与启用态三级回退 | 42 |
| `packages/ui/src/ToolCallBlocks/renderers/cuaResultState.ts` | Computer Use 工具结果的应用/元素解析 | 结构化内容优先级、包装层解包、元素名裁剪与子节点续拼 | 43 |
| `packages/ui/src/resource-manager/storage/StorageDiskCard.tsx` | 资源管理器单块磁盘占用卡片 | 挂载点取值、比例分母、图例顺序与选中态双条件 | 42 |

## 3. 说明

- 四个文件均位于 `packages/ui`，插入点全部落在模块级、函数体或组件体（`const body = (` 之前），未进入 JSX 子节点。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
