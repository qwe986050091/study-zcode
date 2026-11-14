# ZC-DEEP-B183（4 文件，+131 行）

> 范围：机器人绑定群卡片、插件创建 hook、反馈中心弹窗、插件提及提供者（合计 447 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b183\orig`；清单：`ZC-deep-b183-files.txt`。
> 目标密度 31.4%，实际落点 30.30%~31.73%（最后一份起点已带 8 行既有注释）。

## 1. 验收输出

```text
[ok] packages/ui/src/BotsDialog/BoundGroupsCard.tsx: 4 blocks, 33 lines
[ok] packages/ui/src/conversation-workspace-target/usePluginCreator.ts: 4 blocks, 33 lines
[ok] packages/ui/src/feedback/FeedbackCenter.tsx: 4 blocks, 33 lines
[ok] packages/ui/src/mentions/providers/pluginsMentionProvider.ts: 4 blocks, 32 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=131
TOTAL added=131 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.13% code=106 comment=33 packages/ui/src/BotsDialog/BoundGroupsCard.tsx
31.73% code=104 comment=33 packages/ui/src/conversation-workspace-target/usePluginCreator.ts
31.43% code=105 comment=33 packages/ui/src/feedback/FeedbackCenter.tsx
30.30% code=132 comment=40 packages/ui/src/mentions/providers/pluginsMentionProvider.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `.../BotsDialog/BoundGroupsCard.tsx` | 绑定群列表与开关 | 会话标识作键、名称截断保悬停、单复数键、禁用三源合并、加载/空/错误互斥 | 33 |
| `.../conversation-workspace-target/usePluginCreator.ts` | 插件创建任务 hook | 目标解析同参、作用域引用标识一次调用、卸载不写态、重复触发忽略、只读工作区阻止 | 33 |
| `.../feedback/FeedbackCenter.tsx` | 反馈中心弹窗 | 无服务不渲染、标题随页签、返回仅票单页、上传指示覆盖两弹窗、表单以任务标识作键 | 33 |
| `.../mentions/providers/pluginsMentionProvider.ts` | 插件提及候选 | 禁用剔除、冲突可见禁选、官方市场优先、展示名本地化而标签固定原名、关键词并入多语言名 | 32 |

## 3. 说明

- `BoundGroupsCard.tsx` 的块落在列表组件、卡片组件与查询解构前；行内既有「格式化器只替换简单占位符」注释未动。
- `usePluginCreator.ts` 的块落在 hook 入口、目标解析与创建回调前；`isCurrent` 内部逻辑零改动。
- `FeedbackCenter.tsx` 的块落在记忆化组件签名、标题派生与 `return (` 之后；长类名属性行保持原样。
- `pluginsMentionProvider.ts` 既有 8 行设计说明保留，块落在映射函数、hook 与 `useMemo` 前，密度 30.30% 已达线。
- 本批无锚点失败；四份 check 一次通过。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1990 needLines=30233 min=0.00 median=31.32
本会话范围 files=4562 coreBelow30=1986 needLines=25641
```

累计 1,238 文件 / 122,534 行。
