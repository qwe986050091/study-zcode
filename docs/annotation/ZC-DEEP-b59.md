# ZC-DEEP-b59

> 批次：B59（12 文件，复算缺口 823 行；按当前工作树复算，优先同类/同目录：`ui/src/ToolCallBlocks/renderers` 2 个、`ui/src/v4` 3 个、`ui/src/store` 2 个、`desktop/scripts/mcp-apps-host-fixture` 2 个、`desktop/src/main` 1 个、`shared/src` 1 个、`ui/src/hooks` 1 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec；插入后因密度落在 30.07%~30.40% 贴线，追加一轮补厚 39 行，终值 31.25%~31.60%。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b59\orig`；开工前 12 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b59
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=862

node check-batch.mjs ZC-deep-b59 ZC-deep-b59-files.txt
TOTAL added=862 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.25   359   256    80   70  packages/desktop/src/main/about.ts
31.25   390   272    85   74  packages/ui/src/ToolCallBlocks/renderers/read.tsx
31.27   515   371   116   72  packages/ui/src/v4/conversationTurnRenderUnits.ts
31.28   299   227    71   69  packages/desktop/scripts/mcp-apps-host-fixture/chain-combinations.ts
31.33   357   249    78   71  packages/ui/src/hooks/useClaudeSessionMigration.ts
31.34   632   434   136   74  packages/ui/src/store/index.ts
31.35   361   252    79   72  packages/shared/src/conversation-message-projection-policy.ts
31.35   337   252    79   73  packages/ui/src/ToolCallBlocks/renderers/eval-workflow-snippet.tsx
31.37   352   255    80   71  packages/ui/src/v4/conversationCuaGroups.ts
31.40   322   242    76   71  packages/ui/src/v4/agentSessionsIndexTransport.ts
31.47   397   286    90   72  packages/ui/src/store/hooksStore.ts
31.60   304   231    73   73  packages/desktop/scripts/mcp-apps-host-fixture/rows-main.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.25 median=31.34 newComments=862
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/ToolCallBlocks/renderers/read.tsx` | read 工具结果渲染 | INV-01~18；summary 解析顺序 parsed_cmd→input→raw 先命中即返回；只接受 type=read 条目；相对路径仅在存在 cwd 且非绝对时拼接；路径与文件名双缺失则跳过；raw 兜底以 rawOutput 的 path 标签为准；未标类型归 file；指示针按下即阻止默认与冒泡；点击先拦冒泡再导航 | 74 |
| `ui/ToolCallBlocks/renderers/eval-workflow-snippet.tsx` | 工作流片段求值渲染 | INV-01~18；运行中优先于失败、失败只在终态成立；按 kind 白名单取值；失败时耗时节点整体为空；运行中整秒刷新终态定格毫秒；纯空白按无代码；错误文本先上层透传再拼诊断行；内容子树按运行态分键整棵重建；结果区定高滚动；源码 details 默认收起；截断提示只在终态 | 73 |
| `ui/v4/agentSessionsIndexTransport.ts` | agent 会话索引传输层 | INV-01~18；一实例一 workspace，topic 由 identity 优先派生；握手先于任何 subscribe/resync/unsubscribe；subscribe 先占位后按 ack subscriptionId 绑定；ACK 越界/绑定失败/异常一律取消占位并回滚远端；runtimeGeneration 变化判废在途；resync 前比对 activeSubscriptionId 并让解码器进恢复态；unsubscribe 先本地释放再远端；清理幂等 | 71 |
| `ui/v4/conversationCuaGroups.ts` | CUA 消息分组纯函数 | INV-01~18；连续 CUA 工具调用归并同组；组内 rows/events 严格保持时间线顺序；组 key 优先 assistant response id 缺失退回首行 rowId；非 CUA 工具与 userInput 关闭当前组；marker 与 todo/status 不构成边界；同 response 出现非 CUA 则该 response 正文不入组；收尾按 stageTailIsRunning；关闭组同步置 completed；始终返回新数组 | 71 |
| `ui/v4/conversationTurnRenderUnits.ts` | 回合渲染单元划分 | INV-01~19；一 turnId 一单元，首行创建后续复用；输出顺序等于 turnId 首次出现顺序；turnHeader 只作边界不进 orderedRows；可见输入从 renderedRows 过滤并排除启动轮用户行；无可见内容回合丢弃但直接启动轮保留；运行中永不被空回合过滤；轮尾 marker/artifact/截图行单独切出；单元 key 只依赖 turnId；展开态以 turnHeader 为权威 | 72 |
| `ui/store/index.ts` | zustand 全局 store 汇总 | INV-01~19；全仓唯一 store，字段单一 setter；持久化先写存储再 set；仅 BROADCAST_FIELDS 五字段跨窗同步；applyingBroadcast 期间禁止回写；authSessionSeq 仅在未登录转登录时自增；登录请求 id 闭包单调分配并按 id 续接；额度重置三表按 source 分桶不持久化；自动播放 reserve/commit/release 两段式；字号夹 12~20；主题切换先解绑旧监听 | 74 |
| `ui/store/hooksStore.ts` | 工作区钩子 store | INV-01~18；只投影单 workspace 切换整份替换；派生 key 由 path/identity/authorityKey 共同决定；异步写回前重算 key；loading 全局单字段；同 key 并发初始化只发一次；写操作乐观更新→持久化→失败回滚；回滚前确认 workspace 未漂移；持久化后重新拉取以磁盘为准；仅 zcode 来源可导入；选择器不新建对象 | 72 |
| `desktop/scripts/mcp-apps-host-fixture/rows-main.ts` | MCP apps 夹具行数据主流程 | INV-01~19；检查串行，前一场景失败即整批中止；只有 run 完整成功才计 PASS；行只经 window.setRows 注入真实时间线；行 id 同时是顺序与时间戳基准；errors 固定 5 条保留空洞位；失败行覆盖 isError/error/cancelled 三形态；首轮 pin 只对成功行生效；mixed 固定交替序列；全程单 guest；opens 用相对增量断言；退出前关闭环境 | 73 |
| `desktop/scripts/mcp-apps-host-fixture/chain-combinations.ts` | MCP apps 夹具组合场景 | INV-01~18；组合场景固定顺序串行；审批等待只按调用键匹配；事件等待同时匹配 type 与 key；执行次数取实时过滤计数且只接受 1；取消参数从调用流水反查原始入参；二次取消必须 false；取消键命中多于一条即抛错；moving 固定 12 次切换且奇偶页读数对齐首轮；切换期间句柄与 guest 身份不变 | 69 |
| `desktop/src/main/about.ts` | 关于窗口 | INV-01~19；一次「关于」只建一个自绘窗口；父窗口可用性只判定一次并同源喂 parent 与 modal；版本优先 build-meta.json、编译期常量兜底；元数据缺失或非法返回 null 不抛错；路径以 import.meta.dirname 为基准；空值收敛 unknown；未知 locale 回退；Apple Silicon 优化行仅 darwin+arm64；credits 空时整个键不写入；先隐藏首帧就绪再显示 | 70 |
| `shared/conversation-message-projection-policy.ts` | 会话消息投影策略 | INV-01~19；五档互斥完备；分层判定按固定优先级短路；压缩摘要与 info.summary 一律归上下文；真实用户输入要求来源真实非合成且非 model-only；model-only 可见性或任一部分归上下文；时间线事件与 fork 通知归时间线；synthetic 白名单按前缀；未命中按角色兜底；全函数只读入参；未知 kind/type 保守保留 | 72 |
| `ui/hooks/useClaudeSessionMigration.ts` | Claude 会话迁移 hook | INV-01~19；仅桌面端声明迁移能力，Web 端固定不支持；扫描与导入前再次校验 supported；待导入为零直接返回 null；current 无工作区归 all；扫描上限 unlimited 或 1~500；all 传 undefined 而非 0；时间窗口按调用时回推；扫描成功后勾选集只保留仍存在的会话；扫描失败只写 scanError 不清列表；进行标记 finally 复位 | 71 |

