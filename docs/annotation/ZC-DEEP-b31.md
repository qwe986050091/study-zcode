# ZC-DEEP-b31

> 批次：B31（12 文件，跨 4 个模块，按「同模块优先」拆为 B31-A / B31-B 两个子批各自校验）。
> B31-A：`packages/shared` 3 文件 + `apps/zcode-cli` 3 文件（+864 行）；
> B31-B：`packages/ui` 3 文件 + `packages/desktop` 3 文件（+843 行）。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b31\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b31
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1707

node check-batch.mjs ZC-deep-b31 ZC-deep-b31a-files.txt
TOTAL added=864 hardBad=0 suspicious=0

node check-batch.mjs ZC-deep-b31 ZC-deep-b31b-files.txt
TOTAL added=843 hardBad=0 suspicious=0
```

逐文件密度（列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.45   675   512  161  146  packages/shared/src/task-realtime-core.ts
31.55   732   504  159  143  packages/shared/src/coding-plan-subscription.ts
31.46   681   515  162  140  packages/shared/src/zcode-protocol-legacy-types.ts
31.53   955   701  221  148  apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-telemetry-facts.ts
31.52   869   644  203  145  apps/zcode-cli/packages/adapters/src/model/runner-generate.ts
31.40   851   621  195  142  apps/zcode-cli/packages/core/src/runtime/methods/events.ts
31.40   738   535  168  146  packages/ui/src/feedback/feedbackSubmissionJob.ts
31.45   791   585  184  142  packages/ui/src/root/useRootPlatformEffects.ts
31.48   639   467  147  135  packages/ui/src/ToolCallBlocks/renderers/cua.tsx
31.50   598   454  143  139  packages/desktop/scripts/mcp-apps-host-fixture/managed-renderer.tsx
31.48   837   594  187  139  packages/desktop/src/main/editors.ts
31.43  1185   875  275  142  packages/desktop/src/preload/index.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.40 median=31.47 newComments=1707
PASS: all 12 file(s) >= 31% (mode=code)
```

