# ZC-DEEP-B143（4 文件，+162 行）

> 范围：助手预览卡片派生、工作区 fork、持久记忆提示词与模式候选浮层。
> 快照：`d:\code\_annot_baseline\ZC-deep-b143\orig`；清单：`ZC-deep-b143-files.txt`。
> 目标密度 31.4%，实际落点 31.25%~31.60%。

## 1. 验收输出

```text
[ok] packages/ui/src/v4/useAssistantPreviewCardsForRow.ts: 5 blocks, 40 lines
[ok] apps/zcode-cli/packages/core/src/runtime/methods/workspace-fork.ts: 5 blocks, 41 lines
[ok] apps/zcode-cli/packages/core/src/subagent/persistent-memory-prompt.ts: 5 blocks, 40 lines
[ok] apps/zcode-cli/packages/tui/src/app-mode-suggestion-panel.tsx: 5 blocks, 41 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=162
TOTAL added=162 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.39% code=137 comment=43 packages/ui/src/v4/useAssistantPreviewCardsForRow.ts
31.25% code=272 comment=85 apps/zcode-cli/packages/core/src/runtime/methods/workspace-fork.ts
31.52% code=165 comment=52 apps/zcode-cli/packages/core/src/subagent/persistent-memory-prompt.ts
31.60% code=212 comment=67 apps/zcode-cli/packages/tui/src/app-mode-suggestion-panel.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/v4/useAssistantPreviewCardsForRow.ts` | 助手文本行的预览卡片派生与变更读取 | 建卡前置、请求键三重约束、迟到回包丢弃与失败降级 | 40 |
| `apps/zcode-cli/packages/core/src/runtime/methods/workspace-fork.ts` | 消息点 fork 的会话复制与工作区回退 | 两阶段副作用、检查点切片、同文件取最早 before 与事件顺序 | 41 |
| `apps/zcode-cli/packages/core/src/subagent/persistent-memory-prompt.ts` | 持久记忆系统提示词的模板与拼装 | 占位符字面量替换、作用域全覆盖、索引归一与空态文案 | 40 |
| `apps/zcode-cli/packages/tui/src/app-mode-suggestion-panel.tsx` | 模式候选浮层的裁剪、滚动与高亮 | 行高恒定、列宽预算、窗口夹取与纯展示边界 | 41 |

## 3. 说明

- `workspace-fork.ts` 首行为 JSDoc 起始 `/**`，文件头插在该行之后（仍在块注释内）。
- `workspace-fork.ts` 既有注释密集（16.18%），本批按目标密度 31.4% 追加 41 行。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
