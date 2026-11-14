# ZC-DEEP-B181（4 文件，+138 行）

> 范围：Markdown 选区操作条、工作区文件监听 hook、侧栏分区外壳、分享站入口（合计 450 行）。
> 快照：`d:\code\_annot_baseline\ZC-deep-b181\orig`；清单：`ZC-deep-b181-files.txt`。
> 目标密度 31.4%，实际落点 31.19%~31.78%。

## 1. 验收输出

```text
[ok] packages/ui/src/v4/MarkdownSelectionTooltip.tsx: 5 blocks, 34 lines
[ok] packages/ui/src/workspace-file-tree/useWorkspaceFileTreeWatchers.ts: 5 blocks, 34 lines
[ok] packages/ui/src/WorkspaceSidebar/WorkspacePurposeSection.tsx: 5 blocks, 36 lines
[ok] packages/web-share/src/main.tsx: 5 blocks, 34 lines
SUMMARY files=4 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=138
TOTAL added=138 hardBad=0 suspicious=0
```

逐文件密度：

```text
31.19% code=109 comment=34 packages/ui/src/v4/MarkdownSelectionTooltip.tsx
31.78% code=107 comment=34 packages/ui/src/workspace-file-tree/useWorkspaceFileTreeWatchers.ts
31.62% code=117 comment=37 packages/ui/src/WorkspaceSidebar/WorkspacePurposeSection.tsx
31.62% code=117 comment=37 packages/web-share/src/main.tsx
```

## 2. 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `.../ui/src/v4/MarkdownSelectionTooltip.tsx` | 正文选区操作条 | 选区必须在根内、折叠与多段放弃、排除区端点守卫、侧聊状态走外部存储、超长只允许加入任务 | 34 |
| `.../ui/src/workspace-file-tree/useWorkspaceFileTreeWatchers.ts` | 目录监听同步 hook | 代际标识服务更替、移除目录立即释放、在表或在途跳过、回调前双重校验、卸载清两表 | 34 |
| `.../ui/src/WorkspaceSidebar/WorkspacePurposeSection.tsx` | 侧栏可拖分区外壳 | 落点蓝线由排序状态派生、自身不画蓝线、变换只取位移、操作区悬停/触屏/展开三态 | 36 |
| `.../web-share/src/main.tsx` | 分享站独立入口 | 先定主题再渲染、回调路径中英双段、安全回跳、模拟模式仅开发态、未知路径落提示 | 34 |

## 3. 说明

- `MarkdownSelectionTooltip.tsx` 的块落在组件入口、选区检查、选区 hook 与 `return (` 之后；菜单属性行零改动。
- `useWorkspaceFileTreeWatchers.ts` 的块落在 hook 入口、同步效果、服务更替分支与卸载效果前；捕获分支原样保留。
- `WorkspacePurposeSection.tsx` 的块落在组件入口、落点派生、行内样式与 `return (` 之后；既有「原因」注释保持原样。
- `main.tsx` 的块落在四个启动函数签名前；顶层主题调用与既有注释未动。
- 本批无顺延文件；快照与现文件差异仅为本批新增注释行。

## 4. 落地后复扫

```text
SUMMARY files=5032 coreBelow30=1998 needLines=30492 min=0.00 median=31.32
本会话范围 files=4562 coreBelow30=1994 needLines=25900
```

累计 1,230 文件 / 122,265 行。
