# SVC-B11 深度注释索引（process / hooks / setting / terminal 等）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的第 31~45 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `process/processTreeTerminator.ts` | 414 | 32 → 132 | 31.88% | 100 |
| `subagents/subagentConfigScope.ts` | 328 | 11 → 106 | 32.32% | 95 |
| `skill-sync/skillSyncArchive.ts` | 307 | 1 → 95 | 30.94% | 94 |
| `fs/fsFaultInjection.ts` | 293 | 1 → 94 | 32.08% | 93 |
| `plugin-sync/pluginSyncArchive.ts` | 289 | 1 → 91 | 31.49% | 90 |
| `process/processResourceSampler.ts` | 397 | 36 → 126 | 31.74% | 90 |
| `git/gitService.ts` | 306 | 9 → 96 | 31.37% | 87 |
| `setting/settingService.ts` | 398 | 38 → 125 | 31.41% | 87 |
| `memory/memoryService.ts` | 328 | 17 → 103 | 31.40% | 86 |
| `oauth/providers/zaiProviderAdapter.ts` | 354 | 27 → 113 | 31.92% | 86 |
| `feedback/feedbackLogArchive.ts` | 298 | 11 → 95 | 31.88% | 84 |
| `terminal/terminalService.ts` | 392 | 41 → 125 | 31.89% | 84 |
| `hooks/workspaceHookSettingsModel.ts` | 268 | 0 → 84 | 31.34% | 84 |
| `plugin-ui-bridge/pluginUiBridgeService.ts` | 386 | 38 → 121 | 31.35% | 83 |
| `process/processTreeSnapshot.ts` | 306 | 19 → 98 | 32.03% | 79 |
| **合计** | **5,064** | — | — | **1,322** |

## 2. 分段

| 段 | 文件 | 内容 | 新增 |
| --- | --- | --- | ---: |
| b11a | `processTreeTerminator.ts` | graceful→force 升级、PID 复用防护、Windows 身份复核预算 | 100 |
| b11a | `skillSyncArchive.ts` | 路径/体积/类型三重校验、流销毁 | 94 |
| b11a | `subagentConfigScope.ts` | 串行 load、整体替换、事件归一、dispose 出口 | 95 |
| b11a | `fsFaultInjection.ts` | 默认不启用双开关、规则归一、命中先记后抛 | 93 |
| b11b | `pluginSyncArchive.ts` | ustar 头解析、越界/未知类型、体积上限、lstat 防软链 | 90 |
| b11b | `processResourceSampler.ts` | cputime 差分、基线 TTL、读表失败降级、归属树防环 | 90 |
| b11b | `gitService.ts` | 路径三件套、x/y 列语义、快照切三份 | 87 |
| b11c | `memoryService.ts` | 读取与容量、路径双向校验、消失失败路径 | 86 |
| b11c | `settingService.ts` | 作用域、锁内重读-合并-提交、代际防旧写、CAS | 87 |
| b11c | `workspaceHookSettingsModel.ts` | 三来源解析、非法值丢弃、根开关推导 | 84 |
| b11c | `zaiProviderAdapter.ts` | 字段映射、token 双轨、错误归一与脱敏 | 86 |
| b11c | `feedbackLogArchive.ts` | 滚动预算夹紧、realpath/inode 双校验、失败清理 | 84 |
| b11c | `pluginUiBridgeService.ts` | 在途合并键、实例回收、8 MiB 解码防线 | 83 |
| b11c | `terminalService.ts` | 生命周期、有界丢弃背压、exit/dispose 幂等 | 84 |
| b11c | `processTreeSnapshot.ts` | 单次采样一致性、/proc tick 复核、环防护 | 79 |

> 分段表按 spec 文件统计；同一文件多段合计等于上表新增。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b11
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1322
```

逐文件密度复测（`--only`，15 次全部 `PASS`，newComments 依次为 100/94/95/93/90/90/87/86/87/84/86/84/83/84/79）。

全 services 复测（b11 后）：

```text
SUMMARY files=467 coreBelow30=220 needLines=4210 min=0.00 median=30.33 newComments=25237
```

## 4. 本批锚定的不变量

- `processTreeTerminator.ts`：先 graceful 后 force，升级有等待预算；终止前复核 PID 身份，防止复用误杀。
- `skillSyncArchive.ts`：条目路径、体积、类型三重校验都通过后才落盘；失败时销毁流与临时目录。
- `subagentConfigScope.ts`：load 串行化；每次加载整体替换 value；失败不清空已有 value。
- `fsFaultInjection.ts`：默认绝不启用，必须 `ZCODE_ENV=test` 或显式 allow；命中计数先记录再抛错。
- `pluginSyncArchive.ts`：ustar 头按固定偏移解析并校验 checksum；`name/prefix` 双字段切分；解包拒绝越界与未知类型。
- `processResourceSampler.ts`：main 进程禁止读表；cputime 差分抵御 PID 复用；读表失败保留旧基线。
- `gitService.ts`：路径三件套统一；作用域过滤只在 service 层做；x/y 列语义不可混用。
- `memoryService.ts`：读取前校验路径归属；目录或文件消失走显式失败路径，不静默返回空。
- `settingService.ts`：写操作在锁内「重读-合并-提交」；代际号阻止旧写覆盖新值。
- `workspaceHookSettingsModel.ts`：三种来源按固定顺序解析；非法值丢弃而非整体失败。
- `zaiProviderAdapter.ts`：请求/响应字段一对一映射；access/refresh token 双轨；错误归一后脱敏。
- `feedbackLogArchive.ts`：滚动预算先夹紧；realpath 与 inode 双重校验；zip 写入顺序固定、失败清理。
- `pluginUiBridgeService.ts`：在途请求以合并键去重；实例失败必须回收；解码后 8 MiB 上限。
- `terminalService.ts`：输出回放有界丢弃；spawn 失败与 exit/dispose 走同一条幂等清理。
- `processTreeSnapshot.ts`：一次快照只采样一次；`/proc` tick 复核 PID；父子环必须打断。

## 5. 看似该改、其实不能改

- `processTreeTerminator` 不能去掉 PID 身份复核：复用后的 PID 会让终止操作打到无关进程。
- `skillSyncArchive` 不能边解包边落盘：校验失败会留下半装目录。
- `fsFaultInjection` 不能改成「构建环境即启用」：生产构建会随机注入故障。
- `pluginSyncArchive` 不能用 `stat` 代替 `lstat`：会跟随软链写到仓库外。
- `processResourceSampler` 不能在 main 进程读表：历史卡死正是由此产生。
- `settingService` 不能省掉代际校验：慢写会覆盖刚提交的新值。
- `workspaceHookSettingsModel` 不能因单个非法字段整份丢弃：会让用户配置静默失效。
- `pluginUiBridgeService` 不能只按 requestId 去重：同请求多实例会产生重复副作用。
- `terminalService` 不能无限缓存输出：无消费者时内存会持续增长。
