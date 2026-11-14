# ZC-FIX-B83（6 文件 / 33 处命中）

> 基线：`d:\code\_annot_baseline\ZC-fix-b83\orig`。
> 改写只删本工程新增的注释行；上游原有注释逐行保留（本批曾误删 `interaction-main.ts` 一行 React/guest 说明，已复原后复跑通过）。

## 1. 验收输出

```text
SUMMARY files=6 rewrittenSegments=35 deletedOwnCommentLines=191 codeTokenDiff=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

三项单独计数：`rewrittenSegments=35`、`deletedOwnCommentLines=191`、`codeTokenDiff=0`。

## 2. 分文件计数

| 文件 | 改写段 | 删自有注释行 | numstat（对基线） |
| --- | ---: | ---: | --- |
| `packages/desktop/scripts/gen-ui-fixture/external-links-checks.ts` | 5 | 28 | +5 / −28 |
| `packages/desktop/scripts/mcp-apps-host-fixture/interaction-main.ts` | 6 | 33 | +6 / −33 |
| `packages/desktop/src/main/desktopNetworkTelemetry.ts` | 6 | 32 | +6 / −32 |
| `packages/desktop/src/main/mcpUserDirectory/legacy.ts` | 6 | 33 | +6 / −33 |
| `packages/desktop/src/main/webRemoteControlSharedHostAttachments.ts` | 6 | 33 | +6 / −33 |
| `packages/shared/src/settings-sync.ts` | 6 | 32 | +6 / −32 |
| **合计** | **35** | **191** | **+35 / −191** |

## 3. 改写要点

### external-links-checks.ts

- `Object.keys(window.zcode).sort()`：四个桥接键先排序再比对，暴露面漂移必须最先失败。
- `wait`：页面内 `requestAnimationFrame` 轮询 + 5000ms 超时，失败汇总 host/guest/shell 三层几何写 `stderr`。
- `click`：`app.focus({ steal: true })` → `win.focus()` → `guest.focus()` 顺序固定，`debugger.attach("1.3")` 只包两次鼠标事件，中键 `buttons=4`。
- `#link-probe`：`position:fixed` 锚点，捕获阶段记录 `linkEvents`/`linkErrors`，`<span>` 提供可聚焦文本。
- `openedOnce`：唯一推进 `expected` 的地方，同时断言 `opened.at(-1)`、`location.href`、`window.starts`。

### interaction-main.ts

- `process.argv.slice(2)`：`root/profile/node/cli` 四参数，`setPath("userData")` 与协议注册必须在 `whenReady` 前。
- `.whenReady()`：`registerSchemesAsPrivileged` 提前注册，`window-all-closed` 空回调，`goodHtml` 用于 finally 复原。
- 失败页面：`throw new Error("fixture startup failure")`，`.then(..., String)` 交给 `assert.match(/handshake timed out/)`。
- `clickControl`：元素矩形中心 + `clickHostPoint`，只投递真实点击不做断言。
- 主题循环：`["light","dark"]` × 四个入口，落盘 `visibility-${theme}-${selector}.json/png`，恢复后比对 `stateBeforeHide`。
- `process.stdout.write("PASS ...")`：必须晚于全部断言，`finally` 恢复页面并 `env.close()`。

### desktopNetworkTelemetry.ts

- `NETWORK_REPORT_INTERVAL_MS`：开发 60s / 生产 300s，模块加载时求值一次。
- `stringifyProperties`：丢弃 `undefined`，其余 `String(value)`，布尔小写保证跨端维度合并。
- `reportNetworkCustom`：无 `globalContext` 直接返回，公共维度先铺、业务键可覆盖，异常只 `console.warn`。
- `reportInterfaceStats`：零样本阶段不带 `*_ms_mean`，`primaryErrorKind` 与 `primaryErrorCount` 成对。
- `flushNetworkReports`：空数组直接返回，逐接口上报不下钻合并，清空由 `flushInterfaceNetworkStats` 完成。
- `noteWebRemoteRelayConnectAttempt`：固定 `WEB_REMOTE_RELAY_INTERFACE`，耗时归一到非负整数，只记录不重试。

### mcpUserDirectory/legacy.ts

- `extractBalancedJson`：`depth/inString/escaped` 三态扫描，字符串内括号不计深度，未闭合返回 `null`。
- `readLegacyCommonMcpFromStoreJson`：`storeRoot["mcp-storage"]` 二次 `JSON.parse`，逐层 `isRecord`，服务器表非空才算命中。
- `extractLegacyCommonMcpFromText`：`searchStart` 前进一个键长，解析失败继续下一个 `mcp-config`。
- `readLegacyCommonMcpFromLevelDbDir`：只读 `.ldb/.log`，文件名倒序，`latin1` 保留原始字节，单文件失败跳过。
- `buildLegacyCommonMcpStorageCandidates`：显式目录 → `store.json` → 两种运行形态分区，`Set` 去重保序。
- `migrateLegacyCommonMcp`：按 `endsWith("store.json")` 分派，全部落空返回零计数不抛错，不写存储。

### webRemoteControlSharedHostAttachments.ts

- `AttachContext`：`kind` 决定路径，`workspaceIdentity` 是隔离唯一依据，`workspacePath` 只兜底。
- `Attachment`：`entryId` 用于幂等、`attachmentId` 用于释放，`port` 所有权返回后转移。
- `SharedHostError`：五个错误码区分缺失、身份与跨窗口冒用。
- `attachLocalHost`：`BrowserWindow.fromId(...).webContents.id` 换算，查不到抛 `DESKTOP_HOST_MISSING`，`port1` 登记后接管。
- `attachWorkspaceHost`：会话 → 身份检查顺序不可换，`workspaceKey` 取身份。
- `releaseAttachment`：先 `delete` 再 `close` 防重入，关闭失败只 `warn`。

### shared/settings-sync.ts

- `SettingsSyncCategory`：五类封闭枚举，改名等于数据迁移。
- `ClaudeAgentsFileMigrationStatus`：`sourceExists`/`targetExists`/`supported` 三者独立。
- `SkillSkipReason`：`targetExists` 本作用域、`sameNameExists` 跨来源根。
- `SourceRootSummary`：`discoveredCount - importableCount === skippedCount`。
- `Selection`：四类路径各自携带，`sourceScope`/`targetScope` 分开表达。
- `ProgressEvent`：三项计数之和等于 `completed`，否则进度越界。
