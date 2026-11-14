# ZC-DEEP-b35

> 批次：B35（12 文件，跨 7 个模块；本批优先消化 B34 顺延的 5 个文件，再补 7 个）。
> B35-A：desktop scripts 2 + client 1 + shared 1 + office-runtime 1 + server 1（+711 行）；
> B35-B：`packages/ui` 6 文件（+712 行）。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b35\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b35
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1423

node check-batch.mjs ZC-deep-b35 ZC-deep-b35a-files.txt
TOTAL added=711 hardBad=0 suspicious=0

node check-batch.mjs ZC-deep-b35 ZC-deep-b35b-files.txt
TOTAL added=712 hardBad=0 suspicious=0
```

逐文件密度（列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.28   519   390  122  118  packages/ui/src/store/subagentsStore.ts
31.33   510   383  120  118  packages/desktop/scripts/gen-ui-fixture/presentation-checks.ts
31.38   517   392  123  118  packages/ui/src/project-sidebar/index.tsx
31.38   596   427  134  116  packages/server/src/http.ts
31.40   517   379  119  119  packages/ui/src/git-branch-switcher/GitBranchDialogs.tsx
31.40  1011   742  233  121  apps/zcode-cli/packages/office-runtime/ui/main.tsx
31.41   503   382  120  119  packages/client/src/webRemoteControlAcknowledgedRelayProtocol.ts
31.44   510   388  122  119  packages/desktop/scripts/mcp-apps-host-fixture/chain-main.ts
31.45   507   372  117  117  packages/ui/src/onboarding/OnboardingFlowParts.tsx
31.46   543   410  129  120  packages/ui/src/project-sidebar/ProjectNodeContent.tsx
31.49   536   397  125  120  packages/ui/src/v4/telemetry/conversationTelemetryParityE2E.ts
31.52   544   387  122  118  packages/shared/src/source-server/contracts.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.28 median=31.41 newComments=1423
PASS: all 12 file(s) >= 30% (mode=code)
```

开工前 12 文件基线均为 `newComments=0`；`zc-verify` 的 `added=1423`
与两组子批 `check-batch` 合计（711 + 712）一致，也与逐文件目标合计一致。
`// INV-` 条数：12~20 条/文件。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `desktop/scripts/mcp-apps-host-fixture/chain-main.ts` | MCP App 宿主 fixture 的消息链验证 | INV-01~17；同页并发 prepareSandbox 只注册一次；app-only 结果不截断；审批通过不产生对话轮次 | 119 |
| `desktop/scripts/gen-ui-fixture/presentation-checks.ts` | UI fixture 的展示回归断言 | INV-01~12；preview 先查四角再读复制按钮；按钮初始必须可用；复制后剪贴板必须非空 | 118 |
| `client/src/webRemoteControlAcknowledgedRelayProtocol.ts` | Web 远程控制的带确认中继协议 | INV-01~14；`messageSeq` 单调且整批只确认一次；ack 严格大于水位才生效；ack 不得超前于已发送帧 | 119 |
| `shared/src/source-server/contracts.ts` | Source Server 连接契约的 zod schema | INV-01~12；对象 schema 一律 strict；新增字段必须 optional/default；枚举封闭、未知值拒绝 | 118 |
| `apps/zcode-cli/.../office-runtime/ui/main.tsx` | Office 运行时 UI 入口与宿主桥 | INV-01~14；旧加载结果不得覆盖新文档；四态最多一个主导画面；工具结果按到达顺序排空且取走即清空 | 121 |
| `server/src/http.ts` | 本地 HTTP/WS 服务与鉴权中间件 | INV-01~12；鉴权路径前缀与三种凭证口径；未配置 token 不注册中间件；`/ws` 恒为可重放客户端模式 | 116 |
| `ui/src/v4/telemetry/conversationTelemetryParityE2E.ts` | 会话遥测双路径一致性 E2E | INV-01~20；同一 caseId 两侧解析一致；场景操作按表顺序应用；minimum 清单只作下限比较 | 120 |
| `ui/src/git-branch-switcher/GitBranchDialogs.tsx` | 分支创建与助手两阶段对话框 | INV-01~16；创建框 open 只来自 props；助手框要求 step 与 state 同时非空；两阶段互斥 | 119 |
| `ui/src/project-sidebar/ProjectNodeContent.tsx` | 项目树节点内容与三种形态分派 | INV-01~15；远程/legacy/普通三态穷尽；remoteHost 决定远程与否；主目录失效只禁用动作 | 120 |
| `ui/src/project-sidebar/index.tsx` | 项目侧栏的列表、视图切换与拖拽 | INV-01~20；pinned 段不重复渲染；拖拽只在同分组内换位；三视图仅一分支生效 | 118 |
| `ui/src/store/subagentsStore.ts` | 子代理列表与运行态 store | INV-01~12；agents 只对应一次 loaded 快照；authority 只在最新请求后写入；await 后先校验 requestId | 118 |
| `ui/src/onboarding/OnboardingFlowParts.tsx` | 新手引导的步骤与完成页组件 | INV-01~14；计数只读 props 不累加；完成态每次新建对象；imported/skipped/failed 互斥且失败必须显式呈现 | 117 |

