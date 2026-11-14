# ZC-DEEP-B203（4 文件，+127 行）

> 范围：模型输入模态按钮组、已保存工作流实参表单、工作流提问工具卡与 workflow-run 传输方法（合计 547 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b203\orig`；清单：`ZC-deep-b203-files.txt`。
> 目标密度 31.4%，实际落点 31.43%~31.72%。

## 1. 验收输出

```text
[ok] packages/ui/src/settings/model-provider-section/ProviderModelModalityOptions.tsx: 6 blocks, 31 lines
[ok] packages/ui/src/settings/saved-workflows/savedWorkflowArgsForm.ts: 7 blocks, 33 lines
[ok] packages/ui/src/ToolCallBlocks/renderers/resolve-workflow-question.tsx: 7 blocks, 32 lines
[ok] packages/ui/src/v4/agentConversationTransportWorkflowRuns.ts: 7 blocks, 31 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=127
[packages/ui/src/settings/model-provider-section/ProviderModelModalityOptions.tsx] added=31 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/settings/saved-workflows/savedWorkflowArgsForm.ts] added=33 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/ToolCallBlocks/renderers/resolve-workflow-question.tsx] added=32 nonComment=0 starSlash=0 suspicious=0
[packages/ui/src/v4/agentConversationTransportWorkflowRuns.ts] added=31 nonComment=0 starSlash=0 suspicious=0
TOTAL added=127 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.43% code=105 comment=33 packages/ui/src/settings/model-provider-section/ProviderModelModalityOptions.tsx
31.62% code=117 comment=37 packages/ui/src/v4/agentConversationTransportWorkflowRuns.ts
31.67% code=180 comment=57 packages/ui/src/settings/saved-workflows/savedWorkflowArgsForm.ts
31.72% code=145 comment=46 packages/ui/src/ToolCallBlocks/renderers/resolve-workflow-question.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/.../ProviderModelModalityOptions.tsx` | 输入模态多选 | 四项固定集合、text 不可关闭、切换时保 supportsText、覆盖来源优先级、aria 与禁用表达 | 31 |
| `ui/settings/saved-workflows/savedWorkflowArgsForm.ts` | 实参表单纯函数 | 声明决定形状、initialArgs 优先、空文本语义、错误一次收齐、格式与解析互逆 | 33 |
| `ui/.../resolve-workflow-question.tsx` | 提问工具卡渲染 | 输入宽容解析一次、状态优先级、结果文本回退顺序、详情感知、概要截断 | 32 |
| `ui/v4/agentConversationTransportWorkflowRuns.ts` | run 只读查询面 | 先握手、工作区展开、可选参数按存在性下发、artifact 与节点结果定位口径 | 31 |

## 3. 说明

- `ProviderModelModalityOptions.tsx` 原 1.90%，块锚定模态常量、单项组件、选中兜底、禁用与覆盖判定、切换回调；
  `audio` 只存在于 Draft 的约定写入注释，避免后续按字面把它加进 UI。
- `savedWorkflowArgsForm.ts` 原 13.33%，既有中文注释保留；六个块锚定六个导出函数，
  把「空文本对非 boolean 等于不传」与「必填且无默认值才报错」两条语义固定下来。
- `resolve-workflow-question.tsx` 原 9.66%，块锚定输入解析、状态组合、结果回退、详情感知、内容渲染与概要；
  未改动任何 JSX 结构，只补判定顺序说明。
- `agentConversationTransportWorkflowRuns.ts` 原 5.13%，块锚定工厂入参与五个查询方法；
  「artifact 是给用户看的产出、不是 run 返回值」的边界在注释中显式化。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1910 needLines=27752 min=0.00 median=31.34
本会话范围 files=4562 coreBelow30=1906 needLines=23160
```

累计 1,318 文件 / 125,150 行。
