# SVC-B15 深度注释索引（bigmodel / git / providers / fs / oauth / storage / fileWatcher）

> 规范母本：`d:\code\opensource\redb\docs\annotation\DEEP-SPEC.md`（v1）
> 范围：`packages/services/src/**` 中按缺口降序的第 91~105 个文件（单批 ≤15）。
> 口径：注释行 ÷ 代码行 ≥ 30%（`deep-density.mjs --mode code --threshold 30`）。

## 1. 结果

| 文件 | 代码行 | 注释行（前→后） | 密度 | 新增 |
| --- | ---: | --- | ---: | ---: |
| `bigmodel/codingPlanEntitlement.ts` | 121 | 5 → 39 | 32.23% | 34 |
| `git/gitCheckpointService.ts` | 102 | 0 → 33 | 32.35% | 33 |
| `providers/zaiBusinessTokenResolver.ts` | 103 | 0 → 33 | 32.04% | 33 |
| `fs/atomicFileUtils.ts` | 157 | 17 → 49 | 31.21% | 32 |
| `paths.ts` | 203 | 30 → 63 | 31.03% | 33 |
| `zcode-session/zcodeSessionApiRetry.ts` | 118 | 6 → 37 | 31.36% | 31 |
| `oauth/oauthProfileSchema.ts` | 122 | 7 → 39 | 31.97% | 32 |
| `coding-plan-subscription/codingPlanSubscription.ts` | 120 | 7 → 38 | 31.67% | 31 |
| `oauth/oauthUnauthorizedRequest.ts` | 120 | 7 → 38 | 31.67% | 31 |
| `feedback/feedbackLocalTicketStore.ts` | 100 | 2 → 32 | 32.00% | 30 |
| `remote-projects/connection-membership.ts` | 97 | 2 → 31 | 31.96% | 29 |
| `project-storage/startup.ts` | 118 | 8 → 38 | 32.20% | 30 |
| `storage/adapters/fsWalker.ts` | 123 | 10 → 38 | 30.89% | 28 |
| `fileWatcher/fileWatcherService.ts` | 124 | 11 → 40 | 32.26% | 29 |
| `git/commitMessageFileScope.ts` | 84 | 0 → 27 | 32.14% | 27 |
| **合计** | **1,812** | — | — | **463** |

## 2. 分段

| 段 | 文件 | 内容 | 新增 |
| --- | --- | --- | ---: |
| b15a | `codingPlanEntitlement.ts` | 权益来源优先级、宽限期语义、无效计划降级 | 34 |
| b15a | `gitCheckpointService.ts` | checkpoint 生命周期、失败回滚边界、工作区快照一致性 | 33 |
| b15a | `zaiBusinessTokenResolver.ts` | 缓存与过期策略、失败不缓存、并发解析合并 | 33 |
| b15b | `atomicFileUtils.ts` | 同目录临时文件、fsync 顺序、rename 原子替换与 Windows 重试 | 32 |
| b15b | `paths.ts` | 仓库根推导、跨平台分隔符、归一化只做一次 | 33 |
| b15b | `zcodeSessionApiRetry.ts` | 可重试错误分类、退避上限、取消信号传播 | 31 |
| b15c | `oauthProfileSchema.ts` | 运行时校验宽松度、缺失字段兼容、解析失败不抛 | 32 |
| b15c | `codingPlanSubscription.ts` | 订阅状态派生、过期判定基准、事件只发一次 | 31 |
| b15c | `oauthUnauthorizedRequest.ts` | 401 判定、单次刷新、刷新失败清理凭据 | 31 |
| b15d | `feedbackLocalTicketStore.ts` | deviceMid 隔离、Host 标识派生、写入顺序 | 30 |
| b15d | `connection-membership.ts` | Host Worker 唯一入口、连接成员去重、离线保留 | 29 |
| b15d | `startup.ts` | 启动顺序依赖、迁移幂等、失败放行与抛出边界 | 30 |
| b15e | `fsWalker.ts` | 队列式遍历、有界并发与 fd 上限、取消契约、单目录错误降级 | 28 |
| b15e | `fileWatcherService.ts` | fs.watch 跨平台丢事件、防抖「安静期」、实例所有权 | 29 |
| b15e | `commitMessageFileScope.ts` | 范围不可知放行、路径归一化、越界与跨盘判定 | 27 |

