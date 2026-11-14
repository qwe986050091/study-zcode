# ZC-DEEP-svc-triage

> 阶段：`ZC-DEEP-svc-rework`（16 文件补深）之后的**分诊与分批计划**。
> 本轮只做筛选与排期，不改任何代码/注释。
> 数据源：`d:\code\_annot_baseline\inner-services-after.json`（services 全量 466 文件）。

## 1. 口径（所有数字必须带这句）

**内文率** = 函数体内部「整行中文注释行」÷ 函数体内部「代码行」。

- 函数体：函数声明 / 方法 / 构造函数 / getter-setter / 函数表达式 / 箭头函数的 Block，嵌套取行集合的并集。
- 整行注释：该行非空白字符全部落在注释范围内；行尾注释不计。
- 中文注释：注释文本含 CJK 字符；英文注释算注释、不进分子。
- 注释范围：AST 的 leading/trailing trivia（含标点 token）+ 字符覆盖掩码，**不是裸 `ts.createScanner`**。
- 命令：`node _annot_baseline/zc-inner.mjs --repo D:/code/ZCode --roots packages/services/src --threshold 15`。

> 上一轮审计的「9 个关键文件 <10%」需要分情况复述：在修正口径下，被点名的 12 个文件里 **6 个确实 <10%**（`legacyZCodeConfigProviderReader` 5.22%、`skillsService` 7.11%、`contracts/tools/{bash,read,edit}.ts` 均 0%、`core/tool/handlers/read.ts` 4.73%），**另外 6 个是虚警**（`zcodeAgentService` 35.50%、`gitCliRepo` 26.69%、`oauthService` 15.92%、`background-tasks` 18.87%、`methods/steering` 17.73%、`handlers/bash` 10.60%）。虚警全部来自 scanner 在模板字面量后失步。**此后任何「某文件注释不足」的结论，必须同时给出度量脚本与口径。**

**当前剩余盘面**：services 466 文件，内文率 <15% 的 **114 个**（`innerZh=22,258 / innerCode=86,539`，中位 23.68%）。

**基线前差异处理（确认）**：`headTokenDrift=1`（`background-tasks.ts` 的 `Promise.resolve(...)` 尾逗号）是基线之前的既有差异，`zc-verify` 只告警、不 fail、不修。后续所有改写沿用：
- 基线→当前代码 token 流不一致 → fail；
- HEAD→基线既有漂移 → 只记录，**不趁机改**；
- 删除行只允许是本线新增的注释行，上游注释一行不动。

## 2. 筛选规则

按 `DEEP-SPEC` 的 v2「关键文件」六类命中：

| 类别 | 本仓具体形态 |
| --- | --- |
| 并发 / 锁 | 准入屏障、单例传输、串行节流、写队列、单消费者预占 |
| 持久化 / 崩溃窗口 | 原子写、临时文件、迁移、索引、checkpoint、冷恢复 |
| 协议状态机 | 命令信封 / ACK、轮询与重连、终态只发一次、schema 迁移 |
| 资源生命周期 | 子进程启动与回收、定时器、单例装配与关停、会话快照 |
| 安全边界 | 凭据与令牌、身份头、路径穿越、可执行文件解析、子进程环境注入 |
| 序列化兼容 | 旧 store 解码、字段清洗、版本迁移、摘要规范化 |

**排序依据是故障后果，不是行数**：
- **P0**：凭据泄漏 / 越权 / 路径越界导致破坏性删除 / 数据不可恢复；
- **P1**：跨进程或跨会话状态错乱、索引与转录不一致、迁移半途、崩溃窗口丢写入；
- **P2**：重复执行 / 漏执行、协议失步、功能错误但可重试；
- **P3**：展示或体验降级（默认不进 A 档）。

**「写尽即止」判据**（满足任一条且无状态、无 IO、无安全语义）：纯 DTO / 类型 / 常量表 / 文案表 / 单方法包装 / 示例契约 / 测试夹具。不为了过 15% 硬填；已有 JSDoc 能说清的，补 0 行也算完成。

