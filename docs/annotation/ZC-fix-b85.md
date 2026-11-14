# ZC-FIX-B85（6 文件 / 29 处命中，实际改写 36 段）

> 基线：`d:\code\_annot_baseline\ZC-fix-b85\orig`（改写前的当前工作树）。
> 本批按命中处数降序处理，同文件多处一次改完；同文件内不属于 B85 的同风格短句段一并清理。

## 1. 验收输出

```text
SUMMARY files=6 rewrittenSegments=36 deletedOwnCommentLines=195 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

三项单独计数：`rewrittenSegments=36`、`deletedOwnCommentLines=195`、`codeTokenDiff=0`。
代码删除、上游注释删除、字符串字面量删除均为 0。

首轮校验曾以 `upstreamCommentDeleted=2` 失败：`ConfirmDialog.tsx` 的 `handleOpenChange` 上方
「Bugfix: Radix 在点击遮罩或按 Esc 时只会回调 onOpenChange(false)。」两行属于 HEAD 既有注释，
已原样恢复，只替换其后的自有两行。

## 2. 分文件计数

| 文件 | 改写段 | numstat（对基线） |
| --- | ---: | --- |
| `packages/ui/src/previewPaneOfficeDocxContent.tsx` | 6 | +19 / −33 |
| `packages/ui/src/v4/ConversationShareSuccessDock.tsx` | 6 | +11 / −33 |
| `packages/ui/src/v4/ConversationHookDetailsAction.tsx` | 6 | +20 / −32 |
| `packages/ui/src/WorkspaceEditorButtonGroup.tsx` | 6 | +19 / −32 |
| `packages/ui/src/ModelTrajectoryTimeline.tsx` | 6 | +23 / −32 |
| `packages/ui/src/ConfirmDialog.tsx` | 6 | +18 / −33 |
| **合计** | **36** | **+110 / −195** |

## 3. 改写要点

### previewPaneOfficeDocxContent.tsx

- `createDocxPreviewClassName`：`nextDocxPreviewClassId` 自增生成的名字同时是 `renderAsync` 的 `${className}-wrapper` 查询前缀与作用域样式命名空间，必须只增不减，否则多实例 section 样式互覆盖。
- `isSameDocxPreviewFit`：阈值 `scale<0.001`、`width/height<0.5` 必须宽于亚像素抖动又窄于真实拖拽；返回 true 时 `updateFit` 保留旧 `current`，跳过 `setFit` 提交。
- `updateFit`：`renderState !== "ready"` 时 `contentRef` 无子节点、`offsetWidth/offsetHeight` 为 0，`calculateDocxPreviewFit` 会把 `scale` 算成 0；`logger.debug` 放在去重之后，拖动时不按帧刷日志。
- 渲染 effect：键为 `buffer/previewClassName/sourcePath`，先 `replaceChildren()` + `setFit(null)`；`renderAsync` 成功后 `renderRoot` 才挂可见容器；`active === false` 的过期任务只停留在脱离文档树的临时容器。
- `useLayoutEffect`：`ResizeObserver` 必须等 `ready`，同时 observe `viewportRef` 与 `contentRef`，清理 `disconnect()` 防止卸载后 `updateFit` 仍被触发。
- JSX 尾部：原 267–270 行 `//` 落在 `<div>` 子节点位置会被渲染成可见文本，已删除并前移到 `return (` 内说明 `viewportRef.clientWidth`、`transform: scale` 与 `fit.width/fit.height` 的关系。

### ConversationShareSuccessDock.tsx

- `formatValue`：`code.includes("size")` 或 `payload_size_limit` 走 MB/KB/B 三档，其余 `String(value)`；`value === undefined` 返回 `"—"`。
- `copied`：只表示成功提示，`Promise.resolve(onCopy())` 归一同步/异步返回值；`setCopied(true)` 只在 resolve 为 true 时发生。
- 计时 effect：依赖 `[copied]`，每次 `setCopied(true)` 先 `clearTimeout` 旧 `timer` 再建 2000ms 新定时器；卸载时返回的清理函数撤销最后一个 timer。
- JSX 内 3 段 `//`（dismiss 按钮、`details` 告警区、`grid-cols-2` 动作区）都位于子节点位置，会渲染成可见文本；已删除并合并前移到 `return (` 内，分别点名 `role="status"`、`issue.code/rowId/index` 的 key、`onOpen/onCopy`。

### ConversationHookDetailsAction.tsx

