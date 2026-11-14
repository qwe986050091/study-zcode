# SVC-B28 注释批次（B 档「写尽即止」第 1 组 / 分诊 B1）

> 上游分诊：`docs/annotation/ZC-DEEP-svc-triage.md` §4（B 档 29 文件 / 预计 +185 行）。
> 本批 10 文件，对应 B1（系统 / 终端展示层）并延伸至 B2、B3 的同组文件。
> 规则：只新增整行中文 `//` 注释，不改代码；B 档不设 15% 函数级目标，不为过线硬填。

## 1. 结果

| 文件 | 代码行 | 内文（前→后） | 新增 |
| --- | ---: | --- | ---: |
| `system/systemService.ts` | 273 | 25 → 35（9.16% → 12.82%） | 11 |
| `terminal/terminalProfile.ts` | 300 | 14 → 14（4.67% → 4.67%） | 11 |
| `system/integratedTerminalShells.ts` | 93 | 5 → 10（5.38% → 10.75%） | 5 |
| `usage-stats/providers/zcodeMcpQuotaProvider.ts` | 179 | 14 → 20（7.82% → 11.17%） | 6 |
| `usage-stats/providers/bigmodelUsageMonitorRange.ts` | 127 | 18 → 24（14.17% → 18.90%） | 7 |
| `onboarding/localUsageEvidence.ts` | 75 | 3 → 13（4.00% → 17.33%） | 10 |
| `providers/api/apiJson.ts` | 75 | 9 → 15（12.00% → 20.00%） | 6 |
| `git/commitMessageFileScope.ts` | 70 | 8 → 14（11.43% → 20.00%） | 6 |
| `coding-plan-subscription/codingPlanSubscriptionService.ts` | 48 | 5 → 13（10.42% → 27.08%） | 8 |
| `plugins/installedPluginRoots.ts` | 42 | 5 → 9（11.90% → 21.43%） | 4 |
| **合计** | **1282** | 106 → 167（中位 10.42% → 18.90%） | **74** |

- 新增 74 行，全部落在函数体内外按「输入来源 / 降级路径 / 调用方依赖」组织；单文件 4~11 行，未超 0-30 行上限。
- 另有 66 行**不在 HEAD 的既有新增注释**被改写（gate 判 L/W 的注水行）：只换注释文本、行数不变，用于把 waterRate 从 16.75% 降到 0.00%。这些行相对 HEAD 仍是新增注释，删除/改写均有 `deletedOwnCommentLines=66` 记录，上游注释未动。
- `terminalProfile.ts` 内文率未升：本次补注锚在顶层函数声明前，不在函数体内；按 B 档「已有 JSDoc 说清可补 0 行」，不为数字硬塞行内注释。

## 2. 每文件「为何非关键」判据（引 triage §4）

| 文件 | 判据 |
| --- | --- |
| `system/systemService.ts` | 宿主能力聚合与只读探测；单个目标失败不 reject，只降级为「能力不可用」。 |
| `terminal/terminalProfile.ts` | 字体栈合成，纯读配置 + 默认值；无写入、无运行期状态。 |
| `system/integratedTerminalShells.ts` | 只回答「有哪些 shell」，不启动进程、不缓存。 |
| `usage-stats/providers/zcodeMcpQuotaProvider.ts` | 可选数据面，任何失败降级 null，不向 entitlement 抛错。 |
| `usage-stats/providers/bigmodelUsageMonitorRange.ts` | 纯日期范围换算，无 IO、无状态。 |
| `onboarding/localUsageEvidence.ts` | 只读本机证据，结论仅用于是否弹引导，不影响业务状态。 |
| `providers/api/apiJson.ts` | 统一错误归一，纯出口；错误类型不进入持久化。 |
| `git/commitMessageFileScope.ts` | 会话改动 → 候选路径集合的纯换算。 |
| `coding-plan-subscription/codingPlanSubscriptionService.ts` | 订阅状态读取包装，无本地持久化。 |
| `plugins/installedPluginRoots.ts` | 只读 `installed_plugins.json`，失败返回空集。 |