## 3. A 档：逐语句组（51 文件，预计 +2,180 行）

> 要求：每个语句组、每个分支、每个字段都要解释「在做什么 / 为什么必须这样 / 依赖什么前置条件 / 做错出现什么现象」。允许合并成一行，但不许以「这行很简单」跳过。

### P0 安全边界（17 文件，约 +484 行）

| # | 文件 | 内文率 | 代码行 | 故障后果 | 预计 |
| ---: | --- | ---: | ---: | --- | ---: |
| 1 | `oauth/repo/oauthCredentialRepo.ts` | 14.45% | 346 | 镜像 key 边界算错 → 跨账号读到别人的令牌 | 80 |
| 2 | `official-mcp/officialMcpCredentials.ts` | 8.33% | 252 | 身份头/凭证解析错 → 冒充或鉴权失败 | 62 |
| 3 | `bots/providers/weixinRegistration.ts` | 12.50% | 112 | device flow 状态错 → 令牌写入错误账号 | 34 |
| 4 | `providers/api/apiKeyHeaders.ts` | 13.33% | 15 | 未清洗的 key 进 header → 换行注入 / 请求被拒 | 7 |
| 5 | `model-provider/accountProviderCredentialKey.ts` | 13.64% | 22 | key 碰撞 → 两个 scope 复用同一凭据 | 9 |
| 6 | `model-provider/accountProviderCredentialStore.ts` | 10.34% | 29 | key 规范化漏项 → 读不到或写串凭据 | 11 |
| 7 | `paths.ts` | 12.20% | 164 | 路径规则漂移 → 越界读写 | 45 |
| 8 | `plugin-sync/pluginSyncPath.ts` | 13.79% | 29 | 相对路径逃逸 → 写出插件目录 | 12 |
| 9 | `skill-sync/skillSyncPath.ts` | 13.79% | 29 | 同上，技能根 | 12 |
| 10 | `storage/adapters/fsCleaner.ts` | 14.58% | 96 | 清理越界 → 误删非受控目录 | 30 |
| 11 | `file/workspaceFileIgnore.ts` | 7.66% | 209 | ignore 规则错 → 该拦的没拦或该读的读不到 | 55 |
| 12 | `project-storage/remote-policy.ts` | 12.50% | 16 | 根可变 / cwd 越界 → 远端写入落到错误根 | 8 |
| 13 | `runtime-tools/runtimeToolResolver.ts` | 10.74% | 121 | 解析到错误二进制 → 执行非预期程序 | 38 |
| 14 | `runtime-tools/agentProxyEnv.ts` | 7.35% | 68 | 代理/CA 注入错 → 子进程流量走错出口或证书失效 | 24 |
| 15 | `runtime-tools/appCaCert.ts` | 4.26% | 47 | 私钥路径/生成错 → 全量子进程 TLS 失败 | 17 |
| 16 | `git/config.ts` | 5.08% | 59 | git 候选/环境净化错 → 执行恶意同名 git | 24 |
| 17 | `subagents/subagentStorage.ts` | 0.00% | 46 | 目录解析错 → 状态文件写到工作区外 | 16 |

### P1 持久化与崩溃窗口（17 文件，约 +1,161 行）

