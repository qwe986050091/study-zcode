# ZC-FIX-B113（6 文件 / 29 处命中，实际改写 29 段）

> 基线：`d:\code\_annot_baseline\ZC-fix-b113\orig`（改写前的当前工作树）。
> 本批按命中处数降序处理，同文件多处一次改完。

## 1. 验收输出

```text
SUMMARY files=6 rewrittenSegments=29 deletedOwnCommentLines=133 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

三项单独计数：`rewrittenSegments=29`、`deletedOwnCommentLines=133`、`codeTokenDiff=0`。
代码删除、上游注释删除、字符串字面量删除均为 0。

## 2. 分文件计数

| 文件 | 改写段 | numstat（对基线） |
| --- | ---: | --- |
| `apps/zcode-cli/packages/cli/src/command-center/handlers/plugins.ts` | 2 | +6 / −10 |
| `apps/zcode-cli/packages/core/src/runtime/internal-methods.ts` | 4 | +12 / −20 |
| `apps/zcode-cli/packages/node-repl-host/src/cua-bridge.ts` | 4 | +15 / −18 |
| `apps/zcode-cli/packages/telemetry/src/agent-trace-runtime.ts` | 9 | +29 / −38 |
| `apps/zcode-cli/packages/tui/src/app-input-status.tsx` | 5 | +14 / −24 |
| `apps/zcode-cli/packages/tui/src/app-model-suggestion-panel.tsx` | 5 | +17 / −23 |
| **合计** | **29** | **+93 / −133** |

## 3. 改写要点

### plugins.ts

- `list/status` 分支：能力缺失走 `unavailable(deps)` 并保留 `deps.getMode?.()`；同一 `outcome` 同时喂给 `formatPluginsPanelResponse` 与 `buildPluginsSelection`；`selectedPluginId` 传 `undefined`，选择器按 `Math.max(0,-1)` 落到第 0 项。
- `handlePluginsUninstall`：`tokens.slice(1)` 后首个非 `--force`/`-f` 参数为 `plugin`，其余计 `extras`；`!plugin || extras.length > 0` 回用法；无 `force` 只返回确认指引，不调用 `uninstallPlugin`。

### internal-methods.ts

- `AgentRuntimeCoreMethods`：只声明签名，实现经 `installAgentRuntimeMethods` 挂到 `AgentRuntime.prototype`；`internal.ts` 用交叉类型并入 `AgentRuntimeInternal`，不 import 实现模块。
- `enqueueDeferredInput`：`TurnSteerInput` 入队后立即尝试消费，消费单飞；拒绝返回带稳定 `reason` 的 `TurnSteerResult`，成功回传 `inputId`（INV-10）。
- `startMcpStartup`：返回仍在等待的 `Promise<McpConnectionSnapshot>`，未启动为 `undefined`；`refreshMcpToolsIfChanged` 仅在签名变化时重注册，失败不推进 revision。
- `resumeFromStore`：先 `initializeMessageHistoryFromContext`，再 `readSessionTodosForContext`/`readSessionTargetForContext` → `injectTargetStateIntoMessageHistory`；顺序反转会让目标提醒落在旧历史上。

### cua-bridge.ts

- `createComputerUseBridgeGlobals`：用 `Symbol.for(NODE_REPL_CUA_BRIDGE_SYMBOL)` 而非可枚举属性；`assertActive` 比对 `active.generation` 与 `input.generation`；`assertAvailable` 先拒 `runtime_scope === "subagent"`（`CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE`），再拒缺失 `input.broker`。
- `readPrimaryAppIdentity`：只读 `CUA_APP_ASSOCIATIONS_META_KEY` 的 `primary`；`appKey` 必须非空并 trim，`displayName` 可选 trim；不取 inline icon PNG（INV-13/14/15）。
- `requestContext`：`session_id` 缺失抛错（INV-05）；`workspaceKey` 依次回落 `workspace_key → workspace_identity → workspace_path`（INV-06）；`clientMode` 缺省 `"desktop-continuous"`，`deliveryKind` 缺省等于 `clientMode`（INV-07）。
- `sendCuaBrokerRequest`：`settled` 单飞，`finish` 首次后 `removeEventListener("abort", onAbort)` + `socket.destroy()`；`MAX_RESPONSE_BYTES` 超限失败（INV-09）；`payload.id !== id` 抛 `"response id mismatch"`（INV-10/12）。

### agent-trace-runtime.ts

- `AgentExecutionTelemetryRuntime`：可变状态只有 `activeWriters` 与 `capacityWarningActive`；`maxActiveWriters` 经 `positiveLimit` 归一（非法回退 5000）；所有 `startXxx` 经 `safeCreate`。
- `startCall`：父上下文取 `activeWriterContext()`，无活跃 writer 时 `context.active()`；`logicalCallId` 写 `"zcode.execution.logical_call_id"`，`startAttempt` 由同一 `ModelCallWriter` 派生。
- `abandonSession`：只对 `writer.state.correlation?.sessionId === sessionId` 调 `abandon("session_shutdown")`；`Set` 迭代中 `delete` 不会跳过元素。
- `startCommand`：`parent` 取 `input.parent.state`，`context/correlation/toolCallId` 全部继承；`safeName` 截断 128。
- `startAttempt`：`provider_*`/`requested_model` 经 `safeString`/`safeEnum`；`retryDelayMs` 经 `finiteNonNegative`；失败回调 `parentWriter.recordAttemptFailed`。
- `safeCreate`：`activeWriters.size >= maxActiveWriters` 时记 `recordCreationDrop(..., "process_capacity")`；`capacityWarningActive` 闩锁只告警一次；`create()` 抛错记 `creation_drop("unknown")` 并降级。
- `TurnWriter`：`lifecycleKeys("agent_turn")`；`finishCompleted` 写 `"zcode.agent_turn.result_type"`（缺省 `"other"`）；`finishUnhandled` 先 `isAbortLike` 判取消。
- `ToolWriter`：`lifecycleKeys("tool_execution")`；`permissionRequested` 保证 `markPermissionRequested` 只 `addEvent` 一次；`setPermissionDecision` 先写 `"zcode.tool_execution.permission_decision"`，仅当曾请求且 `decision !== "not_required"` 才补 `permission_decided`。
- `ModelCallWriter`：`logicalCallId/operation/modelRole` 构造后只读；`startAttempt` 先自增 `attemptCount` 再 `createAttempt(this, input)`；`recordAttemptFailed` 只置 `hadFailedAttempt`。

### app-input-status.tsx

- `InputActiveStatus`：显式 `frameMs` 或 `active=false` 走 `inputActiveStatusRow`（`spinnerFrame(frameMs ?? 0)`），否则挂 `InputActiveStatusContent` 订阅 `useSpinnerFrame(true)`；`contentWidth` 已由父层扣减。
- `InputComposerStatus`：只转交 `{ contentWidth, model, thoughtLevel }`；空 `model` 由 `modelDisplayParts` 回落，空 `thoughtLevel` 由 `inputComposerStatusParts` 用 `"-"` 兜底。
- `inputActiveStatusRow`：`activeStatusContextBadgeWidth` 定预算，`fitStatusContextBadge` 在 `< STATUS_MIN_CONTEXT_WIDTH` 时返回 `undefined`（INV-17）；根 box 高 `ACTIVE_STATUS_HEIGHT`。
- `inputComposerStatusParts`：`modelDisplayParts` + `trim`，空串替换 `"-"`；返回新对象可作 React 依赖（INV-15）。
- `fitComposerStatusParts`：`width = Math.max(1, Math.floor(maxWidth))`；放不下时 `thought` 优先（INV-11），剩余预算 0.4 给 `provider`，`model/provider` 各 `Math.max(1, …)`（INV-12/13）。

### app-model-suggestion-panel.tsx

- `ModelSuggestionPanel`：`visibleModelOptionWindow(models, selectedIndex, MODEL_OPTION_VISIBLE_COUNT)` 取 8 行；`rows` 同时算 `current` 与 `selected`；`panelHeight = 2 + max(1, rows.length)`；key 用 `JSON.stringify(model.ref)`。
- `ModelSuggestionRow`：选择符 2 列 → 模型名 `flexShrink:1,minWidth:1` → `meta`（空则省略）→ 弹性间隔（`provider` 存在才为 2）→ `provider` 固定 `fitted.providerWidth`。
- `modelOptionDisplayParts`：`model.label || model.ref.modelId`（INV-08）、`model.providerLabel || model.ref.providerId`（INV-09）；`meta` 由 `filter(Boolean).join(" | ")`（INV-10/11）。
- `fitModelOptionRow`：`providerColumnBudget` 定预算，`providerWidth` 回写固定列宽；`meta` 仅在 `leftBudget - metaWidth >= MODEL_ROW_MIN_MODEL_WIDTH` 时显示（INV-07）。
- `providerColumnBudget`：`floor(contentWidth * 0.4)` 与扣除选择符/间隔/最小模型名后的剩余取小，再 `Math.max(0, …)`（INV-05/06）。
