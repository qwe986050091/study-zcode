# ZC-DEEP-B122（4 文件，+171 行）

> 范围：`packages/ui/src` 的 PDF 缩放工具、工作流保存弹层、反馈展示层与远端连接日志 hook。
> 快照：`d:\code\_annot_baseline\ZC-deep-b122\orig`；清单：`ZC-deep-b122-files.txt`。
> 目标密度 31.4%，实际落点 31.11%~31.72%。

## 1. 验收输出

```text
[ok] packages/ui/src/components/ui/usePdfZoomOverlay.ts: 5 blocks, 43 lines
[ok] packages/ui/src/components/workflow-timeline/WorkflowSavePopover.tsx: 5 blocks, 44 lines
[ok] packages/ui/src/feedback/feedbackUserView.ts: 5 blocks, 42 lines
[ok] packages/ui/src/hooks/useRemoteConnectionLogs.ts: 5 blocks, 42 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=171
TOTAL added=171 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.72% code=145 comment=46 packages/ui/src/components/ui/usePdfZoomOverlay.ts
31.53% code=222 comment=70 packages/ui/src/components/workflow-timeline/WorkflowSavePopover.tsx
31.11% code=135 comment=42 packages/ui/src/feedback/feedbackUserView.ts
31.29% code=147 comment=46 packages/ui/src/hooks/useRemoteConnectionLogs.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/components/ui/usePdfZoomOverlay.ts` | PDF 缩放比例、视点锚点与预览叠加层 | 比例上下限、锚点换算、叠加层复用与清理 | 43 |
| `packages/ui/src/components/workflow-timeline/WorkflowSavePopover.tsx` | 工作流完成卡保存弹层的两条路径 | 草稿起点、名字探测防抖、覆盖确认、宿主契约 | 44 |
| `packages/ui/src/feedback/feedbackUserView.ts` | 反馈状态文案、相对时间与描述过滤 | 状态映射、时间分档、结构化描述不外泄 | 42 |
| `packages/ui/src/hooks/useRemoteConnectionLogs.ts` | 远端连接日志归一化与订阅收集 | 前缀剥离、进度去重合并、请求归属校验 | 42 |

## 3. 说明

- `WorkflowSavePopover.tsx` 首行是既有文件注释，文件头 INV 表按 `first: null` 插在该注释之前；不改变既有注释内容。
- 所有插入点均位于模块级或函数体内部，未落入 JSX 子节点位置。
- 本批未发现需要顺延的文件；快照与现文件差异仅为本批新增注释行。