| # | 文件 | 内文率 | 代码行 | 故障后果 | 预计 |
| ---: | --- | ---: | ---: | --- | ---: |
| 18 | `session/taskIndexRepo.ts` | 13.28% | 1,077 | 索引半写 → 冷恢复丢任务或与转录不一致 | 240 |
| 19 | `session/automationRepo.ts` | 12.72% | 1,124 | 自动化状态错 → 任务重复触发或永久卡死 | 250 |
| 20 | `session/offPeakTaskRepo.ts` | 10.62% | 584 | off-peak 队列丢失 → 夜间任务不执行 | 130 |
| 21 | `project-storage/project-repository.ts` | 11.02% | 354 | 迁移半途 → 项目目录指向失效 | 85 |
| 22 | `model-provider/legacyModelProviderSerialized.ts` | 5.94% | 421 | 旧 store 解码错 → 升级后配置整体丢失 | 95 |
| 23 | `git/repo/gitCheckpointStore.ts` | 0.00% | 75 | 元数据非原子写 → checkpoint 索引损坏 | 25 |
| 24 | `git/repo/gitCheckpointHelpers.ts` | 10.56% | 161 | 临时索引未清 → 后续 diff 串入上一次快照 | 45 |
| 25 | `setting/settingsWriteQueue.ts` | 11.11% | 45 | commit 阶段错 → 配置截断或旧值复活 | 16 |
| 26 | `feedback/feedbackLocalTicketStore.ts` | 2.30% | 87 | 单 JSON 非原子写 → 票据全丢 | 28 |
| 27 | `output-style/outputStyleService.ts` | 14.81% | 162 | 覆盖 `settings.json` → 用户既有配置被抹 | 40 |
| 28 | `session/fileChangeTracker.ts` | 7.14% | 126 | 首尾合并错 → rewind 还原出错误内容 | 35 |
| 29 | `subagents/subagentMarkdown.ts` | 9.52% | 336 | frontmatter 回写错 → 子代理配置损坏 | 80 |
| 30 | `session/tasksDatabase/provider-selection-v2.ts` | 13.04% | 69 | 旧三列解码错 → 迁移后模型选择漂移 | 22 |
| 31 | `setting/legacyAccountConnectionSettings.ts` | 14.81% | 81 | 迁移漏字段 → 账号连接失效 | 25 |
| 32 | `project-storage/default-workspace/migration.ts` | 6.67% | 15 | 任务交还不幂等 → 重复迁移 | 8 |
| 33 | `session/tasksDatabase/prepared.ts` | 0.00% | 13 | 已准备缓存误判 → 跳过建表/迁移 | 7 |
| 34 | `oauth/oauthProfileSchema.ts` | 13.40% | 97 | schema 迁移回退 → 登录态丢失 | 30 |

### P2 协议状态机与生命周期（17 文件，约 +535 行）

| # | 文件 | 内文率 | 代码行 | 故障后果 | 预计 |
| ---: | --- | ---: | ---: | --- | ---: |
| 35 | `bots/providers/weixinProvider.ts` | 12.54% | 574 | 轮询/媒体/发送状态错 → 重复回复或丢消息 | 120 |
| 36 | `bots/providers/webhookProvider.ts` | 12.45% | 249 | 双向适配错 → 回调重放 / 消息丢失 | 60 |
| 37 | `highspeed/highspeedCardService.ts` | 13.82% | 217 | 卡缓存/过期或双 JWT 拼接错 → 401 或错套餐 | 50 |
| 38 | `zcode-agent/zcodeV4HostCommand.ts` | 5.81% | 86 | 信封/ACK 错 → 命令重复执行或永远等 ACK | 28 |
| 39 | `conversation-share/conversationShareIntegrity.ts` | 0.00% | 102 | 规范化不一致 → 误判篡改 | 30 |
| 40 | `session/automationCron.ts` | 8.41% | 226 | 下次触发时间算错 → 漏跑或多跑 | 55 |
| 41 | `project/autoArchiveScheduler.ts` | 3.33% | 60 | 首轮/间隔错 → 归档不触发 | 22 |
| 42 | `cua-permission-broker/cuaAgentAdmissionGate.ts` | 0.00% | 66 | 屏障泄漏 → recovery 期间起 Agent | 24 |
| 43 | `cua-permission-broker/stableCuaTransport.ts` | 0.00% | 31 | 单例竞态 → 两条管道抢同一 helper | 14 |
| 44 | `model-provider/providerRuntime.ts` | 8.70% | 138 | 多实例 → 配置/Registry 双写 | 38 |
| 45 | `bots/repo.ts` | 12.50% | 64 | v3 仓储写坏 → Bot 配置与运行态分裂 | 20 |
| 46 | `bots/config.ts` | 5.66% | 53 | 默认值/字段归一错 → 升级后配置回落 | 16 |
| 47 | `bots/groupDeliveryThrottle.ts` | 10.00% | 10 | 节流键错 → 群消息乱序 | 8 |
| 48 | `session/automationIntervalCarrier.ts` | 5.13% | 39 | 间隔校验错 → cron 承载不了的长间隔被吞 | 14 |
| 49 | `skills/skillDiscoveryWalk.ts` | 6.35% | 63 | 遍历越界/跟随软链 → 扫到根外 | 18 |
| 50 | `collection.ts` | 0.00% | 24 | 暴露策略漏配 → 内部服务对端可见 | 10 |
| 51 | `zcode-agent/automationToolPolicy.ts` | 0.00% | 14 | 自动化内再建自动化 → 自我复制式调度 | 8 |

