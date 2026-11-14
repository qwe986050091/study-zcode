# SVC-B13 深度注释索引（task-facts / process / usage-stats / cloud-content）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的第 61~75 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `task-facts/index.ts` | 166 | 1 → 53 | 31.93% | 52 |
| `gen-ui/adapters/stateStorage.ts` | 173 | 3 → 55 | 31.79% | 52 |
| `bigmodel/teamPlanApiKey.ts` | 171 | 3 → 57 | 33.33% | 54 |
| `onboarding/onboardingRecordService.ts` | 216 | 17 → 68 | 31.48% | 51 |
| `broadcast/broadcastService.ts` | 230 | 21 → 71 | 30.87% | 50 |
| `process/windowsProcessListAsync.ts` | 181 | 8 → 58 | 32.04% | 50 |
| `oauth/providers/bigmodelProviderAdapter.ts` | 248 | 28 → 80 | 32.26% | 52 |
| `source-server-workspace/sourceServerWorkspaceIdentityChannelServer.ts` | 218 | 20 → 70 | 32.11% | 50 |
| `cloud-content/cloudContentService.ts` | 147 | 0 → 47 | 31.97% | 47 |
| `usage-stats/providers/bigmodelUsageMonitorRange.ts` | 145 | 0 → 47 | 32.41% | 47 |
| `usage-stats/providers/bigmodelUsageQuotaMapper.ts` | 152 | 2 → 49 | 32.24% | 47 |
| `process/processTreeOwnership.ts` | 165 | 6 → 53 | 32.12% | 47 |
| `commands/commandFileParser.ts` | 140 | 0 → 43 | 30.71% | 43 |
| `process/processTreeSnapshotAsync.ts` | 148 | 3 → 47 | 31.76% | 44 |
| `cua-permission-broker/windowsCuaHelperHostSupport.ts` | 201 | 19 → 63 | 31.34% | 44 |
| **合计** | **2,701** | — | — | **730** |

## 2. 分段

| 段 | 文件 | 内容 | 新增 |
| --- | --- | --- | ---: |
| b13a | `task-facts/index.ts` | 代际失效、逐条投影、对账与交接位 | 52 |
| b13a | `stateStorage.ts` | 哈希目录、原子写、scope 文件锁、配额淘汰 | 52 |
| b13a | `teamPlanApiKey.ts` | 三重可用性判定、先查后建、诊断脱敏 | 54 |
| b13b | `onboardingRecordService.ts` | 记录覆盖与版本兼容 | 51 |
| b13b | `broadcastService.ts` | 订阅者隔离、迟到 claim 释放 | 50 |
| b13b | `windowsProcessListAsync.ts` | 进程表解析容错、deadline 预算 | 50 |
| b13b | `bigmodelProviderAdapter.ts` | token 双轨、authCode 一次性、userinfo 收窄 | 52 |
| b13b | `sourceServerWorkspaceIdentityChannelServer.ts` | 映射同源、重组后再分片、按 topic resync | 50 |
| b13c | `cloudContentService.ts` | 内容寻址与租约 | 47 |
| b13c | `bigmodelUsageMonitorRange.ts` | 时区与自然日边界 | 47 |
| b13c | `bigmodelUsageQuotaMapper.ts` | 配额字段语义与单位 | 47 |
| b13c | `processTreeOwnership.ts` | PID 复用与父链复核、fail-closed | 47 |
| b13c | `commandFileParser.ts` | frontmatter 边界、缩进续行、最小重写 | 43 |
| b13c | `processTreeSnapshotAsync.ts` | CIM 查询竞态、退出时间窗、空集语义 | 44 |
| b13c | `windowsCuaHelperHostSupport.ts` | 两阶段收敛、exit 唯一写入点、向前兼容 | 44 |

> 分段表按 spec 文件统计；同一文件多段合计等于上表新增。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b13
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=730
```

逐文件密度复测（`--only`，15 次全部 `PASS`；最低 30.71%，最高 33.33%）。

全 services 复测（b13 后）：

```text
SUMMARY files=467 coreBelow30=190 needLines=2620 min=0.00 median=30.71 newComments=26917
```

## 4. 本批锚定的不变量

- `task-facts/index.ts`：事实带代际号，旧代写入必须失效；投影逐条进行，任一条失败不污染其余。
- `stateStorage.ts`：状态按哈希目录归档；写入必须原子；同 scope 用文件锁串行；超配额先淘汰再写。
- `teamPlanApiKey.ts`：可用性需同时满足存在、未过期、作用域匹配；先查询再创建；诊断输出脱敏。
- `onboardingRecordService.ts`：记录按版本覆盖，旧版本不得回写覆盖新版本。
- `broadcastService.ts`：单个订阅者抛错不影响其他订阅者；迟到的 claim 必须释放。
- `windowsProcessListAsync.ts`：进程表行格式不稳定，解析失败跳过该行而非整体失败；枚举受 deadline 约束。
- `bigmodelProviderAdapter.ts`：业务 token 与 zcode JWT 双轨并存；authCode 一次性；登录失败不留半态。
- `sourceServerWorkspaceIdentityChannelServer.ts`：双向映射必须同源；复合 topic 先重组再映射再分片；失败只 resync 当前 topic。
- `cloudContentService.ts`：内容以哈希寻址；租约存在期间不得回收。
- `bigmodelUsageMonitorRange.ts`：范围按本地自然日计算，跨时区不得用 UTC 直接截断。
- `bigmodelUsageQuotaMapper.ts`：配额字段有固定单位和语义，缺失不等于 0。
- `processTreeOwnership.ts`：归属判定要复核父链身份，无法确认时 fail-closed。
- `commandFileParser.ts`：frontmatter 只重写受管键，其余原样保留；缩进续行属于同一命令。
- `processTreeSnapshotAsync.ts`：CIM 查询存在竞态，需按退出时间窗补回后代；「无后代」与「查询失败」必须区分。
- `windowsCuaHelperHostSupport.ts`：生命周期两阶段收敛；exit 事实只有一个写入点；控制消息需向前兼容。

## 5. 看似该改、其实不能改

- `task-facts/index` 不能丢弃代际号做「后写覆盖」：乱序写入会让旧事实复活。
- `stateStorage` 不能直接原地写文件：中断会留下不可解析的半个状态。
- `teamPlanApiKey` 不能先创建后查询：会产生重复 Key。
- `broadcastService` 不能在 catch 里 rethrow：一个坏订阅者会阻断其余广播。
- `bigmodelProviderAdapter` 不能把两类 token 合并成一个字段：刷新语义不同。
- `identityChannelServer` 不能在分片层做映射：必须先重组出完整 topic。
- `cloudContentService` 不能在租约有效时回收内容：使用方会读到空文件。
- `usageMonitorRange` 不能用 UTC 日期直接截断：会偏移本地自然日。
- `processTreeOwnership` 不能在身份不确定时返回「是后代」：会误杀无关进程。
- `commandFileParser` 不能整份重写 frontmatter：会丢失未知键与注释。
- `processTreeSnapshotAsync` 不能把查询失败当成空集：会误判进程已退出。
