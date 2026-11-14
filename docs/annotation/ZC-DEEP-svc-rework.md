# ZC-DEEP-svc-rework

> 阶段：services 线从「密度达标」转入「关键文件补深」。
> 快照：`d:\code\_annot_baseline\ZC-deep-svc-rework\orig`（16 文件，改造前，相对 HEAD `e6ff6fab`）。
> 脚本：`zc-inner.mjs`（内文率）、`zc-verify.mjs --rewrite`（改写批校验）、`deep-density.mjs`（总密度回归）。

## 1. 内文率指标（本轮新增）

**定义**：函数体内部「整行中文注释行数」÷ 函数体内部「代码行数」。

- 函数体：函数声明、方法、构造函数、getter/setter、函数表达式、箭头函数的 Block；嵌套函数取行集合的并集，同一行不重复计数。
- 整行注释：该行非空白字符全部落在注释范围内；行尾注释不计（与 `deep-density` 口径一致）。
- 中文注释：注释文本含 CJK 字符；英文注释只算注释、不进分子。
- 代码行：该行存在任一非空白字符落在注释范围之外；空行不计。
- 注释范围取自 AST 的 leading/trailing trivia（含标点 token），**不是裸 scanner**。

**为什么改口径**：初版用 `ts.createScanner` 顺序扫描注释。scanner 不携带解析器状态，遇到模板字面量 `` `a ${x}` `` 之后会与解析器失步，把后续大量 `//` 行当成字符串内容，导致「第一个模板字面量之后」的注释全部漏计。修正前 `zcodeAgentService.ts` 测得 5/7532（0.07%），修正后同一份文件为 1908/5375（35.50%）；services 全量低于 15% 的文件从 238 个降为 116 个。**本文件后续所有数字均为修正后口径。**

```bash
node _annot_baseline/zc-inner.mjs --roots packages/services/src --threshold 15 --out inner-services.json
node _annot_baseline/zc-inner.mjs --roots packages/services/src,apps/zcode-cli/packages \
  --only <文件列表> --threshold 15 --fns 120
```

## 2. services 全量实测

| 时点 | 文件数 | innerCode | innerZh | 内文率 | <15% 文件 | 中位数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 改造前 | 466 | 86,539 | 21,054 | 24.33% | 116 | 23.04% |
| 改造后 | 466 | 86,539 | 22,258 | 25.72% | 114 | 23.68% |

文件数与代码行数不变（本轮零代码改动）；services 内新增中文注释 1,204 行。低于 15% 的文件只减少 2 个（`legacyZCodeConfigProviderReader.ts`、`skillsService.ts`），其余 6 个点名文件在修正口径下本已 ≥15%，本轮按「低分函数清零」补深，不改变文件级达标状态。

### 2.1 改造前低于 15% 的文件（116 个）

