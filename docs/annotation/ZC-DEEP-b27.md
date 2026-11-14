# ZC-DEEP-b27

> 批次：B27（计划 12 文件 / 缺口 1,984 行，本批取缺口前 8 个）。
> 覆盖四条链路：用量库的合并语义、v4 会话传输与电脑控制设置、Provider 导航派生、
> 以及会话门面、远端部署、设置 schema 与分组列表投影。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b27\orig`。
> 规范母本：[ZC-DEEP-CORE-PLAN.md](./ZC-DEEP-CORE-PLAN.md)（第 5 节固定动作）。

## 校验

```
node zc-verify.mjs ZC-deep-b27
SUMMARY files=8 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1256

deep-density --baseline ZC-deep-b27/orig --ext .ts,.tsx --threshold 30 --mode code
31.53   959   704  222  160  apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts
31.50   794   600  189  159  packages/ui/src/v4/agentConversationTransport.ts
31.49   977   724  228  158  packages/ui/src/settings/ComputerUseSection.tsx
31.46   754   553  174  156  packages/ui/src/settings/model-provider-section/useModelProviderNavigation.ts
31.48  1131   845  266  159  apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts
31.48   916   667  210  156  packages/server/src/remote/deploy.ts
31.49   850   616  194  155  packages/shared/src/validationAppSettings.ts
31.54   660   501  158  153  packages/ui/src/project-sidebar/TaskGroupedView.tsx
SUMMARY files=8 coreBelow30=0 needLines=0 min=31.46 median=31.49 newComments=1256
PASS: all 8 file(s) >= 30% (mode=code)
```

列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`。
每个文件 `// INV-` 均为 20 条。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `.../session-store/repositories/usage.ts` | model/turn/tool 三张用量表的写入、保留期清理与两类聚合 | INV-01~20；input 侧优先 inputTokens、为 0 才回退 cache 读写和；历史行 cache 归属用 providerTotalTokens 距离判定；computed_total 缺失时按 input+output；model_usage 覆盖全列不做 coalesce；turn_usage 的 started_at 取 min、终态字段 coalesce 且方向成对；计数类直接覆盖不累加；tool 终态不被迟到 running 回退；tool_name 为 unknown 不覆盖；字节类只取 max；toolUsageValues 与 insert 列逐项对应；prune 三表同事务；计数入库前归一为非负整数；三态布尔写 NULL；时间窗口闭区间；按日分桶只用固定偏移；avg 无样本返回 null；days 三类来源喂同一 dayMap；task usage 只累加超基线增量且基线随之下调；cache 只对非基线来源累加；modelRequestCount 是行数不是成功数 | 160 |
| `packages/ui/src/v4/agentConversationTransport.ts` | v4 conversation 协议面到 IZCodeAgentService 的桥：握手、订阅所有权、帧投递与 runtime 失效 | INV-01~20；无法解析 topic 必须返回 rejected Promise；barrier.begin 必须在 ensureHandshake 之后；mismatch 只 cancel 本地 pending、绝不调 unsubscribe；bind 失败先撤销 host subscription 再抛；topicBySubscriptionId 只在 bind 成功后写；activate 先 discard 再删映射；resync 先 recover 再发 RPC；resync 只接受本实例登记的 subId；unsubscribe 先释放本地 ownership 再 await；RPC 失败不回滚 ownership；能力检查先于发命令；每条 RPC 都展开 workspace 定位参数；attachmentRead 的 signal 检查点不可删；预览分片上限用 attachmentPreviewMaxChunks；totalBytes/mediaType 首赋即锁；nextOffset 必须连续且终帧等于 totalBytes；上游 attach 幂等且 listener 归零才 dispose；restart 只处理本 workspaceKey 且先清三件套；unavailable 不递增 generation；本地 TTFT 校准只在无 workspaceIdentity 时执行 | 159 |
| `packages/ui/src/settings/ComputerUseSection.tsx` | 设置页「电脑控制」分区：插件总开关、输入框入口与 macOS 两项 TCC 权限 | INV-01~20；本机权限查询路径只取 localWorkspacePath 回落 workspacePath；按钮文案跟随 settled；availableStatus 必须经可用性过滤；总开关只读插件 store；插件初始化只执行一次且三个前置齐全；Helper 重启 single-flight；重启副作用必须完成但 setState 受 contextKey 约束；主动探针每轮最多排一个；applyPendingGrant 先 await 在途 restart；claim 每个 await 后都要复核；所有 setState/toast 先判 mounted；卸载与切 workspace 都要 cancel onboarding；插件切换完成回调同时校验 generation 与 contextKey；openPermissionSettings 有 operationId 或 token 即早退；点击边沿必须重新查 Helper；不可用重试四项校验；重试后让出 macrotask 再判定；只有 denied 徽章可点击；持久化默认值用 `!== false`；乐观开关失败回滚 override 并清 saving | 158 |
| `.../model-provider-section/useModelProviderNavigation.ts` | Provider 设置页左侧导航的纯派生：preset/codingPlan/custom 三类节点 | INV-01~20；选中态只由外部持有；navigationGroups 依赖必须含 intl；编码套餐按 providerFamilyDomain 过滤；团队连接匹配必须同时校验 organizationId 与 projectId；start-plan 永不匹配任何具体项；连接方式计算里 pending 覆盖已保存；teamPlanSelections 只挑 team-coding-plan；navigationItems 去重靠 key；selectable 只过滤 codingPlanLoading；familyConnectionSettingsLoading 时 resolve 返回 null；读取失败不按 family 回退也不返回 null；非法连接回退不写偏好；默认落点优先级固定；family preset 消失回落 initialSideNodeKey；只有选中不在侧栏集合时才改写；两套 key 集合不能合并；preset 状态灯按具体 providerId 回查；只有 plan/teamPlan 才点灯；无 family spec 的连接项直接返回 item.key；custom 不参与 family 匹配 | 156 |
| `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts` | 把 store/Provider 视图/MCP/execution 端口装配成 ZCodeApp 的会话读写面 | INV-01~20；close 只释放 owns* 为真的资源；closePromise 是唯一幂等闸门；beginShutdown 在任何 await 前同步执行；停 dwf run 夹在 beginShutdown 与资源关闭之间；dwf 关闭失败只 warn；session store 必须最后关；四个资源并行关闭且各自带 deadline；closeSessionResources 永不向调用方抛错；模型选择只有一个事实源；transient 切换只改 runtime；持久化的是已生效选择；saveSessionEntry 必须 touchSession=false；持久化失败只 warn 不回滚；setTarget 先走统一执行边界；cleared 也要投影 target:null；target 存 canonical、消息存 display；读 target 前先补中断 run 收口；owned=false 不提供档位；MCP App 工具审批后复核 identity 与 generation；App 工具替换先全量注销再逐条注册 | 159 |
| `packages/server/src/remote/deploy.ts` | 远端部署编排：版本探测、资源包选择、installer、远端锁与释放 | INV-01~20；部署决策必须在拿到远端锁后重算；caller-serialized 不建远端 lock-holder；该模式只能由已具备 single-flight 的调用方注入；部署与释放双失败抛 AggregateError；释放单独失败也必须上抛；部署失败仍必须释放；锁内决策不复用锁前结果；本地 manifest 在锁内首次需要时解析；mock 缺文件回退 CDN 与决策共用同一快照；releaseDir 缓存键含组件集合与 forceRefresh；版本相同仍补齐 node-pty；SHA marker 只在安装成功后写；app 版本变化必须 forceRefresh；glm 强刷标记先于 server 更新持久化；只在 force/待刷新/版本变化时写 pending；server 版本不同先于身份校验返回；检查失败视为需要部署；node 或 server 缺失先于版本探测返回；expectedSha256 为空跳过校验；资源包选择在入口一次性归一 | 156 |
| `packages/shared/src/validationAppSettings.ts` | 设置 schema：形状、默认值、读取期迁移与 patch 校验 | INV-01~20；完整 schema 必须声明所有可持久化字段；patch 与完整 schema 字段集同步；locale 与 localePreference 是两个事实；每个迁移必须幂等；marker 缺省与未迁移语义一致；读取只丢弃坏字段；patch 保持严格校验；preprocess 组合顺序固定；lastWorkspaceSession 是唯一真相源；迁移后必须 delete 旧字段；历史资源包 ID 先剥离再解析；内置 Agent CLI provider 归一为 ZCode Agent；onboarding 版本迁移并回写旧值 2；taskAutoArchive 只重置一次；初始化标记与值同一次写入；zcodeEndpointOrigin 坏值只删字段；desktopWindowSize 校验失败只丢该字段；枚举容错用 optional+catch；remoteStartupAutoReconnectEnabled 必须 optional；nonEmptyStringSchema 统一 trim | 155 |
| `packages/ui/src/project-sidebar/TaskGroupedView.tsx` | 分组列表的展示投影：选择、移动、重命名、归档与草稿动作 | INV-01~20；workspaceKey 必须 identity 优先 path 兜底；分组结构只读权威视图或 drag 投影；草稿归属只来自 store 与草稿内存；有 activeTaskId 时不读 draftTaskGroupId；折叠集合持久化在 effect 中；折叠集合不可变更新；移动命令基于 authoritativeView；拖动只改投影；移动失败必须 refresh；归档成功后移除 task state；mutate 后无条件 refresh；dragging 时清空 sticky；sticky 同时监听 scroll/resize/ResizeObserver；清理必须取消 frame 并断开 observer；首帧无 overflow 不能提前 return；自动化分组新建直接回调；新建任务前先展开目标分组；关闭草稿同时清持久与内存归属；onSelect 必须带解析出的 remoteSessionId；rowCallbacks 每次渲染重建不 memo | 153 |