**A 档合计**：51 文件 / 8,503 代码行 / 预计 **+2,180 行**（约 25.6%），目标函数级 ≥15%、文件级 ≥20%。

### 3.1 实测复核（2026-11-09）

口径同上（`zc-inner.mjs`，函数级明细同一次运行导出 `_annot_baseline/ZC-a51-current.json`）。

```text
node _annot_baseline/zc-inner.mjs --repo D:/code/ZCode --roots packages/services/src --only <51 文件>
SUMMARY files=51 innerCode=8481 innerZh=2832 below100=51 min=30.23 median=35.48
函数级：code>=5 的函数中 <15% 的有 0 个
HEAD 基线：node _annot_baseline/zc-verify.mjs --rewrite ZC-a51-audit
SUMMARY files=51 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0
        literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0
```

**结论：A 档 51 文件已全部完成，无剩余待补。** 下表的「计划」列保留立项时的基线值作为对照，「实测」列是当前值；51 个文件的代码行只有 `offPeakTaskRepo.ts` 变化（584 → 562），原因是 `ZC-fix-sql-literal` 把 22 行 `//` 从 SQL 模板块移出，这些行原先被算作代码 token。其余 50 个文件代码行与立项时逐一致，说明这一天里没有其他线改过这些文件的代码。

