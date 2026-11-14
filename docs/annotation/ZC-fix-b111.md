# ZC-FIX-B111（6 文件 / 30 处命中）

> 基线：`d:\code\_annot_baseline\ZC-fix-b111\orig`。

## 1. 验收输出

```text
SUMMARY files=6 rewrittenSegments=30 deletedOwnCommentLines=141 codeTokenDiff=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

三项单独计数：`rewrittenSegments=30`、`deletedOwnCommentLines=141`、`codeTokenDiff=0`。

## 2. 分文件计数

| 文件 | 改写段 | 删自有注释行 | numstat |
| --- | ---: | ---: | --- |
| `packages/ui/src/root/GlobalDatabaseStartupLoading.tsx` | 5 | 23 | +5 / −23 |
| `packages/ui/src/settings/mcpSettingsShared.ts` | 5 | 24 | +5 / −24 |
| `packages/ui/src/settings/RemoteSkillSyncSelectionList.tsx` | 5 | 24 | +5 / −24 |
| `packages/ui/src/TodoPanel.tsx` | 5 | 24 | +5 / −24 |
| `packages/ui/src/ToolCallBlocks/renderers/search.tsx` | 5 | 23 | +5 / −23 |
| `packages/ui/src/v4/ConversationQuotaBanner.tsx` | 5 | 23 | +5 / −23 |
| **合计** | **30** | **141** | **+30 / −141** |

## 3. 改写要点

### GlobalDatabaseStartupLoading.tsx

- 组件入参：只有 `state` 与 `onRetry`/`onCopy`/`onExit`；`now` 每秒刷新、`copyStatus` 三态（`copied`/`copyFailed`/`null`），组件不主动发请求。
- 计时 effect：仅 `!failed && visible` 启动 `setInterval(() => setNow(Date.now()), 1000)`，依赖 `[failed, visible]`；清理 `clearInterval` 防止跨状态泄漏。
- `elapsed`：失败后冻结在 `state.updatedAt`，运行期取 `Math.max(now, state.updatedAt)`，再 `Math.max(0, ...)` 夹非负（时钟回拨不显示负数）。
- `copy`：`JSON.stringify(state, null, 2)` 传完整快照；`catch` 只置 `copyFailed` 且不 rethrow，`state.attemptId` 变化时由另一个 effect 清回 `null`。
- `startupLabelId`：优先级 `failed` → `!visible` → `finishing`（`starting_services`/`ready`/`finalDatabase && ready`）→ `waiting` → `saving` → `initialize`/`upgrading`，顺序反转会把失败态显示成静默或收尾。

### mcpSettingsShared.ts

- `EMPTY_FORM`：`scope` 固定 `"zcodeagentmcp"`、`storageLevel: "user"`、`type: "stdio"`，新增字段必须同时改 `FormState` 与 `serverToForm`/`jsonDraftToForm`。
- `serverToForm`：先按 `cfg.type === "sse"/"streamableHttp"` 显式分流，再看 `cfg.command` 推断 `stdio`，否则 `http`；`args` 用 `join(" ")`、`env`/`headers`/`oauth` 用 `JSON.stringify(..., null, 2)`、非法 `protocolVersion` 归一为空串。
- `formToConfig`：`parseTimeoutMs` 只接受有限正数并向下取整；`form.args.trim().split(/\s+/)` 不产出空元素；`oauth`/`protocolVersion` 只在非空时展开写入。
- `jsonDraftToForm`：`{ mcpServers: { ... } }` 包装内 `entries.length !== 1` 直接抛错；裸配置要求恰好一个对象条目且不含 `type`/`command`/`url`；配置非对象或名称为空都抛错。
- `isMcpProtocolVersion`：仅放行三个合法值，否则 `serverToForm` 的协议下拉会显示空白。

### RemoteSkillSyncSelectionList.tsx

- `shouldToggleRemoteSkillSyncCardSelection`：`exists` 为 true 直接返回 false；`target` 为空或缺少 `closest` 视为可切换；`closest.call(target, REMOTE_SKILL_SYNC_CARD_ACTION_SELECTOR)` 命中按钮/`input`/`label` 等交互控件时返回 false，避免点勾选框再触发整卡。
- 组件入参：`rows`/`selectedIds`/`onToggle` 由调用方持有，`emptyMessageId` 默认 `settings.skills.remoteSync.empty`，组件只上报 `(skillId, checked)`。
- `toggleDescription`：先 `new Set(current)` 再 `has`/`delete`/`add` 并返回新集合；原地修改 `current` 不会换引用，描述不会展开。
- 空列表：`rows.length === 0` 只渲染 `intl.formatMessage({ id: emptyMessageId })`，容器与卡片共用 `border-border bg-surface`，避免空态跳变。
- `handleCardClick`：先判 `shouldToggleRemoteSkillSyncCardSelection({ exists: row.exists, target: event.target })`，允许后 `onToggle(row.candidate.id, !selected)`；`selected` 由 `!row.exists && selectedIds.has(...)` 得出，已存在条目永远提交 `false`。

### TodoPanel.tsx

- `todoStatusIndicatorClasses` / `todoStatusContentClassesStreaming` / `todoStatusContentClassesIdle`：左侧状态点与文本样式分开维护；非运行期把 `in_progress` 从 `animated-gradient-text` 降级为 `text-foreground`，否则任务停止后仍显示 loading。
- `TodoPanel`：`!plan || plan.length === 0` 早退；`completedCount === plan.length` 时隐藏（provider 先标完成、稍后才推 `task_complete` 的间隙）；`visiblePlan` 只留未完成项；`activeStep` 按 `in_progress` → 非 `completed` → 末项三级顺序推导。
- `toggleOpen`：只做 `setIsOpen((current) => !current)`；标题按钮与右侧图标按钮共用，图标按钮先 `event.stopPropagation()` 再调用，否则一次点击切换两次。
- 修复 JSX 文本污染：删除 `<PlanHeader>` 前 5 行 `//` 子节点文本（会渲染成可见文案），改在 `return (` 前写 `PlanHeader` 注释，说明展开逻辑收敛到标题 `button`（`aria-expanded={isOpen}`）与右侧按钮、`isOpen` 时 `!pb-1`、动作区 `shrink-0`。

