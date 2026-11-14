# ZC-DEEP-B164（4 文件，+149 行）

> 范围：产物「作为文件打开」按钮、产物索引、完成卡与套餐入口清单 hook（合计 756 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b164\orig`；清单：`ZC-deep-b164-files.txt`。
> 目标密度 31.4%，实际落点 31.30%~31.39%。

## 1. 验收输出

```text
[ok] packages/ui/src/app-shell/workflow-artifacts/ArtifactOpenAsFileButton.tsx: 4 blocks, 37 lines
[ok] packages/ui/src/components/workflow-timeline/WorkflowArtifactIndex.tsx: 5 blocks, 38 lines
[ok] packages/ui/src/components/workflow-timeline/WorkflowCompletionCard.tsx: 5 blocks, 38 lines
[ok] packages/ui/src/hooks/useCodingPlanEntryPlanList.ts: 4 blocks, 36 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=149
TOTAL added=149 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.32% code=182 comment=57 packages/ui/src/app-shell/workflow-artifacts/ArtifactOpenAsFileButton.tsx
31.36% code=220 comment=69 packages/ui/src/components/workflow-timeline/WorkflowArtifactIndex.tsx
31.39% code=223 comment=70 packages/ui/src/components/workflow-timeline/WorkflowCompletionCard.tsx
31.30% code=131 comment=41 packages/ui/src/hooks/useCodingPlanEntryPlanList.ts
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/app-shell/workflow-artifacts/ArtifactOpenAsFileButton.tsx` | 产物页头部「作为文件打开」分段按钮 | 能力探测双方法、版本化路径缓存、失败出缓存、本机路径不带远程目标、菜单首次展开加载 | 37 |
| `packages/ui/src/components/workflow-timeline/WorkflowArtifactIndex.tsx` | 产物索引的行、门与列布局 | 行高固定、禁用按钮语义、版本尾槽从第二版出现、门不计入产物、延迟递增 | 38 |
| `packages/ui/src/components/workflow-timeline/WorkflowCompletionCard.tsx` | 完成态工作流收据卡 | 三段顺序、缺失值写破折号、紧凑计数小数位、首帧终值、仅在允许时翻数字 | 38 |
| `packages/ui/src/hooks/useCodingPlanEntryPlanList.ts` | 个人与团队套餐入口清单 | 身份与代次双绑定、刷新失败复用缓存、双提供方并行、卸载后不写状态、缺失判定保留成功 | 36 |

## 3. 说明

- `ArtifactOpenAsFileButton.tsx` 的注释不进入 JSX 属性与菜单项内部，只落在接口、能力探测与路径缓存处。
- `WorkflowArtifactIndex.tsx` 的块均锚定函数签名，未插入按钮元素的属性列表。
- `WorkflowCompletionCard.tsx` 的块锚定格式化、数字翻动与两个组件签名，未进入四格 JSX。
- `useCodingPlanEntryPlanList.ts` 的块锚定 hook 签名、团队状态类型与缺失过滤，未改动 effect 依赖数组。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2066 needLines=32787 min=0.00 median=31.30
本会话范围 files=4562 coreBelow30=2062 needLines=28195
```

累计 1,162 文件 / 119,824 行。
