# ZC-FIX-B110（6 文件 / 30 处命中，实际改写 30 段）

> 基线：`d:\code\_annot_baseline\ZC-fix-b110\orig`（改写前的当前工作树）。
> 本批按命中处数降序处理，同文件多处一次改完。

## 1. 验收输出

```text
SUMMARY files=6 rewrittenSegments=30 deletedOwnCommentLines=144 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

三项单独计数：`rewrittenSegments=30`、`deletedOwnCommentLines=144`、`codeTokenDiff=0`。
代码删除、上游注释删除、字符串字面量删除均为 0。

## 2. 分文件计数

| 文件 | 改写段 | numstat（对基线） |
| --- | ---: | --- |
| `packages/shared/src/tool-plan-adapter.ts` | 5 | +17 / −23 |
| `packages/ui/src/chat-input-toolbar/StartPlanContextBalance.tsx` | 5 | +15 / −25 |
| `packages/ui/src/components/ui/diff-viewer.tsx` | 5 | +16 / −24 |
| `packages/ui/src/hooks/useBotGroupTask.ts` | 5 | +16 / −24 |
| `packages/ui/src/hooks/useTaskNotifications.ts` | 5 | +16 / −25 |
| `packages/ui/src/RemoteConnectionWizardChrome.tsx` | 5 | +14 / −23 |
| **合计** | **30** | **+94 / −144** |

## 3. 改写要点

### tool-plan-adapter.ts

- `PLAN_COLLECTION_KEYS`：顺序即优先级，`readPlanCollection` 逐个尝试且只接受 `Array.isArray`；新键只能追加末尾，否则多键输出会改变解析结果。
- `parsePlanStep`：字符串简写 `index === 0` 记 `in_progress`；对象按 `content ?? step ?? title ?? text ?? activeForm` 取标题，`normalizePlanStatus` 不认的状态返回 `null`。
- `extractPlanStepsFromValue`：空数组/非法集合返回 `null`，任一步解析失败即整组丢弃（`steps.length !== collection.length`），防止半截计划覆盖完整摘要。
- `isMainAgentToolProjectionSource`：`source === "subagent"` 或 `parentToolCallId`/`parentToolUseId`/`_meta.claudeCode.parentToolUseId` 任一存在即否决，子代理镜像的 TodoWrite 不能覆盖主任务摘要。
- `extractPlanStepsFromToolOutput`：先按 `[title, kind]` 指纹过 `isTodoPlanToolName`，再按 `collectOutputCandidates` 由浅到深尝试，首个非空计划立即返回。

### StartPlanContextBalance.tsx

- `resolveLimitTotal`：`limit.number ?? limit.unit ?? 0`，供 `getVisibleStartPlanLimits` 的 `total > 0` 判断使用，缺字段不抛错。
- `formatStartPlanRemainingPercentage`：`Number.isFinite` 校验后夹到 `[0,1]`，`style:"percent"` + `maximumFractionDigits:0` 防止负数/超 100% 与宽度抖动。
- `hasChatStartPlanBalance`：`config.loading`、非空额度、或 `config.onAccess` 任一成立即保留触发器，`onAccess` 是首次余额请求的唯一入口。
- `ChatStartPlanBalanceMeter`：`total > 0` 才做除法并夹取，避免除零；`renewTime` 只取 `limit.nextResetTime`，不用套餐级 `renewTime` 兜底。
- `ChatStartPlanBalancePanel`：`useCodingPlanBillingDiscount` 决定 `upgradeButtonHighlighted`；非 loading 且 `getVisibleStartPlanLimits` 为空时 `return null`。

### diff-viewer.tsx

- `DIFF_VIEWER_UNSAFE_CSS`：保持空串；`@pierre/diffs` 运行在 Shadow DOM 内，唯一覆盖入口是 `FileDiffOptions.unsafeCSS`。
- `viewerStyle`：三个 `--diffs*-bg` 指向 `var(--color-background)`；`--diffs-font-family` 用 `var(--font-mono)` 弥补阴影不继承；`...style` 最后展开。
- `options`：固定 `diffStyle:"unified"`、`diffIndicators:"bars"`、`disableFileHeader:true`、`overflow:"scroll"`；`hunkSeparators` 按 `rendersPatch` 用 `"simple"`/`"line-info"`；`optionsOverride` 最后展开。
- `diffNode`：`PatchDiff` 只收 `props.patch`，`MultiFileDiff` 只收 `props.oldFile/props.newFile`，联合类型在编译期互斥。
- `divProps`：`omitPatchDiffProps`/`omitMultiFileDiffProps` 剔除全部专有字段后透传 `HTMLAttributes`，剔除列表必须与 `DiffViewerProps` 同步维护。

### useBotGroupTask.ts

- `workspaceKey`：`workspaceIdentity?.trim() || workspacePath`，同时用于 `refresh` 归属匹配与 effect 依赖，已 trim 故 `find` 不再二次去空白。
- `refresh`：闭包 `revision` 做请求代次，`disposed` 或 `revision !== requested` 时丢弃旧响应；`taskId` 为空先 `setContext(null)`。
- `retry`：守卫 `context?.group` 与 `botsService.resendGroupResult`；回填比较 `botId/chatId/threadId`，只合并 `deliveries[result.id]`，`finally` 清 `busyId`。
- `reconcile`：与 `retry` 同一套守卫，`received` 原样传服务，失败只 `logger.warn("核对群结果失败")`。
- `retryPreparation`：要求 `context?.group?.threadId`、`taskId`、`botsService.retryTopicPreparation` 全部就绪；入参含 `workspacePath/workspaceIdentity/messageId`，`finally` 按 `messageId` 清 `busyId`。

### useTaskNotifications.ts

- `buildWorkspaceNotificationSignature`：`[endpointKey ?? "__base__", workspaceIdentity ?? "", workspacePath].join("\0")`，`__base__` 是固定哨兵，`\0` 避免路径含分隔符时碰撞。
- `useWorkspaceTerminalTaskNotifications`：`trimOptional` 把空串归一为缺失；`workspaceKey` 只用于 `sessions-index` 作用域，`signature` 由 `useMemo` 重算。
- `registryScope`：可选字段仅在存在时展开，`acquireSessionsIndex` 必须配对 `releaseSessionsIndex(registryScope, store)`（INV-06）。
- 终态通知：`collectTerminalTaskNotificationPayloads` 算边沿，单条失败被 `showTaskNotification` 内部吞掉，基线无条件推进到 `nextBySessionId`（INV-12/13）。
- `usePendingInteractionTaskNotifications`：`sessionId` 变化只建 `{ sessionId, seenRequestIds }` 基线；`platform` 缺失仍写入 `seenRequestIds`（INV-17）。

### RemoteConnectionWizardChrome.tsx

- `RemoteConnectionWizardSidebar`：`deviceManagement` 为真整段 `return null`；`currentIndex` 固定 `directory→2`、`connecting→1`、其余 `0`；`index < currentIndex` 才渲染 `CheckIcon`。
- `SettingsPreviewText`：占位按 `preview.kind` 分派 `docker.selectContainer`/`wsl.defaultDistro`/`server.urlPlaceholder`，ssh 固定 `user@host:22`；`preview.target ?? placeholder`。
- `RemoteConnectionWizardHeader`：`showKindTag = !deviceManagement && settingsPreview != null` 且 `kind !== "server"`；`hideHeading` 用 `sr-only` 保留 `DialogTitle`。
- `controls`：只渲染传入的 `onMinimize`/`onClose`，`title` 与 `sr-only` 共用 `remote.minimize`/`common.close` 文案键。
- 布局收口：`deviceManagement` 分支不含 `RemoteConnectionWizardSidebar`，向导分支第一行是步骤条 + controls，两种分支共用同一 `heading` 节点。