> 分段表按 spec 文件统计；同一文件多段合计等于上表新增。

## 3. 校验原文

```text
node d:\code\_annot_baseline\zc-verify.mjs ZC-deep-svc-b15
SUMMARY files=15 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=463
```

逐文件密度复测（`--only`，15 次全部 `PASS`；最低 30.89%，最高 32.35%）。

b9~b15 七个快照在批后统一复核，全部 `deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0`。

全 services 复测（b15 后）：

```text
SUMMARY files=467 coreBelow30=160 needLines=1633 min=0.00 median=31.03 newComments=27964
```

## 4. 本批锚定的不变量

- `codingPlanEntitlement.ts`：权益来源有固定优先级；宽限期只延长「可用」不延长「可写」；未知计划必须降级而不是抛错。
- `gitCheckpointService.ts`：checkpoint 创建失败不得留下半成品引用；回滚只回退本次快照覆盖的路径。
- `zaiBusinessTokenResolver.ts`：解析失败不写缓存；并发调用共享同一在途 Promise；过期以签发时间为基准。
- `atomicFileUtils.ts`：临时文件必须与目标同目录；先 fsync 再 rename；Windows 下 rename 冲突需要重试窗口。
- `paths.ts`：仓库根只推导一次；跨平台路径统一走同一归一化函数；不做二次归一化。
- `zcodeSessionApiRetry.ts`：只重试可重试错误；退避有上限；取消信号优先于重试。
- `oauthProfileSchema.ts`：校验对未知/缺失字段保持宽松；解析失败返回空值而不是抛异常。
- `codingPlanSubscription.ts`：订阅状态由单一来源派生；过期以服务端时间为准；状态变更事件只发一次。
- `oauthUnauthorizedRequest.ts`：仅 401 触发刷新；同一时刻只允许一次刷新；刷新失败必须清理凭据。
- `feedbackLocalTicketStore.ts`：按 deviceMid 隔离数据；Host 标识由稳定派生得到；写入顺序决定可恢复性。
- `connection-membership.ts`：Host Worker 是唯一入口；成员列表按身份去重；离线成员保留不删除。
- `startup.ts`：初始化顺序不可交换；迁移可重复执行；可恢复失败放行、不可恢复失败上抛。
- `fsWalker.ts`：遍历为队列式且顺序不作保证；并发有上限以控制 fd；取消必须抛 AbortError；单目录失败降级不中断整体。
- `fileWatcherService.ts`：fs.watch 会丢事件与合并事件；防抖是「安静期」语义；Map 中实例所有权唯一。
- `commitMessageFileScope.ts`：范围不可知返回 null 表示不过滤；路径先归一化再比较；`..` 与跨盘绝对路径视为越界。

## 5. 看似该改、其实不能改

- `codingPlanEntitlement` 不能在未知计划时抛错：会让整个会话启动失败。
- `gitCheckpointService` 不能在回滚时全量 checkout：会覆盖用户本次未纳入快照的改动。
- `zaiBusinessTokenResolver` 不能缓存失败结果：一次网络抖动会钉死后续所有请求。
- `atomicFileUtils` 不能先写目标再校验：崩溃时目标文件会被截断。
- `paths` 不能每次调用重新推导仓库根：工作目录可能在中途被改变。
- `zcodeSessionApiRetry` 不能无限重试：会把上游故障放大成请求风暴。
- `oauthProfileSchema` 不能对新增字段严格报错：旧 profile 会整体不可用。
- `codingPlanSubscription` 不能按本地时间判断过期：客户端时钟不可信。
- `oauthUnauthorizedRequest` 不能并发刷新：会互相作废对方刚拿到的 token。
- `feedbackLocalTicketStore` 不能跨 deviceMid 共享目录：会造成不同设备数据串写。
- `connection-membership` 不能把离线成员立刻移除：重连后身份会重建、历史丢失。
- `startup` 不能并行执行有依赖的初始化步骤：会读到尚未建好的表/目录。
- `fsWalker` 不能无限并发：大量目录会耗尽文件句柄。
- `fileWatcherService` 不能把防抖改成固定间隔节流：仍会漏掉安静期后的最后一次写入。
- `commitMessageFileScope` 不能在范围不可知时返回空数组：会把全部变更误过滤掉。