合计 **1,423**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 确认水位只能单调前进

`webRemoteControlAcknowledgedRelayProtocol.ts` 的 ack 必须严格大于 `lastAckedMessageSeq`，
且不得超过 `highestFullySentMessageSeq`。迟到 ack 回退水位会让已释放批次被二次记账，
超前 ack 则会确认从未写出的帧，重连补偿时凭空丢数据——两者都不会当场报错。

### 2. 契约的「宽进严出」方向不能反

`source-server/contracts.ts` 要求所有对象 strict、新增字段 optional/default、枚举封闭。
方向反过来（新增必填字段、放宽枚举）时，旧数据解析整条失败或新值透传到旧 UI，
表现为「连接配置突然不可用」或「状态显示空白」，而不是一个明确的迁移错误。

### 3. 异步加载只认最新一次请求

`office-runtime/ui/main.tsx` 的 `loadSeq` 与 `subagentsStore.ts` 的 `requestId` 是同一模式：
await 之后先比对序号再写状态。少了这一步，快速切换文档或工作区时旧响应会覆盖新状态，
而且因为最终状态「看起来正常」，排查时极难复现。

### 4. 状态机互斥必须由条件表达式保证

`GitBranchDialogs.tsx` 的两阶段、`ProjectNodeContent.tsx` 的三形态、`project-sidebar/index.tsx`
的三视图，都要求同一时刻只有一个分支生效。互斥若只靠调用方「不会同时设置」的约定，
一旦出现空值组合就会解引用崩溃（step 有值而 state 为空）或两套内容叠层抢焦点。

### 5. 完成态与计数永远重新构造

`OnboardingFlowParts.tsx` 的 `createInitialFinishExecutionState` 每次返回新对象、三态位全 false，
计数只读 `props.finishExecution`。复用旧对象或组件内累加会让上一轮完成态泄漏进新一轮，
完成页数字虚高，且刷新后无法回退到正确值。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 并发 prepareSandbox 不去重 | guest 注册两次，instance token 重复 |
| app-only 结果按长度截断 | UI 结果与 MCP 原始返回不一致 |
| 审批通过写入对话轮次 | 会话历史被污染，token 计数虚高 |
| ack 不校验单调性 | 已释放批次二次记账，窗口字节偏移 |
| ack 允许超前 | 确认未写出的帧，重连丢数据 |
| schema 非 strict | 新版本字段回读静默丢失，回滚缺列 |
| 新增字段必填 | 旧数据整条解析失败 |
| 加载不校验序号 | 旧文档/旧工作区结果覆盖新状态 |
| 状态机不互斥 | 两套 Dialog 叠层，或空值解引用崩溃 |
| 主目录失效禁用展开 | 历史任务无法再打开 |
| pinned 段重复渲染 | key 冲突，展开态与拖拽索引错位 |
| 跨分组拖拽 | 置顶项被拖进普通段，顺序持久化写坏 |
| store 在 await 前写 authority | 过期响应把别的 service 标记为已加载 |
| 完成页累加计数 | 重渲染数字翻倍 |
| 失败被并入 skipped | 用户误判导入成功 |
| 鉴权只认 Authorization | 查询串/Cookie 场景被误拦或绕过 |
| `/ws` 允许提升 clientMode | 浏览器侧拿到 provisioning 写能力 |

## 顺延

B35 复算清单为 17 文件，本批取 12 个（含 B34 全部 5 个顺延），其余 5 个顺延到 B36：
`packages/ui/src/lib/conversationShareError.ts`（缺口 111）、
`packages/ui/src/v4/ConversationFileSummaryPanel.tsx`（缺口 111）、
`packages/desktop/src/main/desktopWindowChrome.ts`（缺口 110）、
`packages/desktop/src/main/desktopZCodeDataSizeTelemetry.ts`（缺口 110）、
`packages/server/src/remote/ssh-backend.ts`（缺口 110）。

> 说明：按防超限规则执行，每文件单独 spec（≤150 行），5 文件一组并行，逐文件密度校验。
> `subagentsStore.ts` 的 122/390 = 31.28%，略低于 31.3% 的写作目标但高于 30% 门槛，
> 属于 `round(code × 0.314)` 取整后的正常落点，未再追加。
> `OnboardingFlowParts.tsx` 首轮锚点误中 map 回调内的 `return (`，已按基线还原后用 nth 重插。