| # | 文件 | 计划内文率 | 实测（2026-11-09） | 代码行 | 结论 |
| ---: | --- | ---: | ---: | ---: | --- |
| 1 | `oauth/repo/oauthCredentialRepo.ts` | 14.45% | 31.50%（109/346） | 346 | 已完成 |
| 2 | `official-mcp/officialMcpCredentials.ts` | 8.33% | 32.54%（82/252） | 252 | 已完成 |
| 3 | `bots/providers/weixinRegistration.ts` | 12.50% | 37.50%（42/112） | 112 | 已完成 |
| 4 | `providers/api/apiKeyHeaders.ts` | 13.33% | 40.00%（6/15） | 15 | 已完成 |
| 5 | `model-provider/accountProviderCredentialKey.ts` | 13.64% | 36.36%（8/22） | 22 | 已完成 |
| 6 | `model-provider/accountProviderCredentialStore.ts` | 10.34% | 41.38%（12/29） | 29 | 已完成 |
| 7 | `paths.ts` | 12.20% | 31.71%（52/164） | 164 | 已完成 |
| 8 | `plugin-sync/pluginSyncPath.ts` | 13.79% | 41.38%（12/29） | 29 | 已完成 |
| 9 | `skill-sync/skillSyncPath.ts` | 13.79% | 41.38%（12/29） | 29 | 已完成 |
| 10 | `storage/adapters/fsCleaner.ts` | 14.58% | 32.29%（31/96） | 96 | 已完成 |
| 11 | `file/workspaceFileIgnore.ts` | 7.66% | 32.06%（67/209） | 209 | 已完成 |
| 12 | `project-storage/remote-policy.ts` | 12.50% | 50.00%（8/16） | 16 | 已完成 |
| 13 | `runtime-tools/runtimeToolResolver.ts` | 10.74% | 34.71%（42/121） | 121 | 已完成 |
| 14 | `runtime-tools/agentProxyEnv.ts` | 7.35% | 39.71%（27/68） | 68 | 已完成 |
| 15 | `runtime-tools/appCaCert.ts` | 4.26% | 40.43%（19/47） | 47 | 已完成 |
| 16 | `git/config.ts` | 5.08% | 35.59%（21/59） | 59 | 已完成 |
| 17 | `subagents/subagentStorage.ts` | 0.00% | 34.78%（16/46） | 46 | 已完成 |
| 18 | `session/taskIndexRepo.ts` | 13.28% | 31.20%（336/1,077） | 1,077 | 已完成 |
| 19 | `session/automationRepo.ts` | 12.72% | 30.87%（347/1,124） | 1,124 | 已完成 |
| 20 | `session/offPeakTaskRepo.ts` | 10.62% | 35.77%（201/562） | 584 → 562 | 已完成；-22 由 SQL 修复解释 |
| 21 | `project-storage/project-repository.ts` | 11.02% | 32.20%（114/354） | 354 | 已完成 |
| 22 | `model-provider/legacyModelProviderSerialized.ts` | 5.94% | 31.35%（132/421） | 421 | 已完成 |
| 23 | `git/repo/gitCheckpointStore.ts` | 0.00% | 32.00%（24/75） | 75 | 已完成 |
| 24 | `git/repo/gitCheckpointHelpers.ts` | 10.56% | 35.40%（57/161） | 161 | 已完成 |
| 25 | `setting/settingsWriteQueue.ts` | 11.11% | 46.67%（21/45） | 45 | 已完成 |
| 26 | `feedback/feedbackLocalTicketStore.ts` | 2.30% | 31.03%（27/87） | 87 | 已完成 |
| 27 | `output-style/outputStyleService.ts` | 14.81% | 36.42%（59/162） | 162 | 已完成 |
| 28 | `session/fileChangeTracker.ts` | 7.14% | 38.10%（48/126） | 126 | 已完成 |
| 29 | `subagents/subagentMarkdown.ts` | 9.52% | 41.96%（141/336） | 336 | 已完成 |
| 30 | `session/tasksDatabase/provider-selection-v2.ts` | 13.04% | 34.78%（24/69） | 69 | 已完成 |
| 31 | `setting/legacyAccountConnectionSettings.ts` | 14.81% | 32.10%（26/81） | 81 | 已完成 |
| 32 | `project-storage/default-workspace/migration.ts` | 6.67% | 46.67%（7/15） | 15 | 已完成 |
| 33 | `session/tasksDatabase/prepared.ts` | 0.00% | 30.77%（4/13） | 13 | 已完成 |
| 34 | `oauth/oauthProfileSchema.ts` | 13.40% | 38.14%（37/97） | 97 | 已完成 |
| 35 | `bots/providers/weixinProvider.ts` | 12.54% | 30.31%（174/574） | 574 | 已完成 |
| 36 | `bots/providers/webhookProvider.ts` | 12.45% | 32.53%（81/249） | 249 | 已完成 |
| 37 | `highspeed/highspeedCardService.ts` | 13.82% | 31.80%（69/217） | 217 | 已完成 |
| 38 | `zcode-agent/zcodeV4HostCommand.ts` | 5.81% | 30.23%（26/86） | 86 | 已完成 |
| 39 | `conversation-share/conversationShareIntegrity.ts` | 0.00% | 30.39%（31/102） | 102 | 已完成 |
| 40 | `session/automationCron.ts` | 8.41% | 30.97%（70/226） | 226 | 已完成 |
| 41 | `project/autoArchiveScheduler.ts` | 3.33% | 40.00%（24/60） | 60 | 已完成 |
| 42 | `cua-permission-broker/cuaAgentAdmissionGate.ts` | 0.00% | 43.94%（29/66） | 66 | 已完成 |
| 43 | `cua-permission-broker/stableCuaTransport.ts` | 0.00% | 35.48%（11/31） | 31 | 已完成 |
| 44 | `model-provider/providerRuntime.ts` | 8.70% | 31.88%（44/138） | 138 | 已完成 |
| 45 | `bots/repo.ts` | 12.50% | 35.94%（23/64） | 64 | 已完成 |
| 46 | `bots/config.ts` | 5.66% | 32.08%（17/53） | 53 | 已完成 |
| 47 | `bots/groupDeliveryThrottle.ts` | 10.00% | 60.00%（6/10） | 10 | 已完成 |
| 48 | `session/automationIntervalCarrier.ts` | 5.13% | 43.59%（17/39） | 39 | 已完成 |
| 49 | `skills/skillDiscoveryWalk.ts` | 6.35% | 38.10%（24/63） | 63 | 已完成 |
| 50 | `collection.ts` | 0.00% | 37.50%（9/24） | 24 | 已完成 |
| 51 | `zcode-agent/automationToolPolicy.ts` | 0.00% | 42.86%（6/14） | 14 | 已完成 |

