# ZC-DEEP-B149（4 文件，+157 行）

> 范围：TaskOutput 工具块、对话选区引用菜单、用户输入正文折叠、建议提示轮换。
> 快照：`d:\code\_annot_baseline\ZC-deep-b149\orig`；清单：`ZC-deep-b149-files.txt`。
> 目标密度 31.4%，实际落点 31.11%~31.58%。

## 1. 验收输出

```text
[ok] packages/ui/src/ToolCallBlocks/renderers/task-output.tsx: 6 blocks, 39 lines
[ok] packages/ui/src/v4/ConversationSelectionTooltip.tsx: 6 blocks, 39 lines
[ok] packages/ui/src/v4/ConversationUserInputBody.tsx: 7 blocks, 40 lines
[ok] packages/ui/src/v4/featureSuggestedPromptRotation.ts: 6 blocks, 39 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=157
TOTAL added=157 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.50% code=127 comment=40 packages/ui/src/ToolCallBlocks/renderers/task-output.tsx
31.11% code=135 comment=42 packages/ui/src/v4/ConversationSelectionTooltip.tsx
31.58% code=133 comment=42 packages/ui/src/v4/ConversationUserInputBody.tsx
31.30% code=131 comment=41 packages/ui/src/v4/featureSuggestedPromptRotation.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/ToolCallBlocks/renderers/task-output.tsx` | TaskOutput 工具调用块的标识、状态与输出渲染 | 记录归一、失败与停止判定、标签优先级与内容回退 | 39 |
| `packages/ui/src/v4/ConversationSelectionTooltip.tsx` | 对话文本选区检测与引用动作菜单 | 行类型映射、选区门禁条件、引用构造与动作后关闭 | 39 |
| `packages/ui/src/v4/ConversationUserInputBody.tsx` | 用户输入正文的高度测量与折叠展开 | 常量与容差、帧合并测量、观察器回退与清理 | 40 |
| `packages/ui/src/v4/featureSuggestedPromptRotation.ts` | 各面板建议提示候选与换一批游标 | 面板隔离、修订通知、三集合避重与环形候选 | 39 |

## 3. 说明

- `task-output.tsx` 已有一条类别标签根因注释，正文块避开该行，落在函数签名与语句上。
- `ConversationSelectionTooltip.tsx` 的 3 行控件门禁注释保持原样，新块插在其前后的独立语句上。
- `ConversationUserInputBody.tsx` 的 RAF 合并注释保持原样；新块锚在状态声明与函数签名，避开 effect 内部注释。
- `featureSuggestedPromptRotation.ts` 的两处根因注释保持原样；新块落在模块级表与函数签名上。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
