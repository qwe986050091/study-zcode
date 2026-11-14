# SVC-B9 深度注释索引（session/git/usage/oauth 等主干服务）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的前 15 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `node.ts` | 2855 | 337 → 883 | 30.93% | 546 |
| `git/repo/gitCliRepo.ts` | 1498 | 47 → 460 | 30.71% | 413 |
| `usage-stats/providers/bigmodelUsageQuotaProvider.ts` | 1504 | 81 → 461 | 30.65% | 380 |
| `coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts` | 1383 | 73 → 440 | 31.81% | 367 |
| `plugin-sync/pluginSyncService.ts` | 1078 | 9 → 329 | 30.52% | 320 |
| `feedback/feedbackHttpClient.ts` | 999 | 20 → 309 | 30.93% | 289 |
| `skills/skillsService.ts` | 1088 | 77 → 360 | 33.09% | 283 |
| `oauth/oauthService.ts` | 1071 | 69 → 332 | 31.00% | 263 |
| `usage-stats/providers/bigmodelUsageMonitorMapper.ts` | 823 | 16 → 257 | 31.23% | 241 |
| `subagents/subagentsService.ts` | 811 | 17 → 257 | 31.69% | 240 |
| `commands/commandsService.ts` | 875 | 31 → 271 | 30.97% | 240 |
| `mcp-sync/mcpSyncService.ts` | 730 | 45 → 230 | 31.51% | 185 |
| `git/repo/gitCliHelpers.ts` | 621 | 14 → 190 | 30.60% | 176 |
| `system/sshConfigAlias.ts` | 604 | 12 → 187 | 30.96% | 175 |
| `cua-permission-broker/windowsCuaDevRuntime.ts` | 519 | 13 → 165 | 31.79% | 152 |
| **合计** | **16,459** | — | — | **4,270** |

## 2. 分段

| 段 | 文件 | 内容 | 新增 |
| --- | --- | --- | ---: |
| b9a | `node.ts` | INV 表、导出面契约、CUA Helper 生命周期、`createLocalServices` 装配顺序、注册链、dispose/telemetry/Server 装配 | 546 |
| b9a | `gitCliRepo.ts` | 命令参数拼接、`--` 终止选项、三点 diff、临时索引清理、错误映射 | 413 |
| b9a | `gitCliHelpers.ts` | 路径归一、引号与反斜杠、输出解析容错 | 176 |
| b9a | `bigmodelUsageQuotaProvider.ts` | 配额字段语义、时间窗口、缺失与 0 的区分、上游降级 | 380 |
| b9a | `bigmodelUsageMonitorMapper.ts` | 字段改名映射、总量翻倍边界、可选数据面降级 | 241 |
| b9a | `bigmodelCodingPlanSubscriptionProvider.ts` | 鉴权域单一来源、两套成功码、在途合并、预热隔离、WAF 收敛 | 367 |
| b9a | `oauthService.ts` | 会话写入串行化、generation 复核、刷新写回三重校验、回滚补偿 | 263 |
| b9c | `pluginSyncService.ts` | 同步状态机、staging+rename 半写清理、manifest 校验、指纹幂等 | 320 |
| b9c | `skillsService.ts` | 发现链路去重、frontmatter 宽松回退、writeQueue 串行化、软链护栏 | 283 |
| b9c | `feedbackHttpClient.ts` | 超时/重试/取消、响应解析降级、隐私脱敏 | 289 |
| b9c | `commandsService.ts` | 命令来源优先级、启用覆盖迁移、路径越界校验 | 240 |
| b9c | `subagentsService.ts` | 作用域配置解析与合并、生命周期 | 240 |
| b9c | `mcpSyncService.ts` | 配置合并优先级、同步事务与失败路径 | 185 |
| b9c | `sshConfigAlias.ts` | 别名改写幂等、Windows 路径与引号 | 175 |
| b9c | `windowsCuaDevRuntime.ts` | 权限判定边界、盘符/反斜杠/junction/UNC | 152 |