### search.tsx

- `SEARCH_TOOL_ICON`：模块加载期只求值一次，`SearchToolCallBlock`/`ToolSearchToolCallBlock` 共用为 `ToolLayout` 的 `icon`；挪进组件体会每次渲染新建元素。
- `getSearchPrimaryText`：三级顺序不可调换——`string` 输入直接 `trim`；否则遍历 `input.parsed_cmd`，`list_files` 取 `input.cwd` 并去掉尾部 `/`，`search`/`grep`/`glob` 按 `item.pattern` → `item.query` → `item.path`；最后才用 `search_query`/`searchQuery`/`query`/`pattern`/`path`/`url`/`prompt`/`target`/`name` 固定键序（`url` 在 `prompt` 前，避免 WebFetch 摘要遮住待确认地址）。
- `ToolSearchToolCallBlock`：`/^select:(.+)$/i` 命中后按逗号切分、`trim`、`filter(Boolean)`、`join(", ")`；`label` 为空回退 `chat.toolCall.search.tools`；`kindLabelOverride=""` 与 `hideSnapshotNotice` 关闭类型标签和快照提示。
- `SearchToolCallLayout`：`primaryText` 用 `useMemo([searchPrimaryText])` 缓存 `<span className="truncate">`；`kindLabel` 按 `isRunning` 取 `searching`/`kind.search`；`statusTooltip` 仅 `toolCall.status === "failed"` 时取 `errorText`；`content` 恒为 `null`。
- 修复 JSX 文本污染：删除 fragment 内 4 行 `//` 子节点文本，改在 `return (` 前写快照提示挂载条件（`hideSnapshotNotice`、`toolCall.snapshotRefs ?? []`、闭包转发 `toolCall.toolId`）。

### ConversationQuotaBanner.tsx

- `MESSAGE_IDS`：`Record<SessionQuotaBannerKind, string>` 穷尽映射，不补键即编译失败；不含 `provider-limited` 的服务端直出文案，也不含 `model-very-low`/`concurrent-limit` 细分。
- `resolveMessageId`：`model-very-low` 按 `state.quotaPeriod` 细分（`daily`/`one_time`/其余），`concurrent-limit` 按 `state.concurrentLimitReason === "retry-exhausted-busy"` 细分，其余才查表，`kind` 为空返回 `""`。
- 组件：渲染门槛 `state.visible && state.kind`；`message` 优先 `state.providerLimitedMessage`，否则 `resolveMessageId` + `formatMessage`，`remaining` 为 `null` 用 `formatTokenCount(null)` 的 `"-"`，否则 compact 且 `maximumFractionDigits: 1`，`percent` 走 `formatPercent`；`showBillingDiscountBadge` 要求 `onUpgrade` 存在且 `billingDiscountActive === true`。
- 可见性上报 effect：`!onShown || !state.visible || !bannerRef.current` 早退；`intersecting` 缓存观察器状态，`report` 仅在交叉且 `document.visibilityState === "visible"` 时调 `onShown()`；`visibilitychange` 复用 `report`，清理必须同时 `observer.disconnect()` 与 `removeEventListener`。
- `message` 构建：`provider-limited` 直出服务端措辞，其余走模板；`remaining` 只在 `state.remainingTokens !== null` 时格式化。

## 4. 工具修正（本批发现）

- `zc-verify.mjs` 的 `--only` 参数过滤在未传 `--only` 时会把 `args[0]` 一起丢掉，导致 `--rewrite` 退化成普通模式；已改为 `onlyIdx < 0 || (...)`。
- `tokensOf` 对 `JsxText` 中整行 `//` 文本按注释剔除、剩余行逐行 `trim` 后比对：这类行会被渲染成可见文本，删除属于修 bug；本批两处 JSX 污染因此仍保持 `codeTokenDiff=0`。