| 路径 | innerZh/innerCode | 内文率 |
| --- | ---: | ---: |
| packages/services/src/bot-project-runtime/contract.example.ts | 0/3 | 0.00% |
| packages/services/src/bots/groupReply.ts | 0/7 | 0.00% |
| packages/services/src/bots/messages.ts | 0/10 | 0.00% |
| packages/services/src/bots/modelSelectionHelpers.ts | 0/6 | 0.00% |
| packages/services/src/client-scenes/clientScenesService.ts | 0/8 | 0.00% |
| packages/services/src/collection.ts | 0/24 | 0.00% |
| packages/services/src/conversation-share/conversationShareIntegrity.ts | 0/102 | 0.00% |
| packages/services/src/cua-permission-broker/cuaAgentAdmissionGate.ts | 0/66 | 0.00% |
| packages/services/src/cua-permission-broker/cuaHelperInstaller.ts | 0/32 | 0.00% |
| packages/services/src/cua-permission-broker/stableCuaTransport.ts | 0/31 | 0.00% |
| packages/services/src/descriptors.ts | 0/3 | 0.00% |
| packages/services/src/git/repo/gitCheckpointStore.ts | 0/75 | 0.00% |
| packages/services/src/memoryDiagnostics.ts | 0/6 | 0.00% |
| packages/services/src/model-provider/accountRequestAuthService.ts | 0/13 | 0.00% |
| packages/services/src/oauth/callbackAttribution.ts | 0/13 | 0.00% |
| packages/services/src/oauth/runtimeConfig.ts | 0/5 | 0.00% |
| packages/services/src/plugin-ui-bridge/contract.example.ts | 0/38 | 0.00% |
| packages/services/src/plugins/officialPluginCache.ts | 0/34 | 0.00% |
| packages/services/src/plugins/pluginsService.ts | 0/71 | 0.00% |
| packages/services/src/project-catalog/contract.example.ts | 0/3 | 0.00% |
| packages/services/src/project-catalog/selection-id.ts | 0/3 | 0.00% |
| packages/services/src/project-storage/contract.example.ts | 0/3 | 0.00% |
| packages/services/src/project-workspace-navigation/contract.example.ts | 0/3 | 0.00% |
| packages/services/src/project/contract.example.ts | 0/10 | 0.00% |
| packages/services/src/providers/api/requestIdHeaders.ts | 0/27 | 0.00% |
| packages/services/src/runtime-tools/clientPlatform.ts | 0/16 | 0.00% |
| packages/services/src/session/claude-native/jsonLineRecord.ts | 0/10 | 0.00% |
| packages/services/src/session/legacyTaskSessionFile.ts | 0/6 | 0.00% |
| packages/services/src/session/tasksDatabase/prepared.ts | 0/13 | 0.00% |
| packages/services/src/setting/observableSettingService.ts | 0/18 | 0.00% |
| packages/services/src/skill-sync/skillSyncErrors.ts | 0/9 | 0.00% |
| packages/services/src/startup-storage/contract.example.ts | 0/4 | 0.00% |
| packages/services/src/storage/adapters/rootsResolver.ts | 0/22 | 0.00% |
| packages/services/src/subagents/subagentStorage.ts | 0/46 | 0.00% |
| packages/services/src/task-facts/contract.example.ts | 0/3 | 0.00% |
| packages/services/src/task-groups/contract.example.ts | 0/3 | 0.00% |
| packages/services/src/window-project-directory/contract.example.ts | 0/7 | 0.00% |
| packages/services/src/zcode-agent/automationToolPolicy.ts | 0/14 | 0.00% |
| packages/services/src/zcode-agent/zcodeAgentErrors.ts | 0/10 | 0.00% |
| packages/services/src/feedback/feedbackLocalTicketStore.ts | 2/87 | 2.30% |
| packages/services/src/project/autoArchiveScheduler.ts | 2/60 | 3.33% |
| packages/services/src/onboarding/localUsageEvidence.ts | 3/75 | 4.00% |
| packages/services/src/runtime-tools/appCaCert.ts | 2/47 | 4.26% |
| packages/services/src/terminal/terminalProfile.ts | 14/300 | 4.67% |
| packages/services/src/storage/contract.example.ts | 1/20 | 5.00% |
| packages/services/src/git/config.ts | 3/59 | 5.08% |
| packages/services/src/session/automationIntervalCarrier.ts | 2/39 | 5.13% |
| packages/services/src/model-provider/legacyZCodeConfigProviderReader.ts | 29/556 | 5.22% |
| packages/services/src/system/integratedTerminalShells.ts | 5/93 | 5.38% |
| packages/services/src/bots/config.ts | 3/53 | 5.66% |
| packages/services/src/zcode-agent/zcodeV4HostCommand.ts | 5/86 | 5.81% |
| packages/services/src/model-provider/legacyModelProviderSerialized.ts | 25/421 | 5.94% |
| packages/services/src/storage/adapters/inProcessScanRunner.ts | 2/33 | 6.06% |
| packages/services/src/git/repo/gitCliTypes.ts | 1/16 | 6.25% |
| packages/services/src/skills/skillDiscoveryWalk.ts | 4/63 | 6.35% |
| packages/services/src/coding-plan-subscription/zaiCodingPlanSubscriptionProvider.ts | 1/15 | 6.67% |
| packages/services/src/model-provider/accountProviderInvalidation.ts | 1/15 | 6.67% |
| packages/services/src/project-storage/default-workspace/migration.ts | 1/15 | 6.67% |
| packages/services/src/storage/adapters/volumeProbe.ts | 2/30 | 6.67% |
| packages/services/src/skills/skillsService.ts | 69/971 | 7.11% |
| packages/services/src/session/fileChangeTracker.ts | 9/126 | 7.14% |
| packages/services/src/runtime-tools/agentProxyEnv.ts | 5/68 | 7.35% |
| packages/services/src/file/workspaceFileIgnore.ts | 16/209 | 7.66% |
| packages/services/src/usage-stats/providers/zcodeMcpQuotaProvider.ts | 14/179 | 7.82% |
| packages/services/src/official-mcp/officialMcpCredentials.ts | 21/252 | 8.33% |
| packages/services/src/session/automationCron.ts | 19/226 | 8.41% |
| packages/services/src/model-provider/providerConfigRuntime.ts | 4/46 | 8.70% |
| packages/services/src/model-provider/providerRuntime.ts | 12/138 | 8.70% |
| packages/services/src/system/systemService.ts | 25/273 | 9.16% |
| packages/services/src/subagents/subagentMarkdown.ts | 32/336 | 9.52% |
| packages/services/src/zcode-session/importedClaudeSessionRepair.ts | 2/21 | 9.52% |
| packages/services/src/bots/groupDeliveryThrottle.ts | 1/10 | 10.00% |
| packages/services/src/model-provider/accountProviderApiClient.ts | 2/20 | 10.00% |
| packages/services/src/model-provider/providerSettingsConnectivity.ts | 2/20 | 10.00% |
| packages/services/src/model-provider/accountProviderCredentialStore.ts | 3/29 | 10.34% |
| packages/services/src/coding-plan-subscription/codingPlanSubscriptionService.ts | 5/48 | 10.42% |
| packages/services/src/git/repo/gitCheckpointHelpers.ts | 17/161 | 10.56% |
| packages/services/src/session/offPeakTaskRepo.ts | 62/584 | 10.62% |
| packages/services/src/runtime-tools/runtimeToolResolver.ts | 13/121 | 10.74% |
| packages/services/src/project-storage/project-repository.ts | 39/354 | 11.02% |
| packages/services/src/setting/settingsWriteQueue.ts | 5/45 | 11.11% |
| packages/services/src/subagents/subagentModelSelection.ts | 1/9 | 11.11% |
| packages/services/src/window-project-directory/index.ts | 1/9 | 11.11% |
| packages/services/src/zcode-session/zcodeSessionDraftRegistry.ts | 3/27 | 11.11% |
| packages/services/src/git/commitMessageFileScope.ts | 8/70 | 11.43% |
| packages/services/src/official-mcp/officialMcpIssuanceAudit.ts | 2/17 | 11.76% |
| packages/services/src/plugins/installedPluginRoots.ts | 5/42 | 11.90% |
| packages/services/src/providers/api/apiJson.ts | 9/75 | 12.00% |
| packages/services/src/remote-sync/remoteSyncWriteAccess.ts | 3/25 | 12.00% |
| packages/services/src/paths.ts | 20/164 | 12.20% |
| packages/services/src/bots/providers/webhookProvider.ts | 31/249 | 12.45% |
| packages/services/src/bots/providers/weixinRegistration.ts | 14/112 | 12.50% |
| packages/services/src/bots/repo.ts | 8/64 | 12.50% |
| packages/services/src/oauth/providers/configUtils.ts | 3/24 | 12.50% |
| packages/services/src/project-storage/remote-policy.ts | 2/16 | 12.50% |
| packages/services/src/bots/providers/weixinProvider.ts | 72/574 | 12.54% |
| packages/services/src/session/automationRepo.ts | 143/1124 | 12.72% |
| packages/services/src/oauth/providers/zaiProviderConfig.ts | 3/23 | 13.04% |
| packages/services/src/project-storage/test-fixture.ts | 6/46 | 13.04% |
| packages/services/src/session/tasksDatabase/provider-selection-v2.ts | 9/69 | 13.04% |
| packages/services/src/session/taskIndexRepo.ts | 143/1077 | 13.28% |
| packages/services/src/feedback/compactLogArchive.ts | 2/15 | 13.33% |
| packages/services/src/providers/api/apiKeyHeaders.ts | 2/15 | 13.33% |
| packages/services/src/task-facts/repairSubagentTaskIndex.ts | 4/30 | 13.33% |
| packages/services/src/oauth/oauthProfileSchema.ts | 13/97 | 13.40% |
| packages/services/src/session/claude-native/importedClaudeTaskFileFilter.ts | 5/37 | 13.51% |
| packages/services/src/model-provider/accountProviderCredentialKey.ts | 3/22 | 13.64% |
| packages/services/src/plugin-sync/pluginSyncPath.ts | 4/29 | 13.79% |
| packages/services/src/skill-sync/skillSyncPath.ts | 4/29 | 13.79% |
| packages/services/src/highspeed/highspeedCardService.ts | 30/217 | 13.82% |
| packages/services/src/usage-stats/providers/bigmodelUsageMonitorRange.ts | 18/127 | 14.17% |
| packages/services/src/oauth/providers/bigmodelProviderConfig.ts | 3/21 | 14.29% |
| packages/services/src/oauth/repo/oauthCredentialRepo.ts | 50/346 | 14.45% |
| packages/services/src/storage/adapters/fsCleaner.ts | 14/96 | 14.58% |
| packages/services/src/output-style/outputStyleService.ts | 24/162 | 14.81% |
| packages/services/src/setting/legacyAccountConnectionSettings.ts | 12/81 | 14.81% |