开工前 12 文件基线均为 `newComments=0`（无半插入残留）；`zc-verify` 的 `added=1707`
与两组子批 `check-batch` 合计（864 + 843）一致，也与逐文件目标合计一致。
`// INV-` 条数：14~20 条/文件。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/shared/src/task-realtime-core.ts` | 任务实时通道的跨端共享核心：信封 schema、`workspaceKey` 身份、投递与租约 | INV-01~18；信封 strict 与唯一 passthrough 并存；`workspaceKey` 必须同时比对路径与身份；runId/traceId 同源；租约只对同实例生效 | 146 |
| `packages/shared/src/coding-plan-subscription.ts` | 编码套餐的供应商枚举、支付分流、报价与可购性判定 | INV-01~16；provider 六枚举穷尽；境内/海外支付分流；报价整单与月均双口径；`canPurchase` 三态；未知 provider 走 Partial 静态兜底；企业币种钉死 CNY | 143 |
| `packages/shared/src/zcode-protocol-legacy-types.ts` | 旧版协议类型词表与向后兼容联合 | INV-01~16；legacy 类型不得删；可选字段必须保持宽；字面量联合的穷尽映射；默认值口径向后兼容 | 140 |
| `.../zcode-protocol-v4/conversation-telemetry-facts.ts` | 从会话事件流单向派生遥测事实表 | INV-01~18；事实只读派生、不回写事件流；`null` 与 `0` 语义不同；有界表按 LRU 写序淘汰；turn/session 两级前缀清理 | 148 |
| `apps/zcode-cli/packages/adapters/src/model/runner-generate.ts` | 模型生成的请求装配、流式解析、重试与用量归集 | INV-01~18；票据 finally 归还且退避前释放；abort 立即拒绝；usage 单次取值；签名修复只改副本且只做一次；空完成独立计数；off-peak 排队不耗预算 | 145 |
| `apps/zcode-cli/packages/core/src/runtime/methods/events.ts` | runtime 事件方法：落库、广播、聚合与终态投影 | INV-01~20；事件先落库后广播；`eventStore` 补号是唯一事实源；高频事件聚合阈值与冲刷边界；`lastOutcome` 终态映射；sink 逐个隔离 | 142 |
| `packages/ui/src/feedback/feedbackSubmissionJob.ts` | 用户反馈提交任务：单飞、进度、取消与清理 | INV-01~16；单飞启动与序号同源；注册表先写后广播；paused-log 不可关闭；取消优先于后端返回；工单号不可回退；活跃进度标识三处同时清空 | 146 |
| `packages/ui/src/root/useRootPlatformEffects.ts` | 根组件平台副作用装配与清理 | INV-01~16；引导幂等闸门；事件注册与清理必须成对；可选通道空函数兜底；分享导入双槽闸门与进度节流；严格模式双挂载只执行一次 | 142 |
| `packages/ui/src/ToolCallBlocks/renderers/cua.tsx` | 电脑控制工具调用的结果渲染器 | INV-01~16；结果联合穷尽分支；未知状态兜底不崩；截图/坐标缺失时降级；列表 key 不得用下标 | 135 |
| `packages/desktop/scripts/mcp-apps-host-fixture/managed-renderer.tsx` | MCP App 宿主 fixture 的受控渲染器 | INV-01~14；消息来源白名单；通道订阅与释放成对；假计时器隔离；fixture 参数不回流生产路径；单次 `createRoot` | 139 |
| `packages/desktop/src/main/editors.ts` | 桌面端外部编辑器探测与拉起 | INV-01~16；`execFileSync` 全数组传参不拼串；候选路径只来自静态表与环境变量；不存在即降级剔除；图标三级降级返回 null；临时目录 finally 清理 | 139 |
| `packages/desktop/src/preload/index.ts` | 预加载桥：向渲染进程暴露最小 IPC 能力面 | INV-01~18；contextBridge 白名单最小暴露；通道名常量禁止拼接；订阅必须返回退订函数；错误跨桥丢失 stack；MessagePort 只能 transfer；schema 校验失败即关端口 | 142 |

合计 **1,707**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 「派生事实」不允许反向写回

`conversation-telemetry-facts.ts` 的所有事实都从事件流单向投影出来。一旦允许事实表反向补写事件，
冷恢复与实时路径就会出现两份互相矛盾的真相；正确做法永远是「事件流是唯一事实源，事实表可随时重建」。
同一批里 `events.ts` 的 `eventStore` 补号同理：补号只发生在落库侧，广播侧只读。

### 2. 身份键 = 路径 + 身份，二者缺一不可

`task-realtime-core.ts` 的 `workspaceKey`、`coding-plan-subscription` 的供应商选择、`useRootPlatformEffects`
的活动会话去重，都遵循同一条：只比路径会让远端与本地同路径互相串台；只比身份会让同机器的两个工作区
共享订阅。这是本工程里重复出现次数最多的故障模式。

### 3. 流式路径上的「一次性」资源必须显式释放

`runner-generate.ts` 的票据在 `finally` 归还，且必须早于退避等待；`preload` 的订阅必须返回退订函数；
`managed-renderer` 的通道与 root 必须成对释放。流式路径的特点是「正常结束」不是唯一的出口——
abort、超时、解析失败都会提前离开，因此释放只能放在 `finally`，不能放在成功分支末尾。

### 4. 桥接层的错误语义会衰减

`preload/index.ts` 对错误对象跨桥序列化后 stack 与自定义字段会丢失，因此桥两侧的契约必须只依赖
「可枚举的消息 + code」，不能依赖 `instanceof` 或错误子类。同理 `cua.tsx` 对工具结果只按
discriminated union 的 tag 分派，未知 tag 必须走兜底而不是抛错——渲染层不能因为后端新增状态而白屏。

### 5. 旧类型不是死代码

`zcode-protocol-legacy-types.ts` 里的可选字段与旧联合分支看起来「没人用」，实际上是被旧版客户端与
历史持久化数据依赖的兼容面。删除或收窄字段类型不会在类型检查里报错，但会让冷恢复的旧会话解析失败。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 事实表反向写回事件流 | 冷恢复与实时路径出现两份矛盾真相 |
| `workspaceKey` 只比路径 | 远端与本地同路径会话串台 |
| 只比身份不比路径 | 同机两个工作区共享订阅，事件互相污染 |
| 票据在成功分支末尾归还 | abort/超时时票据泄漏，配额不回收 |
| 退避等待期间不释放票据 | 限流时并发额度被自己占满 |
| usage 累加两处 | Token 统计翻倍，账单对不上 |
| 签名修复改了原对象 | 后续重试携带被改写过的请求 |
| 事件先广播后落库 | 崩溃后前端有、库里没有，序号断层 |
| 聚合阈值/冲刷边界写反 | 高频事件丢失或内存持续增长 |
| 取消不抢占在途请求 | 用户点取消后旧结果仍然落库 |
| 进度标识只清一处 | 任务结束后侧栏一直转圈 |
| 副作用注册不返回清理 | 热更新后监听器成倍增长 |
| 严格模式不做幂等 | 开发环境下初始化跑两次，出现双份数据 |
| 工具结果未知 tag 直接抛错 | 后端新增状态导致整块白屏 |
| 列表 key 用下标 | 状态错位，展开的卡片跳到别的行 |
| 消息来源不校验 | 任意 iframe 都能驱动宿主 |
| 临时目录不在 finally 清理 | 长期运行后磁盘被图标缓存占满 |
| 通道名用字符串拼接 | 重命名后静默失联，无报错 |
| 订阅不返回退订函数 | 组件卸载后回调仍触发，写入已销毁状态 |
| 错误依赖 instanceof | 跨桥后判断恒为 false，错误分支永不生效 |
| 删除 legacy 可选字段 | 旧会话冷恢复解析失败 |

## 顺延

B31 复算清单为 14 文件，本批按「同模块优先」取 12 个：
`packages/provider/src/config/model-config.ts`（缺口 140）与
`apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts`（缺口 128）顺延到 B32。

> 说明：本批按新防超限规则执行——每文件单独一份 spec（≤150 行），6 文件一组并行，
> 每组插完立即跑该组 `check-batch` 与单文件密度，未出现长输出。
> `managed-renderer.tsx` 首轮少 1 行，用补充 spec（`spec-b31b-4b.json`）补齐，未做删改。