> 分段表按 spec 文件统计；同一文件多段合计等于上表新增。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b9
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=4270
```

逐文件密度复测（`--only`，15 次全部 `PASS`）：

```text
SUMMARY files=1 coreBelow30=0 needLines=0 min=30.93 median=30.93 newComments=546   node.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=30.71 median=30.71 newComments=413   gitCliRepo.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=30.65 median=30.65 newComments=380   bigmodelUsageQuotaProvider.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=31.81 median=31.81 newComments=367   bigmodelCodingPlanSubscriptionProvider.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=30.52 median=30.52 newComments=320   pluginSyncService.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=30.93 median=30.93 newComments=289   feedbackHttpClient.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=31.00 median=31.00 newComments=263   oauthService.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=33.09 median=33.09 newComments=283   skillsService.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=30.97 median=30.97 newComments=240   commandsService.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=31.23 median=31.23 newComments=241   bigmodelUsageMonitorMapper.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=31.69 median=31.69 newComments=240   subagentsService.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=31.51 median=31.51 newComments=185   mcpSyncService.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=30.60 median=30.60 newComments=176   gitCliHelpers.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=30.96 median=30.96 newComments=175   sshConfigAlias.ts
SUMMARY files=1 coreBelow30=0 needLines=0 min=31.79 median=31.79 newComments=152   windowsCuaDevRuntime.ts
```

全 services 复测（b9 后）：

```text
SUMMARY files=467 coreBelow30=250 needLines=7065 min=0.00 median=18.29 newComments=22232
```

## 4. 本批锚定的不变量

- `node.ts`：装配顺序即依赖顺序；`standalone-server` 以 `serviceAuthorityMode` 固定权限面，绝不以 local owner 开放远端 RPC；`projectStorageHostId` 派生失败必须抛错，不得回退猜测值；alias repo 与 mapper 必须成对注入同一个实例。
- `node.ts`：topic-resource 三件套只导出工厂与类型，不注册进通用服务面；文件类能力必须由 Host 提供，renderer 不得自行拼路径。
- `gitCliRepo.ts`：用户可控路径一律放在 `--` 之后；`--no-index` 的退出码 1 表示「有差异」而非失败；stagedOnly 的临时索引必须在 finally 清理。
- `gitCliHelpers.ts`：路径归一化后仍需校验真实路径未越出仓库根；输出解析不得以空行做分隔假设。
- `bigmodelUsageQuotaProvider.ts`：缺失字段与数值 0 语义不同；配额（quota）与权益（entitlement）解耦，后者失败不得连带清空前者。
- `bigmodelUsageMonitorMapper.ts`：上游存在同义字段名（`x_time`/`xTime`、`tokensUsage`/`totalTokensUsage`、`mcpDataList`/`modelDataList`），映射必须择一，不可叠加求和。
- `bigmodelCodingPlanSubscriptionProvider.ts`：鉴权域只有一个事实源；快照与过期时间同写；在途请求合并；预热失败不得污染主流程。
- `oauthService.ts`：会话写入串行化；刷新写回前复核 generation；先清旧 provider 凭据再写新 token；先撤认证事实再清派生状态。
- `pluginSyncService.ts`：安装走 staging + rename，半写必须清理；判重依赖内容指纹而非时间戳。
- `skillsService.ts`：开关只持久化「关闭态」，缺省即可用；写操作经 writeQueue 串行化；软链目录不得直接删除。
- `feedbackHttpClient.ts`：重试只针对可重试错误；上报内容必须先脱敏。
- `commandsService.ts`：命令来源有固定优先级，去重后不得改变覆盖顺序。
- `mcpSyncService.ts`：本地配置与远端清单合并时，本地显式项优先；同步失败的中间态必须回滚。
- `sshConfigAlias.ts`：别名改写必须幂等，重复执行不得产生嵌套 Host 段。
- `windowsCuaDevRuntime.ts`：权限判定基于规范化后的真实路径；盘符大小写与 junction 解析不得绕过判定。

## 5. 看似该改、其实不能改

- `node.ts` 的 `projectStorageHostId` 派生不能加「失败就用默认值」：默认值会让新 Host 连到空库并覆盖既有目录。
- `gitCliRepo` 不能把 `--no-index` 的 exit code 1 当失败：那是 diff 的「有差异」语义。
- `bigmodelUsageMonitorMapper` 不能把同义字段相加求总量：上游不同接口会给同一份数据的不同切片，相加会翻倍。
- `bigmodelCodingPlanSubscriptionProvider` 不能把预热失败升级为订阅失败：预热只是加速，失败应降级为按需获取。
- `oauthService` 不能把刷新写回简化成「直接覆盖」：缺少 generation 复核会让并发刷新用旧 token 覆盖新 token。
- `pluginSyncService` 不能直接写目标目录：无 staging 时进程中断会留下「半装」状态且无法判定。
- `skillsService` 不能把软链目录当普通目录递归删除：会穿透到用户真实目录。
- `commandsService` 不能把多来源命令简单合并：覆盖顺序变化会静默改变同名命令的行为。
- `sshConfigAlias` 不能在已有 `Host` 段内追加别名：会生成嵌套 Host，sshd 配置解析结果不可预期。