> 完整明细（含函数级数据）：`d:\code\_annot_baseline\inner-services.json`（改造前）、`inner-services-after.json`（改造后）。

## 3. 清注水

只删「相对 HEAD 由本线新增」的注释行；上游注释一行未动。四项校验：删除行是注释行、相对 HEAD 为新增、代码 token 流一致、语法可解析。

| 文件 | 注水形态 | 处理 | 净删除 |
| --- | --- | ---: | ---: |
| `background-tasks.ts` | 5 组「四连排比」短句（只观察…/非 record…/taskId 双口径…/同一任务幂等…），与相邻 JSDoc 重复 | 整组删除 | 20 |
| `settingsSyncService.ts` | 6 处「同上 / 插件候选同上」无指代词，同一模板复制到 4 个 `*ForScope` 函数 | 改写为指名道姓的具体前置条件与后果 | 6（改写时删旧行） |
| `zcodeAgentService.ts` | 3 行 `//` 与紧随其后的上游 JSDoc 逐字同义 | 删除自有重复行 | 3 |
| `methods/steering.ts` | 审计称为「注水 13 行」 | 核验后为 **HEAD 上游注释**，按规则不得删除；已原样回填，仅保留自有新增 | 0 |

合计净删自有注释 29 行，`rewrittenSegments=13`。

