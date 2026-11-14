# ZC-DEEP-B146（4 文件，+163 行）

> 范围：Bot 工作区访问卡、工作流 run 摘要卡、反馈时间线摘要翻译、生成式界面调参面板。
> 快照：`d:\code\_annot_baseline\ZC-deep-b146\orig`；清单：`ZC-deep-b146-files.txt`。
> 目标密度 31.4%，实际落点 31.11%~31.45%。

## 1. 验收输出

```text
[ok] packages/ui/src/BotsDialog/WorkspaceAccessCard.tsx: 6 blocks, 39 lines
[ok] packages/ui/src/components/workflow-timeline/WorkflowRunDigest.tsx: 7 blocks, 46 lines
[ok] packages/ui/src/feedback/feedbackTimelineSummary.ts: 6 blocks, 39 lines
[ok] packages/ui/src/gen-ui/components/TweakPanel.tsx: 5 blocks, 39 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=163
TOTAL added=163 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.45% code=124 comment=39 packages/ui/src/BotsDialog/WorkspaceAccessCard.tsx
31.29% code=326 comment=102 packages/ui/src/components/workflow-timeline/WorkflowRunDigest.tsx
31.11% code=135 comment=42 packages/ui/src/feedback/feedbackTimelineSummary.ts
31.20% code=125 comment=39 packages/ui/src/gen-ui/components/TweakPanel.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/BotsDialog/WorkspaceAccessCard.tsx` | Bot 工作区访问范围选择卡与逐项勾选明细 | 全权哨兵值、计数口径、明细只在部分授权时渲染 | 39 |
| `packages/ui/src/components/workflow-timeline/WorkflowRunDigest.tsx` | 工作流 run 摘要卡：阶段线、留白与问题提示、运行控制 | 折叠只影响展示、空白区点击判定、恢复与停止互斥、键控重挂 | 46 |
| `packages/ui/src/feedback/feedbackTimelineSummary.ts` | 反馈工单事件摘要到国际化文案的翻译 | 只翻译已知摘要、未知原样返回、回退串与历史中文一致 | 39 |
| `packages/ui/src/gen-ui/components/TweakPanel.tsx` | 生成式界面调参面板：改动、预览与提交 | 原值集合、忙碌与错误局部态、三类控件渲染与可访问名 | 39 |

## 3. 说明

- `WorkflowRunDigest.tsx` 已有较多 JSDoc 与行注释，正文块全部落在函数体语句上，避开注释行与 JSX 子节点、属性区。
- `WorkspaceAccessCard.tsx` 与 `TweakPanel.tsx` 的主返回语句 `return (` 在文件中非唯一，使用 `nth: 1` 锚定首个（组件主返回）。
- `feedbackTimelineSummary.ts` 的锚点全部为函数体语句或模块级函数签名，未触碰含正则字面量的匹配语句。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。
