# ZC-DEEP-b12

> 批次：B12。基线快照：`d:\code\_annot_baseline\ZC-deep-b12a\orig`、`ZC-deep-b12b\orig`（两个子批并行，合并校验见下）。

## 校验

```
node zc-verify.mjs ZC-deep-b12a
SUMMARY files=3 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1131

node zc-verify.mjs ZC-deep-b12b
SUMMARY files=2 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=765

deep-density --only b12a
30.40  2523  1918  583  371  apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts
30.46  2020  1497  456  364  packages/ui/src/Root.tsx
32.62  1646  1220  398  396  packages/ui/src/lib/conversationTelemetryParityScenarioDefinitions.ts
SUMMARY files=3 coreBelow30=0 needLines=0 min=30.40 median=30.46 newComments=1131
PASS: all 3 file(s) >= 30% (mode=code)

deep-density --only b12b
30.77  3656  2678  824  371  apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts
32.97  1963  1374  453  394  packages/ui/src/lib/messageTelemetry.ts
SUMMARY files=2 coreBelow30=0 needLines=0 min=30.77 median=31.87 newComments=765
PASS: all 2 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts` | v4 协议桥：命令分发、admission、fork/edit/retry、冷恢复投影 | INV-1~21；依赖方向单向；executeCommand 先 supports 否则 reject；只为真正产生输入的命令写 ledger；fork bundle commit 是 PONR 之后失败不得反转；edit/retry 复用 projection 的 canonical target；只读面不写文件不起第二 runtime；子会话借父 store 但用 child sessionId；冷恢复 seq 取 getLatestSequenceNumber；workflow journal 先于内存事件 merge；高频耗时先短路；队首提升仅在空闲且目标态可证时执行 | 371 |
| `packages/ui/src/lib/conversationTelemetryParityScenarioDefinitions.ts` | 遥测对账场景数据表：case 定义与断言约束 | INV-1~27；caseId 与 SCENARIOS key 一一对应；now 单调不递减；commandId 一会话一 turn；turnId/eventId 唯一；duplicate 仅用于已有同 eventId；attach 早于 seed/turn.started；detach owner 必须匹配最近 attach；includeNetwork:false 不得断言网络指标；最小清单是下限不是精确值；断言不得由输入字段派生；proof 是 spec 锚点不可重命名 | 396 |
| `packages/ui/src/Root.tsx` | 应用根：Provider 装配、启动门禁、全局监听与兜底 | INV-1~22；Provider 依赖由外到内递增；ServiceProvider 必须在最外；Store 在 TabStore 之外；Tooltip/Lucide 包住全部 UI；安全校验与营销埋点顺序不可换；启动 loading 四条件齐全；登录门禁只收尾自己的 startup-provider-required；恢复 workspace 需算 provider 启动检查；reporter 注册必须有清理；广播监听 dispose 到具体订阅；一次性副作用用 ref 去重 | 364 |
| `packages/ui/src/lib/messageTelemetry.ts` | 消息级遥测账本：step 生命周期、usage 去重与维度采集 | INV-1~14；一 taskId 至多一个 active prompt/step；stepId 只分配一次；step.model 在建时冻结；usage eventKey 是幂等唯一屏障；pending usage 归属产生它的 requestId；permission 等待只结算一次；firstTokenAt 用 null 表示未发生且只写一次；时长出口一律 max(0)；收口后删除 step 账本；未知 taskId 静默返回；只上报标识类字段；web-remote-replayable 不算 tail finalize | 394 |
| `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts` | 插件市场：目录拉取、缓存、依赖解析与安装事务 | INV-1~16；known 注册表与目录同事务提交；缓存版本取插件 plugin.json 而非市场条目；manifest 路径经 resolveInside；最后一份安装记录才删 data；官方 id 非可信来源必须拒绝；跨市场依赖默认拒绝；依赖按拓扑序安装、有环拒绝；刷新失败写 lastRefreshFailure 但 AbortError 不写；激活 rollback/finalize 二选一；临时目录 finally 清理；产物先 staging 再原子 rename；来源切换使旧缓存失效 | 371 |

合计 **1896**（1131 + 765），与两次 `added` 之和一致。

## 关键不变量（抽取）

- v4 桥：fork bundle 提交即 PONR，提交后失败不得把已接受的子会话回滚成失败，否则投影与 transcript 矛盾。
- v4 桥：冷恢复 `sourceEventSeq` 必须取 `getLatestSequenceNumber`，不能用 `max(events.seq)`，否则漏事件或重复回放。
- 场景表：断言不得由输入字段派生，实现与断言同时写错时会互相印证，双写失去意义。
- 根组件：启动 loading 必须同时包含 auth/Provider/tab/初始 workspace 四条件，漏判会闪白。
- 遥测：usage 的 eventKey 去重是幂等唯一屏障，重放会让 token 翻倍。
- 市场：目录与注册表同事务、产物先 staging 再原子 rename，否则半成品可见。

## 进度

本批前：5 文件全部 below30（needLines=1791）。
本批后：5 文件全部 ≥30%（min 30.40%、needLines=0）。