## 4. 关键文件补深（16 文件前后对比）

| 文件 | 改造前 | 改造后 | 净增中文注释 | 补深重点 |
| --- | ---: | ---: | ---: | --- |
| `contracts/src/tools/bash.ts` | 0/24（0%） | 21/24（87.50%） | +21 | 数字/布尔语义归一：非字符串透传、空串保留、白名单而非真值判断 |
| `contracts/src/tools/edit.ts` | 0/15（0%） | 9/15（60.00%） | +9 | 同上；`replace_all` 误开的风险 |
| `contracts/src/tools/read.ts` | 0/42（0%） | 19/42（45.24%） | +19 | 设备文件/二进制后缀拦截顺序、页码与路径错误互斥 |
| `runtime/helpers/steering.ts` | 10/277（3.61%） | 126/277（45.49%） | +116 | UTF-8 字节计量、消息裁剪边界、fork 克隆的身份重映射 |
| `tool/handlers/read.ts` | 15/317（4.73%） | 98/317（30.91%） | +83 | 路径预检、图片/PDF/文本分派顺序、读缓存新鲜度、错误建议 |
| `model-provider/legacyZCodeConfigProviderReader.ts` | 29/556（5.22%） | 241/556（43.35%） | +212 | 旧配置定位与字段兼容、鉴权/baseUrl 归一、非法输入降级不抛错 |
| `skills/skillsService.ts` | 69/971（7.11%） | 334/971（34.40%） | +265 | 多根扫描顺序、realpath 去重、名称冲突消解、IO 失败降级 |
| `runtime/agent-runtime.ts` | 12/120（10.00%） | 91/120（75.83%） | +79 | 构造装配顺序、关停顺序、浏览器/记忆调度释放 |
| `tool/handlers/bash.ts` | 39/368（10.60%） | 117/368（31.79%） | +78 | 子进程 argv、超时/取消/后台化优先级、遥测归因 |
| `tool/handlers/edit.ts` | 50/427（11.71%） | 166/427（38.88%） | +116 | 读后写校验、唯一匹配、replace_all、换行还原、写回顺序 |
| `oauth/oauthService.ts` | 150/942（15.92%） | 244/942（25.90%） | +94 | 凭据写入串行化、401 核对窗口、过期判定、provider 切换时序 |
| `runtime/methods/steering.ts` | 191/1077（17.73%） | 283/1077（26.28%） | +92 | turn 预占/释放、pending 单消费者、事件先写内存后改 |
| `settings-sync/settingsSyncService.ts` | 312/1666（18.73%） | 417/1666（25.03%） | +105 | 导入状态机、目标已存在不覆盖、单候选失败不中断 |
| `tool/executor/background-tasks.ts` | 154/816（18.87%） | 217/816（26.59%） | +63 | 三把锁、终态只发一次、通知认领与释放 |
| `git/repo/gitCliRepo.ts` | 359/1345（26.69%） | 577/1345（42.90%） | +218 | diff 三来源基准、NUL/`\x1e` 解析、失败降级三选一、watch 归一 |
| `zcode-agent/zcodeAgentService.ts` | 1908/5375（35.50%） | 2218/5375（41.27%） | +310 | 门面分组语义：插件、MCP UI、会话读取、自动化、V4 委托 |
| **合计** | **3,298/14,338（23.00%）** | **5,178/14,338（36.11%）** | **+1,880** | 16/16 文件 ≥15%，函数级最低 15.0% |

