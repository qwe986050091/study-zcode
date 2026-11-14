# ZC-FIX-B3（4 文件：B29 剩余命中）

> B29 共 5 个命中文件 / 65 处；`OpenSplitButton.tsx` 已在 FIX-B2 清完，本批清剩余 4 个。
> 基线：`d:\code\_annot_baseline\ZC-fix-b3\orig`，即「B29 已插入、尚未改写」的状态。
> 改写只删本工程新增的注释行，代码 token 流与 git HEAD 逐行一致。

## 1. 验收输出

```text
SUMMARY files=4 rewrittenSegments=52 deletedOwnCommentLines=173 codeTokenDiff=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

三项单独计数：`rewrittenSegments=52`、`deletedOwnCommentLines=173`、`codeTokenDiff=0`。
`codeDeletion / upstreamCommentDeleted / literalCommentDeletion` 均为 0，未触碰上游注释与字符串字面量。

## 2. 分文件计数

| 文件 | 改写段 | 删自有注释行 | numstat（对基线） |
| --- | ---: | ---: | --- |
| `packages/ui/src/TaskList.tsx` | 15 | 49 | +15 / −49 |
| `packages/ui/src/previewPaneContent.tsx` | 14 | 46 | +14 / −46 |
| `packages/ui/src/WorkspaceSidebarFooter.tsx` | 12 | 44 | +12 / −44 |
| `packages/ui/src/GitPane.tsx` | 11 | 34 | +11 / −34 |
| **合计** | **52** | **173** | **+52 / −173** |

## 3. 改写对应关系

每条改写后的注释都锚定真实标识符，并至少回答一项：不变量、破坏者、故障现象、顺序约束、失败后状态。

### TaskList.tsx

- `startDraft`：只订阅动作不订阅草稿字段，否则每次输入重渲整个列表。
- `renameInputRef`：由 TaskList 持有并传给 `TaskRenameDialog`，否则外部拿不到 input 做 focus/select。
- `handleCreateTask`：只调 `startDraft(..., { createSource: "project" })`，提前 `createTask` 会持久化空任务；`readOnlyReason` 必须先 return。
- `handleArchiveTaskFromInline`：`e.stopPropagation()` 必须最先，`pendingArchiveTaskIdRef.current !== taskId` 只进入待确认，二次点击才调 `onArchiveTaskRef.current`。
- `handleStartRenameTask`：先清 `pendingArchiveTaskId` 再设 `renamingTaskId`；`renameDraft` 取 `currentTitle ?? ""`。
- `handleTogglePinTask`：`onSetTaskPinnedRef.current` 返回空即失败，成功后不回写本地副本。
- `handleArchiveTask`：右键菜单路径不二次确认，执行前同时清确认态与重命名态。
- `handleSubmitRenameTask`：先查 `taskLookup`，`normalizedTitle === task.title.trim()` 时不发 `onRenameTask`。
- `handleMarkTaskAsUnread`：`void onSetTaskUnreadRef.current(taskId, true)` 弱一致，不 await。
- `renamingTaskId` 的两个 effect：空值早退；`focus()` 后必须 `select()`。
- `pendingArchiveTaskId` / `renamingTaskId` 的存在性 effect：用 `visibleSourceTasks.some(...)` 校验并清理。
- `renderTaskItem`：组件体内闭包当前渲染值，不能提为模块级。
- `isPinned`：`pinnedTaskIdSet.has(...)` 替代 `pinnedTasks.some(...)`，避免 O(n²)。

### previewPaneContent.tsx

- `PreviewPaneContentProps`：字段全部 props 注入，新增字段保持可选。
- `getPreviewPaneErrorTextClass`：`error === fileMissingMessage` 单独判弱化色。
- `enableCodeLineSelection` / `enableCodeGutterUtility`：解构默认 `false`。
- `mediaLabels`：同一个 `intl` 一次构造三条文案。
- image 分支：加载条件必须含 `!error`，错误分支用 `codeViewer.imageUnavailable` 兜底。
- media 分支：`source.type === "media" && mediaSource` 才渲染，回调只透传。
- `fileTooLarge`：必须早于 `!filePreview` 判断。
- `!filePreview`：无 error 返回 `null`，不渲染错误页。
- `filePreview.isBinary`：早于 `inferCodeLanguage` 拦截。
- `filePreview.content.length === 0`：直接返回 `codeViewer.empty`。
- `fileLanguage`：`inferCodeLanguage(source.path, filePreview.content)` 同时用路径与内容。
- `codeReviewProjection`：仅 `source.type === "code-review"` 调 `resolveCodeReviewContentProjection`。
- SVG 分支：`source.type !== "code-review"` 才允许图形预览。

### WorkspaceSidebarFooter.tsx

- `DESKTOP_ZOOM_MIN_LEVEL` / `MAX_LEVEL`：只控制菜单 disabled，真实边界在主进程。
- `profileBadge`：一次 `getSidebarProfileBadge` 供 aria-label 与菜单头共用。
- `avatarKey`：`avatarUrl ?? id ?? "guest"` 作为 `Avatar` 的 key。
- `showAuthRestoreLoading`：`!user && isRestoringOAuthSession`，已有用户时不被恢复标志覆盖。
- `copyUserId`：无 `user.id` 直接返回，成功/失败分别 toast。
- `desktopZoomLevel` / `runDesktopZoomCommand`：只转发 `executeDesktopCommand`，级别由 `onDesktopZoomLevelChanged` 回写。
- 非桌面 effect：先 `setDesktopZoomLevel(0)` 再 return，不订阅。
- `isCancelled`：只拦截首次 `getDesktopZoomLevel` 查询，订阅由 `dispose` 解绑。
- `canResetDesktopZoom` / `canZoomOut`：`!== 0` 与 `>` 的边界语义。

### GitPane.tsx

- `diffStateByKey`：`getDiffCacheKey(sourceId, change.path)` 组合键，整体由 `diffGenerationRef` 失效。
- `diffGenerationRef`：请求前快照，回调比对后丢弃过期响应。
- `currentChanges`：`sections.flatMap`，查找与虚拟滚动共用同一顺序。
- `expandedPath` effect：`currentChanges.some(...)` 校验后 `setExpandedPath(null)`。
- `loadDiffForChange` 的 `cacheKey`：不拼 `workspacePath`。
- `fileChangeFindState`：纯函数 `getFileChangeFindState` 计算，渲染期不再过滤排序。
- `changeRowVirtualizer.measure()`：`expandedPath` 或 `currentDataset.id` 变化后重测。
- `handleSelectSource`：先 `onSelectSource` 再清 `expandedPath`。
- `handleExpandChange`：展开时 `loadDiffForChange`，收起不删缓存。
- `resolveChangePath`：`isAbsoluteFilePath` 分流后才 `joinFilePath`。
- `handleCopyAbsolutePath`：走 `fileActions.copyAbsolutePath`，远程路径由 `useFileContextActions` 决定。

## 4. 说明

- 本批净删 121 行注释（+52 / −173）；按「内容优先」，密度下降不补写。
- 每处改写前的连续短句均合并为一行，未再出现无标识符的排比句。
- 扫描复检：4 个文件在当前工作树中已无「连续 ≥3 行、每行 <25 字符、无标识符」的命中。
