# ZC-FIX-B105（6 文件 / 33 处命中）

> 基线：`d:\code\_annot_baseline\ZC-fix-b105\orig`。

## 1. 验收输出

```text
SUMMARY files=6 rewrittenSegments=33 deletedOwnCommentLines=132 codeTokenDiff=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

三项单独计数：`rewrittenSegments=33`、`deletedOwnCommentLines=132`、`codeTokenDiff=0`。

## 2. 分文件计数

| 文件 | 改写段 | 删自有注释行 | numstat |
| --- | ---: | ---: | --- |
| `packages/ui/src/app-shell/useAppChromeState.ts` | 3 | 10 | +3 / −10 |
| `packages/ui/src/components/TaskTitleOverflowText.tsx` | 5 | 21 | +5 / −21 |
| `packages/ui/src/global-notice/globalNoticeStore.ts` | 6 | 25 | +6 / −25 |
| `packages/ui/src/highspeed/highspeedShare.ts` | 7 | 26 | +7 / −26 |
| `packages/ui/src/lib/toolCallTree.ts` | 6 | 24 | +6 / −24 |
| `packages/ui/src/mentions/mentionMarkdown.ts` | 6 | 26 | +6 / −26 |
| **合计** | **33** | **132** | **+33 / −132** |

## 3. 改写要点

### useAppChromeState.ts

- `readFinitePositivePx`：仅 `number && Number.isFinite && > 0` 才 `Math.round`，否则 `null` 交给平台默认。
- `resolveLegacyReadyVersionFromState`：仅 `update-downloaded` 返回 `payload.version`，其余 `null` 清旧 ready。
- `useAppChromeState`：`workspaceAbsPath` 只用于日志，返回值只读快照加可写 `sidebarContainerRef`。

### TaskTitleOverflowText.tsx

- `createMaskKeyframe`：同时写 `maskImage` 与 `webkitMaskImage`，`offset` 由调用方换算。
- `TaskTitleOverflowText`：`as` 默认 `"p"`、`title` 改为 `_nativeTitle` 丢弃，`textRef`/`originalTextRef` 分工。
- `updateOverflow`：`originalTextElement.scrollWidth` 对 `textElement.clientWidth`，三字段相等复用旧对象。
- `startMarquee`：`reducedMotionQuery?.matches` 早退，`totalDuration` 与 `movementEndOffset` 切分移动/停留。
- `scheduleMarquee`：`window.setTimeout(startMarquee, marqueeHoverDelayMs)`，重复进入重置计时。

### globalNoticeStore.ts

- `GlobalNoticeEnvelope`：`noticeId`/`dedupeKey`/`persistencePolicy` 的契约与缺省后果。
- `isLegacyHighspeedMockNotice`：`highspeed-share` + `hsc_mock_` 前缀唯一判据。
- `readState`：版本不符/解析失败回 `emptyState`，`latest` 清理失败不打回空态。
- `createGlobalNoticeStore`：`now` 缺省 `Date.now`，`listeners` 用 `Set`。
- `persist`：先写存储、失败只回调，`listener` 必须收到通知。
- `getVisible`：`expiresAt`/`dismissedUntilByKey`/`requiresPublishAfterDismissalByKey` 三者任一命中返回 `null`。

### highspeedShare.ts

- `isHighspeedShareEligible`：四项正数校验 + `savedDurationMs >= 0`，严格 `>` 判 `MIN_HIGHSPEED_SHARE_SPEEDUP`。
- `highspeedSpeedup`：`Math.max(durationMs, 1)` 防除零，保留一位小数。
- `highspeedSavedPercent`：`Math.min(99, ...)` 压上限。
- `copyHighspeedCardImage`：`HIGHSPEED_CARD_IMAGE_SIZE`、`detectHighspeedCardDarkTheme`、`escapeXml`。
- `buildHighspeedShareNotice`：毫秒事实值、固定 `dedupeKey`、一天过期/冷却。
- `isHighspeedShareNoticePayload`：类型守卫，不校验数值合法性。
- `resolveHighspeedShareNoticeMetrics`：毫秒优先、秒级 ×1000，合成 TPS 仅供资格校验。

### toolCallTree.ts

- `areUnknownValuesEqual`：`Object.is` 快路径 + `budget.remaining` 限额。
- `areTaskChatToolCallsRenderEqual`：标量先比，四个大字段各自 500 预算。
- `collectPreviousNodes`：后写覆盖先写，只读遍历。
- `areNodeArraysEqual`：长度 + 逐项引用相等。
- `finalizeToolCallTreeNode`：`previousNode.toolCall` 与子数组同时复用才返回旧节点。
- `reconcileToolCallTree`：索引 → 草稿 → 挂父子 → 整组比较。

### mentionMarkdown.ts

- `normalizeMarkdownDestination`：显式前缀/协议直接返回，裸路径补 `./`。
- `normalizeFileMentionRelativePath`：目录去掉重复尾斜杠后补一个 `/`。
- `buildFileMentionMarkdown`：路径规整 → 目标归一 → 双端转义。
- `buildMentionMarkdown`：按 `category` 分派 files/skills/plugins/subagents。
- `parseInlineMentionTokens`：`lastIndex` 归零，按 `$`/`/`/`@`/`#` 分派。
- `parseMentionMarkdown`：`lastIndex` 归零，链接间文本交给内联解析。