- `buildHookDetailItems`：`toSorted` 按 `hookIndex` 升序且不改原数组；`didExecute === false` 直接跳过；key 为 `${entityId}:${hookRunId}`。
- `formatHookDuration`：先 `Math.max(0, Math.round(durationMs))` 夹住时钟回拨，再按 `<1000`、`<10_000` 分档决定 `toFixed(2/1)`。
- `hookDetailStatus`：`state === "running"` 必须先于 `outcome` 判断，否则未结束执行会被上一次结果抢先标成失败；`timed_out/cancelled/blocked` 顺序不可与 `failed` 交换。
- `HookStatusIcon`：五类状态的图标与配色固定，新增状态漏分支会落到 `CircleXIcon`，视觉上等同失败。
- `HookDetailItemRow`：`memo` + 仅 `item` 入参保证父级重渲染不重建整列；`durationLabel` 预先由 `formatHookDuration` 算好。
- `items.length === 0` 的 `return null` 放在 `useState/useMemo` 之后，保证 Hook 调用顺序不随 `rows` 变化。

### WorkspaceEditorButtonGroup.tsx

- `installedEditors`/`selectedEditorId`：前者初始 `[]` 让首帧 `return null`；后者惰性初始化 `readLastSelectedEditorId()` 只读一次存储，过期 id 交给 `resolveWorkspaceEditorSelection` 回落。
- 拉取 effect：依赖 `[platform]`，`disposed` 在清理函数置 true，迟到的 `then` 结果不会 `setInstalledEditors` 到已卸载组件；`catch` 只 `logger.warn`。
- `resolveWorkspaceEditorSelection`：office 模式先 `isFileManagerOpenTarget` 过滤，依赖必须含 `isOfficeMode`/`remoteTarget`，按钮、菜单、回调三处才同步。
- `handleOpenEditor`：`disabledReason` 必须先 return；`shouldPersistWorkspaceEditorSelection("explicit")` 为真才 `persistLastSelectedEditorId`；`openOptions` 仅在 `remoteTarget` 或 `workspaceIdentity` 存在时组装。
- `selectedEditor` 为空或 `remoteTarget.kind === "server"` 的整组 `return null` 放在所有 Hook 之后。
- JSX 内 206–209 行 `//` 位于子节点位置会被渲染成可见文本；已删除并前移到 `return (`，说明 `DropdownMenuRadioGroup` 的 `value` 与 `availableEditors.find` 的回落。

### ModelTrajectoryTimeline.tsx

- `useVirtualizer`：`getItemKey` 缺失才退回 `index`，下标当键会让 `scrollToIndex` 落到错误行；`estimateSize: 240` 只是首帧估算，`measureElement` 写回真实高度。
- 空依赖 effect 只在卸载时 `clearTrajectorySearchHighlights()`；搜索清空由下面 effect 的提前返回分支负责。
- 双帧 effect：第一帧 `virtualizer.measure()`，第二帧 `applyTrajectorySearchHighlights` + `scrollTrajectorySearchRangeIntoView`；清理同时 `cancelAnimationFrame(firstFrame/secondFrame)`；`mountedRowsKey` 只随行集合变化。
- `resolveTrajectoryTimelineItems`：`previousConversationMessageCount` 游标回写 `nextConversationMessageCount`，key 为 `${requestId}:${index}`。
- `resolveTrajectoryInputMessages`：`shouldUseConversationDelta` 分流；`index === 0` 保留完整上下文，后续 `filter(role !== "assistant")`；辅助请求不推进游标。
- 原 245–248 行短句段实际描述的是 `computeDeltaMessages`，却挂在 `shouldUseConversationDelta` 上方；已按函数各归其位，补上 `index === 0`、变短回全量、相等返回 `[]` 的分支顺序说明。

### ConfirmDialog.tsx

- 三个 selector：`pendingRequest`/`settleConfirmation`/`settleChoice` 分开订阅；确认与 `settleChoice("dismiss")` 是两条结算路径，合并会让遮罩关闭误触发确认。
- `displayedRequest = pendingRequest ?? displayedRequestRef.current`：退场动画期间沿用最后可见内容；`open` 只能由 `Boolean(pendingRequest)` 推导，否则弹窗关不掉。
- `handleOpenChange`：HEAD 既有 Bugfix 两行原样保留，补充 `!nextOpen && !requiredAcknowledgement` 才 `settleChoice("dismiss")`、确认按钮才走 `settleConfirmation(false)`、依赖 `[requiredAcknowledgement, settleChoice]`。
- keydown effect：`open && !destructive` 才注册；捕获阶段先于焦点元素；目标在 `button/input` 且带 `checkbox` 时不接管；清理用同一 `handleKeyDown` 引用 `removeEventListener`。
- `isSourceServerBoundary` 提前返回：内容交给 `SourceServerBoundaryDialogContent`，走 `DialogFooter` 会叠加两套页脚；`p-0`/`bg-popover`/`showCloseButton={false}` 防止绕过确认。
- JSX 内 281–284 行 `//` 位于 `DialogContent` 子节点位置会被渲染成可见文本；已删除并前移到主 `return (`，说明 `showCloseButton && !requiredAcknowledgement`、`absolute right-5 top-5` 与 `[app-region:no-drag]`。