B 档 29 文件同批复核：`innerCode=1706` 与立项值完全一致，`innerZh=247`，中位 17.65%；4 个文件保持 0.00%（`bots/groupReply.ts`、`client-scenes/clientScenesService.ts`、`oauth/callbackAttribution.ts`、`setting/observableSettingService.ts`），按「写尽即止」判据不硬填。

## 4. B 档：写尽即止（29 文件，预计 +185 行）

> 不属于关键文件的理由逐条给出；补注只解释「输入从哪来、异常怎么降级」，不承诺 15%。

| 文件 | 内文率 | 代码行 | 为什么不是关键文件 | 预计 |
| --- | ---: | ---: | --- | ---: |
| `system/systemService.ts` | 9.16% | 273 | 宿主能力聚合，只读探测；失败只降级为「能力不可用」 | 30 |
| `terminal/terminalProfile.ts` | 4.67% | 300 | 字体栈合成，纯读配置 + 默认值，无写入、无状态 | 25 |
| `system/integratedTerminalShells.ts` | 5.38% | 93 | 只回答「有哪些 shell」，不启动进程 | 10 |
| `usage-stats/providers/zcodeMcpQuotaProvider.ts` | 7.82% | 179 | 可选数据面，失败一律降级 null，不向 entitlement 抛错 | 20 |
| `usage-stats/providers/bigmodelUsageMonitorRange.ts` | 14.17% | 127 | 纯日期范围换算，无 IO、无状态 | 15 |
| `onboarding/localUsageEvidence.ts` | 4.00% | 75 | 只读本机证据，结论用于引导，不影响业务状态 | 8 |
| `providers/api/apiJson.ts` | 12.00% | 75 | 统一错误归一，纯函数出口；错误类型不影响持久化 | 8 |
| `git/commitMessageFileScope.ts` | 11.43% | 70 | 会话改动 → 候选路径集合的纯换算 | 7 |
| `coding-plan-subscription/codingPlanSubscriptionService.ts` | 10.42% | 48 | 订阅状态读取包装，无本地持久化 | 5 |
| `plugins/installedPluginRoots.ts` | 11.90% | 42 | 只读 `installed_plugins.json`，失败返回空集 | 4 |
| `plugins/officialPluginCache.ts` | 0.00% | 34 | 只读扫描缓存目录，不安装、不加锁 | 4 |
| `session/claude-native/importedClaudeTaskFileFilter.ts` | 13.51% | 37 | 字段白名单剔除，纯数据变换 | 4 |
| `cua-permission-broker/cuaHelperInstaller.ts` | 0.00% | 32 | 架构名归一化，无副作用 | 4 |
| `storage/adapters/inProcessScanRunner.ts` | 6.06% | 33 | 扫描编排，不持锁、不落盘 | 4 |
| `storage/adapters/volumeProbe.ts` | 6.67% | 30 | 容量探测，失败降级 | 3 |
| `storage/adapters/rootsResolver.ts` | 0.00% | 22 | 纯路径拼接 | 3 |
| `remote-sync/remoteSyncWriteAccess.ts` | 12.00% | 25 | 写前探测，失败只返回 false | 3 |
| `task-facts/repairSubagentTaskIndex.ts` | 13.33% | 30 | 幂等清理派生索引，不碰转录 | 4 |
| `zcode-session/zcodeSessionDraftRegistry.ts` | 11.11% | 27 | 进程内标记集合，无持久化 | 3 |
| `zcode-session/importedClaudeSessionRepair.ts` | 9.52% | 21 | 幂等回填，失败可重跑 | 3 |
| `model-provider/accountProviderApiClient.ts` | 10.00% | 20 | 最小 HTTP 客户端，失败降级 null | 3 |
| `model-provider/providerSettingsConnectivity.ts` | 10.00% | 20 | 只把已落盘配置转成连通性判断 | 3 |
| `model-provider/accountProviderInvalidation.ts` | 6.67% | 15 | 单向失效桥，不持有状态 | 2 |
| `feedback/compactLogArchive.ts` | 13.33% | 15 | 打包编排，压缩委托给底层 | 2 |
| `setting/observableSettingService.ts` | 0.00% | 18 | 提交后通知包装，不新增持久化路径 | 2 |
| `official-mcp/officialMcpIssuanceAudit.ts` | 11.76% | 17 | 进程内去重，非持久化 | 2 |
| `oauth/callbackAttribution.ts` | 0.00% | 13 | 只提取投放归因，不参与鉴权判定 | 2 |
| `client-scenes/clientScenesService.ts` | 0.00% | 8 | 一次只读请求，无缓存/重试 | 1 |
| `bots/groupReply.ts` | 0.00% | 7 | 锚点失效的有限降级 | 1 |