合计 **862**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. store 全仓唯一且字段单一写入者

`store/index.ts` 规定只有 `createZCodeStore` 产出的 store，字段只能经唯一 setter 写。
另建第二份 store 会让两个窗口的登录态与主题各自漂移，界面显示与真实会话不一致。

### 2. 广播期间禁止回写

`store/index.ts` 在 appliesBroadcast 时置 `applyingBroadcast`，期间远端字段变更只回调本地 setter。
直接改 state 会形成广播回环，两个窗口互相触发同步导致状态抖动。

### 3. 传输握手先于一切订阅 RPC

`agentSessionsIndexTransport.ts` 强制握手早于 subscribe/resync/unsubscribe。
先订阅后握手会让 ack 的 subscriptionId 无法绑定，索引流永久停在旧快照。

### 4. 夹具行 id 同时是顺序与时间戳基准

`rows-main.ts` 的 `createdAt`、`createdAtSeq`、`toolCallId` 全由行 id 派生。
让 id 与时间戳各自独立生成，夹具时间线会出现乱序，验证结论不可复现。

### 5. 组合场景必须串行

`chain-combinations.ts` 逐条 await，前一场景失败即整批中止。
并发跑用例会让失败被后续 PASS 掩盖，结果文件与真实状态不符。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 另建第二份 zustand store | 两窗口登录态与主题各自漂移 |
| 广播期间直接改 state | 同步回环导致状态抖动 |
| 订阅早于握手 | 索引流停在旧快照 |
| 夹具行 id 与时间戳独立生成 | 时间线乱序、结论不可复现 |
| 组合场景并发执行 | 失败被后续 PASS 掩盖 |
| read 渲染跳过 cwd 拼接 | 相对路径芯片点开定位错误 |
| 片段渲染用未知 kind 直接取值 | 异常形状导致白屏 |
| CUA 分组让 marker 关闭组 | 连续操作被切成碎片 |
| 回合单元 key 用行号 | 重排后整轮重挂载、展开态丢失 |
| hooks 回滚未校验 workspace | 切库后把旧数据写回新库 |
| 关于窗口元数据抛错 | 点「关于」无反应 |
| 迁移扫描失败清空候选 | 用户勾选全部丢失 |

## 顺延

B59 复算清单共 20 个候选，本批取 12 个，其余顺延到 B60，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 本批首轮密度 30.07%~30.40% 贴线，按 31.3% 目标追加补厚 39 行后复校，终值 31.25%~31.60%，`suspicious=0`。