## 3. 命令原文

快照与批次目录：`_annot_baseline/ZC-deep-svc-b28/{orig,_files.txt,spec.json}`。

```text
node d:\code\_annot_baseline\zc-insert.mjs d:\code\_annot_baseline\ZC-deep-svc-b28\spec.json
TOTAL inserted 74 comment lines

node d:\code\_annot_baseline\zc-verify.mjs --rewrite ZC-deep-svc-b28
SUMMARY files=10 rewrittenSegments=57 deletedOwnCommentLines=66 codeTokenDiff=0 headTokenDrift=0 codeDeletion=0 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0

node d:\code\_annot_baseline\zc-gate.mjs --scan d:\code\_annot_baseline\ZC-deep-svc-b28\_files.txt
SUMMARY files=10 badFiles=0 addedCommentLines=462 waterLines=0 waterRate=0.00%

node d:\code\_annot_baseline\zc-inner.mjs --repo D:/code/ZCode --roots packages/services/src --only <10 文件> --threshold 15 --fns 0
SUMMARY files=10 innerCode=1282 innerZh=167 below15=4 min=4.67 median=18.90

node d:\code\_annot_baseline\deep-quality.mjs D:/code/ZCode --files <10 文件> --quiet --top 20
SUMMARY files=10 units=833 coverage=23.5% branch=14.2% field=5.0% comments=603 substance=82.8% explain=99.7% filler=0.0% weak=0.3%
```

`zc-inner` 仍低于 15% 的 4 个文件（terminalProfile 4.67%、integratedTerminalShells 10.75%、zcodeMcpQuotaProvider 11.17%、systemService 12.82%）为本批「不设阈值」的允许项，仅记录、不补行。

## 4. 本批锚定的不变量

- `systemService`：单个目标失败不得使整批 reject；`checkedAt` 用注入时钟；套接字在 settle 前必须 destroy。
- `terminalProfile`：`terminalInheritSystemProfile === false` 时不读任何系统配置；探测失败退化为 null；`fontFamily` 永远非空。
- `integratedTerminalShells`：`id` 内嵌可执行路径且全局唯一；候选必须过 `isExecutableCandidate`；env 按 Windows 大小写不敏感解析。
- `zcodeMcpQuotaProvider`：凭证归属必须与请求 scope 精确匹配；失败一律 null；身份头只能由共享构造器生成，日志不记头值。
- `bigmodelUsageMonitorRange`：CodingPlan 日期全部按请求 `timeZone` 计算；custom 必须满足 `1 ≤ days ≤ 30`；日期键运算走 UTC。
- `localUsageEvidence`：仅 ENOENT 视为「无证据」，其他读取错误上抛；相对路径与 project 级覆盖视为「无法确定」。
- `apiJson`：错误一律收敛为 `ApiError`；请求只发一次；诊断头白名单只读不泄漏。
- `commitMessageFileScope`：`scope=null` 表示范围不可知，调用方按不过滤处理；归一化只做字符串层规整。
- `codingPlanSubscriptionService`：`getEnterprisePricing` 是唯一按 family 路由的方法；缺省 family 回落 bigmodel。
- `installedPluginRoots`：`installPath` 必须为绝对路径；单条非法只跳过该条；IO/解析失败返回空集。

## 5. 不可改项

- 不得改动任何代码 token、import 顺序、缩进与字符串；本批 `codeTokenDiff=0`、`codeDeletion=0`、`upstreamCommentDeleted=0`。
- 不得删除或改写 HEAD 中已有的上游注释；本批仅新增，或改写相对 HEAD 新增的自有注水行。
- 不得把 `null` 降级改成 `throw`（`zcodeMcpQuotaProvider`、`localUsageEvidence`、`apiJson` 的调用方依赖当前语义）。
- 不得把 `zcodeMcpQuotaProvider` 的身份头改为本地拼接，或把响应头值写进日志。
- 不得把 `bigmodelUsageMonitorRange` 的日期键运算改为本地 `Date` 或 `toISOString`。
- 不得在模板字符串内部插入注释；本批锚点均在语句行/声明行之外。