**B 档合计**：29 文件 / 1,706 代码行 / **+185 行**，不设 15% 目标，函数级低于 15% 允许保留。

## 5. C 档：不补 / ≤1 行（34 文件）

判据：无运行时状态，注释无法解释「为什么」之外的信息，补注只会重复类型名。

| 类别 | 文件 | 处理 |
| --- | --- | --- |
| 契约示例（11） | 各目录 `contract.example.ts` | **0 行**；文件头已写明「不参与运行时装配」 |
| 纯类型 / 描述符 | `descriptors.ts`、`project-catalog/selection-id.ts`、`git/repo/gitCliTypes.ts` | 0 行 |
| 错误形状 | `zcode-agent/zcodeAgentErrors.ts`、`skill-sync/skillSyncErrors.ts` | 0 行 |
| 门面 / 再导出 | `model-provider/accountRequestAuthService.ts`、`plugins/pluginsService.ts`（已退役壳） | 0 行 |
| 静态配置 | `oauth/providers/{configUtils,bigmodelProviderConfig,zaiProviderConfig}.ts`、`oauth/runtimeConfig.ts`、`coding-plan-subscription/zaiCodingPlanSubscriptionProvider.ts`、`runtime-tools/clientPlatform.ts` | 0 行 |
| 装配层 | `model-provider/providerConfigRuntime.ts` | 0 行 |
| 常量 / 文案表 | `bots/messages.ts`、`providers/api/requestIdHeaders.ts`（header 常量） | 0 行 |
| 单行记录 | `session/claude-native/jsonLineRecord.ts`、`session/legacyTaskSessionFile.ts` | 0 行 |
| 归一化 | `subagents/subagentModelSelection.ts`、`bots/modelSelectionHelpers.ts` | 1 行（仅写「为何不校验」） |
| 转发适配 | `window-project-directory/index.ts` | 1 行 |
| 诊断 | `memoryDiagnostics.ts` | 0 行 |
| 测试夹具 | `project-storage/test-fixture.ts` | 0 行（不在验收分母） |

