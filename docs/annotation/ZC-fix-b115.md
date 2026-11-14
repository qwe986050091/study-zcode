# ZC-FIX-B115（4 文件 / 94 处命中，实际改写 94 段）

> 基线：`d:\code\_annot_baseline\ZC-fix-b115\orig`（改写前的当前工作树，4 文件均为 FIX-B114 顺延未动文件）。
> 本批为 B114 顺延的 4 个文件，按命中数降序处理：`RemoteConnectionDialogContent.tsx` 53、`useBuiltinAgentCli.ts` 43、
> `SettingsPageParts.tsx` 18、`replaceableConversationTransport.ts` 13。

## 1. 验收输出

```text
SUMMARY files=4 rewrittenSegments=94 deletedOwnCommentLines=132 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

三项单独计数：`rewrittenSegments=94`、`deletedOwnCommentLines=132`、`codeTokenDiff=0`。
代码删除、上游注释删除、字符串字面量删除、非注释新增均为 0；语法校验 0 失败。

## 2. 分文件计数

| 文件 | 改写段 | numstat（对基线） | 内文率（函数体内中文注释行 ÷ 代码行） |
| --- | ---: | --- | ---: |
| `packages/ui/src/RemoteConnectionDialogContent.tsx` | 46 | +57 / −57 | 24.15% |
| `packages/ui/src/hooks/useBuiltinAgentCli.ts` | 29 | +44 / −44 | 14.16% |
| `packages/ui/src/settings/SettingsPageParts.tsx` | 11 | +18 / −18 | 4.92% |
| `packages/ui/src/v4/replaceableConversationTransport.ts` | 8 | +13 / −13 | 3.14% |
| **合计** | **94** | **+132 / −132** | 全仓 17.32%（80,011 / 461,886，中位 8.45%） |

## 3. 改写要点

### useBuiltinAgentCli.ts

- 顶部模块说明改成点名 `useBuiltinAgentCli`、`getStatus`、`installProvider`、`simulateInstallProgress`、`update` 的职责链；
  原文「为什么进度是模拟的」保留原因但补上 `createInstallProgressPlan` 与 `pauses` 的具体承载处。
- `INSTALL_TEMPLATES` 段写明「模板只改 `stageDurationRatioRanges` 与停顿区间」，并点明 `pickInstallTemplate`
  返回的是数组元素引用，改它会污染后续每次安装。
- `pickInstallStageDurations` 写明第四段取 `1 - 前三段` 并夹到 `minStage4Ratio`，`rawDurations[3]` 吸收 `Math.floor` 误差；
  删掉这段误差吸收会让四段之和偏离 `totalDurationMs`。
- `simulateInstallProgress` 段把「每轮最多 `progress += 1`」「剩余时长与 `INSTALL_PROGRESS_TICK_MS` 取小」
  「`elapsed >= plan.totalDurationMs` 才 break」逐条落到标识符上，并写明无超时兜底依赖 `plan.totalDurationMs` 上界。
- `installProvider` / `uninstallProvider` 段写明 `canMutateProvider` → `requiresBuiltinAgentCliInstall` → `isEnabled`
  的固定顺序、`nextEnabledProviders` 必须全量构造、`finally` 必须复位进行中标记与进度表。

### RemoteConnectionDialogContent.tsx

- 头部 `INV` 表之外的模块说明改成点名三个导出函数：`useRemoteBoundaryAcknowledgement`、
  `getRecentRemoteWorkspaceHistory`、`formatDeviceCardMeta`；连接生命周期归 `useRemoteConnectionForm`。
- 已读短路写明 `remoteBoundaryIntroAcknowledgedVersion === 1` 必须放在 `pendingRequest` 判断之前；
  `useConfirmDialogStore` 同一时刻只持一个请求，占用必须走 `onBlocked`。
- 最近目录：`.filter(Boolean)` 丢弃尾部分隔符空段、`.sort` 只比 `lastOpenedAt`、函数内不做 `slice`，
  三处都补了「改错后哪条断言失效」。
- 设置步骤 props 段逐条落到 `focusCredentials`、`availableKinds`、`sshAuthMethod`、`assetInstallMode`、
  `dockerAvailable` 三态、`currentRuntimeOptionsError`、`fieldErrors`、`validationAttempt`、`addingDevice`、`aliasFocusToken`。
- 目录步骤段落到 `deviceName`/`profileName`/`deviceVersion`、`quickOpenPaths`/`quickOpenEntries`/`quickOpenGroups`、
  `navigationRevision`、三个同步开关与 `canShowRemoteSyncActions`/`canSyncRemoteSkills`/`canSyncRemoteMcp`/`canSyncRemotePlugins`。

### SettingsPageParts.tsx

- 模块说明改为列出导出面组件；`SETTINGS_FRAME_CONTENT_CLASSNAME` 的 `max-w-4xl` 与 `mx-auto` 说明共用同一内容列。
- `ThemeSelect` 点明选项来自 `CODE_PREVIEW_THEME_OPTIONS`，`onValueChange` 需收窄为 `BundledTheme`。
- `ThemePreviewCard` 点明 `previewThemeStyle` 固定 `--color-background` 与 `--color-card`，`isActive` 只切角标类名。
- `SettingsRow` 写明 `controlLayout` 为 wide 时 `detail` 换行；`SettingsGroupCard` 的 `py-0`/`px-0` 与
  `SettingsRow` 的 `first:border-t-0` 配对。
- `SettingsBadge`、`SettingsRangeControl`、`getThemeOptionLabel` 分别点明无交互、原生 `input type=range`、
  单次 `find` 加 `value` 回退。

### replaceableConversationTransport.ts

- 类说明写明 `current`、`transportBySubscriptionId` 与四组监听集合归本实例所有；`onRuntimeLifecycle`
  在 `current.onRuntimeLifecycle` 缺失时由构造器置 undefined，作为唯一能力信号。
- `replace` 段写明先 `detachCurrentListeners()` 再按 `owner !== previous` 释放旧订阅，
  `unsubscribeIgnoringFailure` 用 `void` 不 await，避免断线 RPC 挂起阻塞换代。
- `activate`/`resync`/`sendCommand` 分别写明查映射与直连 `this.current` 的差别；
  `onFrame` 段写明 `frameListeners.size === 0` 时解绑并置 null、`bindFrameListener` 逐帧遍历集合。
- `bindCurrentListeners` 与各 `bind*Listener` 的空值/重复判断落到具体字段。

## 4. 断点核对

- 复跑命令：`node zc-verify.mjs --rewrite ZC-fix-b115`。
- 首轮命中 1 处越界删除：`packages/ui/src/hooks/useBuiltinAgentCli.ts :: 又能让四阶段节奏只由阶段曲线本身决定。`
  该行是上游 `Bugfix:` 注释块的第 3 行（`git show HEAD:` 中存在），被当成本工程新增行改写；
  已用同一行文本原样恢复，`upstreamCommentDeleted` 归 0，复跑全绿。
- 恢复后该文件残留 1 条 `W` 判定（同一上游行），不属于本工程新增注释，不计入清注水缺口。
- 4 个文件在快照之后均只有本批写入，对基线 numstat 合计 +132 / −132，与 `deletedOwnCommentLines` 一致，
  不存在「已插入未写索引」或反向遗漏。
