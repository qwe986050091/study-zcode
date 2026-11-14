# ZC-DEEP-B179（4 文件，+137 行）

> 范围：快捷命令弹层、右键菜单、PPTX 选择操作条、斜杠命令提及分区（合计 475 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b179\orig`；清单：`ZC-deep-b179-files.txt`。
> 目标密度 31.4%，实际落点 31.21%~31.58%。

## 1. 验收输出

```text
[ok] packages/ui/src/quickpick/QuickPickCommandDialog.tsx: 5 blocks, 35 lines
[ok] packages/ui/src/components/ui/context-menu.tsx: 5 blocks, 34 lines
[ok] packages/ui/src/components/ui/pptx-selection-action-bar.tsx: 5 blocks, 34 lines
[ok] packages/ui/src/slashCommandPanelSections.tsx: 5 blocks, 34 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=137
TOTAL added=137 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.25% code=112 comment=35 packages/ui/src/quickpick/QuickPickCommandDialog.tsx
31.58% code=114 comment=36 packages/ui/src/components/ui/context-menu.tsx
31.21% code=141 comment=44 packages/ui/src/components/ui/pptx-selection-action-bar.tsx
31.48% code=108 comment=34 packages/ui/src/slashCommandPanelSections.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `.../quickpick/QuickPickCommandDialog.tsx` | 快捷命令分区弹层 | 开关由调用方持有、空分区剔除、搜索值覆盖关键词、选中先关闭再执行、异常记录与提示 | 35 |
| `.../components/ui/context-menu.tsx` | 右键菜单统一样式 | 每层槽位标注、外层独立圆角、层级高于提示层、缩进与危险变体、子菜单箭头与宽度 | 34 |
| `.../components/ui/pptx-selection-action-bar.tsx` | PPTX 选择操作条 | 锚定真实布局、Portal 隔离缩放、编辑态清空草稿、组合输入不拦截退出、Esc 分支顺序 | 34 |
| `.../slashCommandPanelSections.tsx` | 提及面板分区组装 | 分区顺序固定、应用命令不加斜杠、技能加美元前缀、三段加载错误态、缓存依赖完整 | 34 |

## 3. 说明

- `QuickPickCommandDialog.tsx` 的块落在组件入口、分组派生、弹层骨架与条目常量前；条目 JSX 内部未插入。
- `context-menu.tsx` 的块落在四个导出件（内容、条目、子菜单触发器、子菜单内容）的签名前；长类名属性行保持零改动。
- `pptx-selection-action-bar.tsx` 的块落在组件入口、清空草稿效果、`return (` 之后与 Esc 处理的分支前；JSX 属性区未插入。
- `slashCommandPanelSections.tsx` 的块落在函数入口、`return useMemo(` 之后与技能、子代理两个分区对象内；依赖数组保持零改动。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=2006 needLines=30756 min=0.00 median=31.31
本会话范围 files=4562 coreBelow30=2002 needLines=26164
```

累计 1,222 文件 / 121,990 行。