合计 **1,256**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 「合并语义」写错不会报错，只会让报表静默失真

`usage.ts` 的二十条 INV 全部围绕三张表的 on conflict 语义：
- `model_usage` **覆盖全列**（不做 coalesce），`turn_usage` 终态字段**用 coalesce**——两者相反，写反都会让重试/迟到帧污染聚合；
- `tool_usage` 的终态只升不降、`tool_name` 为 unknown 不覆盖；
- 计数入库前统一归一为非负整数（NaN/负数会让整张报表归零）。

最隐蔽的是 INV-01/02：AI SDK v6 的 `inputTokens` 已含 cache，历史行不含，
所以「input 侧」的计算必须按 `providerTotalTokens` 的距离判定行格式，而不是无条件相加。

### 2. 订阅所有权必须先本地释放、再发 RPC

`agentConversationTransport.ts` 的规则可以概括为「本地的账先记、远端的账后跑」：
- `unsubscribe` 先 forget + discard + 删映射，再 await RPC（否则 RPC 挂起期间仍在投帧）；
- RPC 失败**不回滚** ownership（回滚会重建幽灵订阅，之后没人能再退订）；
- runtime restart 时先清 barrier/decoder/映射再通知监听者（否则新 runtime 首帧被吞）。

`stale_ack` 分支只 cancel 本地 pending、绝不调 unsubscribe——这是最容易「顺手补全」却会误杀别人订阅的一行。