16 个文件的代码行数前后完全一致（14,338），说明改动全部落在注释行。

## 5. 校验

### 5.1 改写批 `zc-verify --rewrite ZC-deep-svc-rework`

```
SUMMARY files=16 rewrittenSegments=13 deletedOwnCommentLines=29 codeTokenDiff=0 headTokenDrift=1
        codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0
        starSlash=0 syntaxErrorFiles=0
```

- `deletedOwnCommentLines=29`：全部是自有新增注释（见第 3 节）。
- `upstreamCommentDeleted=0`、`codeDeletion=0`、`codeTokenDiff=0`：未删上游注释、未删代码、基线→当前代码 token 流逐 token 一致。
- `headTokenDrift=1`：`background-tasks.ts` 的 `Promise.resolve(...)` 尾逗号在历史批次被压行时移除，属**基线前**既有差异，`zc-verify` 仅告警不 fail；本轮未新增漂移。

### 5.2 内文率

```
SUMMARY files=16 innerCode=14338 innerZh=5178 below15=0 min=25.03 median=41.27
```

### 5.3 services 总密度回归

```
SUMMARY files=467 coreBelow30=0 needLines=0 min=30.05 median=32.00 newComments=30878
```

`coreBelow30=0 / needLines=0`（fail-closed 通过）。另有 34 个 `*.test.ts` 提示基线缺失——测试文件不在基线快照范围内，属预期，不影响上表结论。

## 6. 独立记账

| 项 | 数值 |
| --- | ---: |
| 本轮文件 | 16（services 6 + CLI/core 7 + contracts 3） |
| 新增整行中文注释 | 1,880（函数体内；services 1,204 + CLI 676） |
| 删除自有注水注释 | 29 |
| `deletedUpstream` | 0 |
| `codeTokenDiff` | 0 |
| 新增 JSDoc / 非注释行 | 0 |
| 语法错误 | 0 |
| 与 432 文件 / 29,693 行关系 | **不并入**；本轮单列，作为「关键文件补深」追加批次 |
