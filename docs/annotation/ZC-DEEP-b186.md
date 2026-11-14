# ZC-DEEP-B186（4 文件，+136 行）

> 范围：输入区后台工作徽标、对话引用标签、草稿模型门禁、SaveWorkflow 卡片（合计 621 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b186\orig`；清单：`ZC-deep-b186-files.txt`。
> 目标密度 31.4%，实际落点 31.25%~31.48%。

## 1. 验收输出

```text
[ok] packages/ui/src/v4/composer/ConversationBackgroundWorkTrigger.tsx: 4 blocks, 33 lines
[ok] packages/ui/src/v4/composer/ConversationSelectionReferenceChip.tsx: 4 blocks, 34 lines
[ok] packages/ui/src/v4/composer/useDraftModelReadinessGate.ts: 4 blocks, 34 lines
[ok] packages/ui/src/ToolCallBlocks/renderers/save-workflow.tsx: 4 blocks, 35 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=136
TOTAL added=136 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.34% code=134 comment=42 packages/ui/src/v4/composer/ConversationBackgroundWorkTrigger.tsx
31.25% code=112 comment=35 packages/ui/src/v4/composer/ConversationSelectionReferenceChip.tsx
31.45% code=159 comment=50 packages/ui/src/v4/composer/useDraftModelReadinessGate.ts
31.48% code=216 comment=68 packages/ui/src/ToolCallBlocks/renderers/save-workflow.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `.../composer/ConversationBackgroundWorkTrigger.tsx` | 后台工作徽标 | 只计运行中、工作流单列、总数求和、子代理钳非负、文案三元链顺序、双布局与图标次序 | 33 |
| `.../composer/ConversationSelectionReferenceChip.tsx` | 对话引用标签 | 空列表早退、单条取文件名、混合计数文案、展开项键稳定性、来源行分流、删除键按需出现 | 34 |
| `.../composer/useDraftModelReadinessGate.ts` | 草稿模型门禁 | 作用域键与首帧重置、提交校验作用域、订阅版本比较、读取失败不等价于缺失、首发复查 | 34 |
| `.../ToolCallBlocks/renderers/save-workflow.tsx` | SaveWorkflow 卡片 | 归一化裁剪与空串归缺省、默认值在场判断、覆盖只认显式真值、两个徽标语义色、折叠行只留名字 | 35 |

## 3. 说明

- 四个文件均在语句层插块：`ConversationBackgroundWorkTrigger.tsx` 的三块落在计数函数、组件入口与 `tooltip` 派生前；JSX 子树内部未插入，避免落入元素属性区。
- `ConversationSelectionReferenceChip.tsx` 的块落在组件签名、`filePath` 与 `removeLabel` 前；`references.map` 内部保持原样。
- `useDraftModelReadinessGate.ts` 的块落在 hook 入口、`commitStatus` 与 `ensureReadyForSend` 前；`useEffect` 内既有注释未动。
- `save-workflow.tsx` 的块落在两个解析函数与卡片组件前；`kindDetail` / `renderContent` 内既有行内注释保持原样。
- 本批 1 次锚点修正（`readArgDeclarations` 实为非导出函数），修正后 check 一次通过。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1978 needLines=29849 min=0.00 median=31.32
本会话范围 files=4562 coreBelow30=1974 needLines=25257
```

累计 1,250 文件 / 122,941 行。
