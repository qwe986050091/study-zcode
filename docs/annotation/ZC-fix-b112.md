# ZC-FIX-B112（6 文件 / 28 处命中，实际改写 29 段）

> 基线：`d:\code\_annot_baseline\ZC-fix-b112\orig`（改写前的当前工作树）。
> 本批按命中处数降序处理，同文件多处一次改完。

## 1. 验收输出

```text
SUMMARY files=6 rewrittenSegments=29 deletedOwnCommentLines=144 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

三项单独计数：`rewrittenSegments=29`、`deletedOwnCommentLines=144`、`codeTokenDiff=0`。
代码删除、上游注释删除、字符串字面量删除均为 0；多出的 1 段来自 `WorkspaceHelpMenuButton.tsx` 中落在 JSX 子节点、会渲染成可见文本的 `//` 行（不在审计的 ≥3 行命中里，但同属本次要清的自有注释）。

## 2. 分文件计数

| 文件 | 改写段 | numstat（对基线） |
| --- | ---: | --- |
| `apps/zcode-cli/packages/adapters/src/commands/index.ts` | 5 | +10 / −26 |
| `apps/zcode-cli/packages/adapters/src/plugins/mcp.ts` | 5 | +9 / −26 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/protocol.ts` | 5 | +10 / −25 |
| `packages/zcode-server-cli/src/runtime/serviceInstallation.ts` | 5 | +8 / −24 |
| `packages/web/src/auth/oauthStateCodec.ts` | 5 | +9 / −24 |
| `packages/ui/src/WorkspaceHelpMenuButton.tsx` | 4 | +4 / −19 |
| **合计** | **29** | **+50 / −144** |

## 3. 改写要点

### commands/index.ts

- 类头：`disabledPaths` 构造期 `resolve` 成 `ReadonlySet`，`discoverCommands`/`loadCommand` 共用同一次发现结果；`throwIfAborted` 在每层 root/文件循环前执行，`parseCommand` 内不重复检查。
- `discoverCommands`：`resolve(request.workingDirectory)` → `priority` 升序 `toSorted` → `selected` 保留先到项、后来者只推 `custom_command_duplicate_name`；禁用判断必须在 `totalDiscovered++` 之前。
- `loadCommand`：先 `discoverCommands` 再 `normalizeCommandName` 匹配；`stat().size` 与 `maxBytes` 决定 `readFirstBytes`/`readFile`，`sizeBytes` 恒为真实大小，`content` 先 `stripFrontmatter` 再 `trim`。
- `commandFilesUnderRoot`：`!isDirectory()` 与 `isNotFoundError` 返回空且不写诊断，其余异常才推 `custom_command_scan_failed`。
- `scanMarkdownFiles`：`depth > MAX_SCAN_DEPTH` 早退；符号链接 `stat` 失败 `continue`；只有 `COMMAND_EXTENSION` 普通文件入结果，`readdir` 失败降级 warning。

### plugins/mcp.ts

- `loadPluginMcpServerDefinitions`：先 `.mcp.json` 后 `manifest.mcpServers`，`{ ...fromFile, ...fromManifest }` 的覆盖方向不可反。
- `resolvePluginMcpServers`：`createVariableContext` 一次快照；`PluginVariableError` 映射 `plugin_variable_missing`，其余映射 `plugin_mcp_server_disabled`，成功项不回滚。
- `loadMcpServersFromSpec`：`undefined`/`string`/数组/对象四路分派；`resolveInside` 返回 null 只推 `plugin_component_path_invalid` 且不读文件；数组 `Object.assign` 后者覆盖。
- `normalizeMcpServersShape`：非对象推 `plugin_mcp_invalid`；`isRecord(value.mcpServers)` 才取内层；`filter(isRecord)` 丢非法条目。
- `resolveMcpServerConfig`：`isRecord` → `type`（显式或 `inferMcpType`）→ `SUPPORTED_MCP_TYPES` → `baseConfig` 一次解析；stdio 用 `loaded.id` 覆写 `ZCODE_PLUGIN_ID_ENV_KEY`；http 先判 `oauth` 冲突再判 `findOfficialMcpReservedHeaders`。

### mcp-ui/protocol.ts

- `readMcpUiResource`：`parseParams` → `requireSession` → `mcpUiInstances.validate` → `binding.resourceUri === params.uri` 的比对不可省；`-32001`/`-32602` 在 `translateScopeError` 之外抛出。
- `callMcpUiTool`：只做参数/会话校验与错误翻译，授权与 `session+instance.token+callId` 幂等查重在 `handlers.callTool`；不写 conversation。
- `cancelMcpUiToolCall`：`{cancelled:false}` 是幂等成功；abort 在 handlers 内，不返回结果。
- `translateScopeError`：四类领域错误的 `data` 字段与顺序固定，未知错误 `throw error` 原样上抛，不兜底成 `-32602`。
- `openMcpUiInstance`：`waitForMcpAppConnection` 后必须重取快照并比对 `record`/`identity`/`generation`；`!active.watched` 才登记 `onActivity`、`onMcpAppConnectionInvalidated`、`abort` 清理三件事。

### serviceInstallation.ts

- `unregisterInstalledService`：先 `unregisterService` 再清目录，主描述符不存在也要继续扫别名与旧版；不返回清理结果。
- `resolveLegacyServiceRegistration`：`kind` 与 `join(serviceDir, `${kind}.service`)` 固定；descriptor 的 `command`/`args` 与实际注册一一对应。
- `currentServicePlatform`：只归为 darwin/linux/win32，其余走 task-scheduler。
- `legacyDescriptorBelongsToRoot`：读失败 false → 字面匹配 → `extractServerRoot` → `resolveCanonicalServerRoot` 比较，规范化抛错视为不匹配。
- `unregisterRootScopedAliasServices`：`extension`/`legacyEntry` 先定；跳过当前描述符、旧版条目、非平台后缀；归属成立且能取到名称才 `unregisterService` + `rm(force)`。

### oauthStateCodec.ts

- `encodeBase64Url`：`TextEncoder` → 二进制串 → `btoa` → `+→-`/`/→_`/去 `=`；顺序与填充规则必须与 `decodeBase64Url` 对称。
- `parseOAuthState`：只保留 `nonce`/`app_return_to`/`return_to`，`nonce` 空即 null，其余字段丢弃。
- `resolveSafeAppReturnTo`：路径白名单 → 同源比较（`resolveAllowedAppReturnOrigin`）→ 分享只回 `pathname`、应用只保留 `APP_RETURN_QUERY_ALLOWLIST`。
- `buildWebRemoteOAuthRedirectUri`：两侧路径与 `resolveSafeAppReturnTo` 全通过才覆写 `search` 并清 `hash`。
- `buildReturnToCallbackUrl`：`isTrustedDevReturnTo` + 非空 state 才继续；`code`/`error` 非空才写入，`state` 最后覆盖写入。

### WorkspaceHelpMenuButton.tsx

- `helpMenuActions`：`createHelpMenuActionHandlers({ platform, intl, openSubmit })` 每次渲染重建，`openSubmit` 只订阅动作字段。
- `DropdownMenu`：受控 `open`/`onOpenChange`；触发器 `asChild` + `ControlHintTooltip` + `[app-region:no-drag]`，`aria-label` 与 `data-testid` 同源。
- `DropdownMenuContent`：`min-w-0 w-max` 与 `[&_[data-slot=dropdown-menu-item]]:pr-6` 只作用于本菜单。
- 删除 JSX 子节点里 5 行 `//` 文本（会渲染成可见文案），改在 `return (` 前说明桌面分组的渲染条件与动作来源。

## 4. 复检

- `residual_short_comment_runs=0`（6 个文件均无「连续 ≥3 行、每行 <25 字符、无标识符」的注释）。