## 6. 分批计划

| 批次 | 主题 | 文件数 | 代码行 | 预计新增 | 验收 |
| --- | --- | ---: | ---: | ---: | --- |
| A1 | 凭据与令牌 | 7 | 873 | 233 | 函数级 ≥15%；A 档文件级 ≥20% |
| A2 | 路径校验与破坏性操作 | 7 | 589 | 178 | 同上 |
| A3 | 子进程与执行环境 | 4 | 295 | 103 | 同上 |
| A4 | 任务索引持久化 | 3 | 1,159 | 269 | 同上 |
| A5 | 自动化 / off-peak 持久化 | 3 | 1,747 | 394 | 同上 |
| A6 | 迁移 / checkpoint / 写队列 | 7 | 818 | 232 | 同上 |
| A7 | 序列化兼容与用户文件回写 | 4 | 1,045 | 250 | 同上 |
| A8 | 渠道协议与完整性 | 4 | 1,011 | 238 | 同上 |
| A9 | 调度与单例生命周期 | 6 | 738 | 203 | 同上 |
| A10 | 剩余小件 | 6 | 228 | 80 | 同上 |
| B1 | 系统 / 终端展示层 | 3 | 666 | 65 | 不设阈值 |
| B2 | 用量与配额 | 2 | 306 | 35 | 不设阈值 |
| B3 | 其余普通文件 | 24 | 734 | 86 | 不设阈值 |
| C | 示例 / 常量 / 类型 | 34 | — | ≤10 | 0 改动 |

**总量**：A 档 51 文件 8,503 代码行，约 **+2,180 行**；B 档 29 文件约 **+185 行**；C 档 34 文件约 **+10 行**。合计约 **+2,375 行**。

**执行状态（2026-11-09 实测复核）**：A1–A10 全部完成（51/51 实测 ≥30.23%，函数级 <15% 的为 0 个）；B1–B3 已完成（29 文件代码行 1,706 与立项一致）；C 档不改。详见 §3.1。

**每批固定流程**
1. 快照：`_annot_baseline/ZC-deep-svc-<batch>/orig` + `_files.txt`。
2. 只加整行 `//` 中文注释；不出现 `*/`、不改代码 token / 缩进 / import / 字符串。
3. 自检：`node _annot_baseline/zc-verify.mjs --rewrite ZC-deep-svc-<batch> --only <本批>`，要求 `codeTokenDiff=0 codeDeletion=0 upstreamCommentDeleted=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0`。
4. 度量：`zc-inner.mjs --only <本批>` 输出函数级明细，任一函数 <15% 需补到 15% 再进下一批。
5. 文档：每批写 `ZC-DEEP-svc-<batch>.md`，记账与 432 文件 / 29,693 行分开。

**执行顺序**：A1 → A3 → A2 → A4 → A6 → A5 → A7 → A9 → A8 → A10 → B1 → B2 → B3 → C。
理由：先堵安全边界（P0），再做崩溃窗口；渠道协议（A8）与调度（A9）依赖前两者的语义已写清，避免注释互相矛盾。

## 7. 记账口径

| 项 | 规则 |
| --- | --- |
| `deletedUpstream` | 恒 0 |
| `codeTokenDiff` | 恒 0 |
| `headTokenDrift` | 只记录基线前差异，不修 |
| 删除行 | 仅本线新增的注释行，需通过 HEAD→基线多重集 + 基线→当前 token 流双校验 |
| 与既有账本关系 | 不并入 432 文件 / 29,693 行，单列追加批次 |