### 3. 双层「读取容错 / 写入严格」

`validationAppSettings.ts` 的读取路径（sanitize*、optional+catch）与写入路径（patch schema）容错策略相反：
读取只丢坏字段，写入必须拒绝坏值。
三条最容易破坏幂等的细节：迁移必须靠 marker 判定、迁移后必须 delete 旧字段、初始化标记必须与值在同一次迁移里写入。
任何一条缺失都会产生「每次读取都重置用户选择」或「升级时突然归档历史会话」。

### 4. 「跳过」与「失败」必须用不同类型表达

`deploy.ts` 的总纲：抛出 = 部署失败，`false` = 命中跳过，绝不用 `false` 编码失败。
围绕它的一组顺序约束：决策必须在远端锁内重算、部署失败仍必须释放、释放单独失败也必须上抛、
双失败抛 AggregateError（否则释放错误覆盖部署根因）。
检查失败一律视为「需要部署」——把网络错误当成「已部署」会让远端长期停在坏状态。

### 5. 组件只投影，不持有第二份业务事实

`TaskGroupedView.tsx` 与 `useModelProviderNavigation.ts` 是同一条原则的两个面：
前者区分「权威视图 / 拖动投影 / 临时交互态」三层，任何写入都必须回到 action；
后者把选中态完全交给外部 `selectedNodeKey`，hook 只在失效时回调修正。
`ComputerUseSection.tsx` 再加一条：总开关只读插件 store 的 enabled，不维护本地副本——
双份真相的典型表现是「UI 显示已开启，插件实际未启用」。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| input 侧无条件叠加 cache | 新格式行重复计数，task 用量虚高 |
| model_usage 改用 coalesce | 重试只带部分字段时旧错误码/耗时残留 |
| turn_usage 把 completed_at 写回 null | 前端永远转圈 |
| 计数类字段在 SQL 里 sum | 同一轮重复上报即翻倍 |
| tool 终态允许被 running 回退 | UI 永久等待、错误率失真 |
| 负数/NaN 未归一就入库 | 报表静默归零 |
| avg 的 null 折成 0 | 「平均 0ms」与「无数据」不可区分 |
| 按日分桶读数据库时区 | 跨时区机器给出不同日曲线 |
| barrier.begin 早于握手完成 | ACK 后投递不属于该订阅的旧帧 |
| stale_ack 分支调 unsubscribe | 杀掉新 runtime 上别人的活跃订阅 |
| bind 失败仍返回可 activate 的 ACK | 缺片批被当成完整快照 |
| unsubscribe 先 await 再释放本地 | 已卸载会话继续收帧 |
| unsubscribe 失败回滚 ownership | 重建幽灵订阅，永久无法退订 |
| 漏传 workspace 定位参数 | 远程会话按路径落到本地 host |
| 预览分片沿用上传事务的 64 | 20MiB 以上视频无法预览 |
| totalBytes 中途改变不报错 | 两个版本字节拼成一个文件，损坏但不报错 |
| 用远端路径查本机 Helper | 权限状态永远 unknown |
| 重启不 single-flight | 并发轮换 broker 凭据，Helper 半死 |
| 只读插件 store 之外再存副本 | UI 显示已开启，插件实际未启用 |
| 乐观开关失败不回滚 | 重启后按钮回弹 |
| pending 不覆盖已保存连接 | 用户点了套餐没有反应 |
| 默认落点优先级被打乱 | 有权益的用户被丢进 Start Plan |
| start-plan 被当成可恢复连接 | 侧栏落点错到套餐节点 |
| 共享 store 被 close | 其它 App 立即读写失败 |
| close 并发无幂等闸门 | 端口被二次关闭 |
| 停 dwf run 放到资源关闭之后 | journal 已关，无法写 stopped |
| 部署决策复用锁前结果 | 等待者覆盖别人刚写完的部署 |
| 把 false 编码成失败 | 调用方重试一次本已跳过的部署 |
| 释放失败被吞 | 锁泄漏但调用方以为成功 |
| 检查异常当成已部署 | 远端长期停在坏状态 |
| 版本相同不补 node-pty | prebuild 被清理后运行时才崩 |
| SHA marker 在安装前写 | 失败重试把旧 server 误判为当前制品 |
| 读取期把坏字段升级成整份回退 | 一个坏偏好清空全部设置 |
| patch 复用宽松规则 | 坏值获得持久化通道 |
| 迁移后不删旧字段 | 每次读取重复迁移，条目翻倍 |
| familyConnectionSettingsLoading 时不返回 null | 首次 hydrate 前先闪 Start Plan |
| 折叠集合原地修改 Set | 不触发重渲染 |
| 移动用 drag 投影生成命令 | 命令带上临时顺序 |
| mutate 后不 refresh | 本地与服务端长期不一致 |
| sticky 只监听 scroll | 展开动画后尺寸变化不再更新 |

## 顺延

本批从 B27 计划清单的 12 个文件中取缺口前 8 个，其余条目由
`zc-next-batches.mjs` 在 B28 开工前复算。

> 说明：本批开工前对 8 个目标文件逐一做了基线校验（`newComments=0`），确认无半插入残留。
> 两个文件首插行数有偏差（162 / 152），均按快照整文件还原后调整块行数重做，
> 未在半插入状态上叠加。
