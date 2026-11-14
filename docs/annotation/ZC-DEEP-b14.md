# ZC-DEEP-b14

> 批次：B14（计划表为 6 文件 / 缺口 1,952 行）。实际拆成两个子批并行推进：
> b14a = `packages/ui` 侧栏与 App 壳；b14b = desktop browserView + bootstrap 协议 + adapters 模型流。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b14a\orig`、`ZC-deep-b14b\orig`。
> 规范母本：[ZC-DEEP-CORE-PLAN.md](./ZC-DEEP-CORE-PLAN.md)（第 5 节固定动作）。

## 校验

```
node zc-verify.mjs ZC-deep-b14a
SUMMARY files=3 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1000

node zc-verify.mjs ZC-deep-b14b
SUMMARY files=3 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=999

deep-density --baseline ZC-deep-b14a/orig --only b14a 三文件
30.00  2797  2020  606  335  packages/ui/src/lib/workspaceSidePane.ts
30.11  2042  1498  451  337  packages/ui/src/hooks/useAppPanels.ts
30.25  1669  1263  382  328  packages/ui/src/App.tsx
SUMMARY files=3 coreBelow30=0 needLines=0 min=30.00 median=30.11 newComments=1000
PASS: all 3 file(s) >= 30% (mode=code)

deep-density --baseline ZC-deep-b14b/orig --only b14b 三文件
30.07  1882  1377  414  320  apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts
30.72  1556  1149  353  332  packages/desktop/src/main/browserView/browserPlaywrightLocatorExecutor.ts
32.22  2154  1580  509  347  apps/zcode-cli/packages/adapters/src/model/runner-stream.ts
SUMMARY files=3 coreBelow30=0 needLines=0 min=30.07 median=30.72 newComments=999
PASS: all 3 file(s) >= 30% (mode=code)
```

列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/App.tsx` | 应用壳：workspace RPC 目标选择、视图路由、全局快捷键与内存采样 | INV-01~18；workspaceRpcTarget 优先级；只读闸先于一切写操作；draftFocusVersion 二元组记账；Git refreshToken 对账；sourceId 优先级；Cmd/Ctrl+W 只关当前 tab；toggle 语义不翻转他人状态；完整视图顺序固定；runVisibleWorkspaceCommand 与可见性绑定；三套查找状态互不串用；requestId 对账丢弃迟到响应；workbench group 归属；provider 继承；memo 边界；渲染顺序；内存采样器只读 | 328 |
| `packages/ui/src/hooks/useAppPanels.ts` | 侧栏状态所有者：tab 提交、跨 workspace 写回、Browser View 订阅与最近关闭 | INV-01~18；activeWorkspaceKey 与 sidePaneMemoryKey 不按 task 切分；commitSidePaneState 先写 ref 再 setState；关空末 tab 必须收敛折叠态；Browser View 订阅不受可见性影响；迟到事件后台挂载；remoteSessionId 创建时冻结；关闭需 main authority；human 与 browser-use 兜底差异；跨 workspace 写回带 scope 三元组；最近关闭上限 8；browser 重开换新 id；terminal release；父任务清理 selection-side-chat；展开写偏好；Office 只隐藏入口；disposer 注销；openFileUrlInBrowserSidePane 恒激活 | 337 |
| `packages/ui/src/lib/workspaceSidePane.ts` | 侧栏 tab 纯函数层：创建、复用、关闭、排序、恢复、归属与可见性 | INV-01~18；id 多段编码；归属只补缺不覆盖；可见性 = workspace + 按 type 选 owner 字段；browser/browser-use/bash-output 常驻挂载；workflow 系列无 GC；冷恢复激活顺序 lastSelectedAt > openedAt > tabId；residencyGeneration 单调；visibility 只命中已存在 shell；patch/multi-file-diff 的 sourceKey 含内容摘要；code-viewer sourceKey 先 workspace 作用域；close 返回 null 由上层收起；重开换 id；按 URL 复用只激活不改字段；actor 身份不含 actorSessionId；artifact 无 version；workbench-run 禁止自替换；ensureSidePaneTab 只补当前 scope | 335 |
| `packages/desktop/src/main/browserView/browserPlaywrightLocatorExecutor.ts` | IAB locator 的 CDP 执行会话：Playwright selector 解析、strict/vsibility、frame 穿透、trusted input | INV-1~14；可见性与严格匹配只能由 injected runtime 得出；STRICT helper 必须与 domSnapshot 同版本；frame 链只按 control=enter-frame 切分且跳过引号/转义；坐标必须来自同一份快照；strict 冲突只在唯一可见候选时降级；deadline 单向递减不可重置；perform 即提交不得回到 probe；needsStable 只对 pointer 开启；fill 永远 force=false；可恢复竞态只覆盖三类；contexts 键为 sessionId + frameId；dispose 先 detach 再清集合；Runtime.evaluate.timeout 约束不了 rAF，需 host 侧竞速；所有 CDP 调用先看 abort；[并发] 同 session 必须串行 | 332 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts` | 内核 → v3 协议快照与事件映射（跨进程 strict schema 边界） | INV-01~18；goal 权威以 DB target 为准；快照必须稳定 JSON；v3 只做源头剥离；允许预览降级不允许 gate 降级；图片 data URL 上限 20MB；附件回填失败静默保留原 part；思考档位必须属于当前模型；goal 轮次只由 verifier 边界推进；时间戳优先级 session 行 > fallback > projection > now；timeline/summary 去重键三元组；todo 按 target + 内容指纹归并；seq 允许被投递序号覆盖；内部账本事件不透出；空 delta 丢弃规则；context usage breakdown 对齐；压缩水位不越过 compactBoundary；未知事件落 session.updated；排序稳定 | 320 |
| `apps/zcode-cli/packages/adapters/src/model/runner-stream.ts` | 流式模型请求的 attempt 循环：重试预算、准入票据、idle timeout、签名修复与失败分类 | INV-01~20；仅未越过边界可重放；每次 attempt 必须 abort + 关 iterator；票据幂等且 sleep 前归还；签名修复只改请求副本且每流一次；额外 attempt 不消耗普通预算；off-peak queued 回退计数、ticketExpired 不可重试；空完成重试排除 compact 且先清 visibleEvents；compact 陈旧连接先于通用 gate 放行；HTTP status 取 transport 硬证据；自然 EOF 后业务错误优先于 generic empty；终态只发一次；consumer 提前关闭收口 cancelled；RuntimeHeadersRefreshError 禁重试；AuthMissing 原样上抛；TerminalStreamChunkError 直接透传；direct tool-call 先发 inferred block stop；idle timeout 递增只上报；retry-safe 前奏暂存后 flush；清理上限 1s 只告警 | 347 |

合计 **1999**（1000 + 999），与两次 `zc-verify` 的 `added` 之和一致。

## 关键不变量（抽取）

### 1. 侧栏三层的写入顺序

`workspaceSidePane.ts` 只算「下一个状态」，`useAppPanels.ts` 负责「先写 ref 再 setState」，
`App.tsx` 只消费。把提交逻辑下移到纯函数层会制造第二条写入路径，跨 workspace 写回时
会覆盖当前对话的标签；把状态留在 App 则会让 side pane 记忆 key 跟着 task 漂移。

### 2. Browser View 的 authority 与 residency

关闭 tab 必须等 main 侧确认，因为 webview 的真实生命周期在 main；UI 先行删除会留下
无人管的 CDP 会话。`residencyGeneration` 单调递增，乱序 IPC 必须丢弃，否则 tab 会退回旧状态。
visibility 事件只命中已存在 shell，绝不创建——迟到事件不能造出没有 main authority 的僵尸 tab。

### 3. 协议映射的「只减不增」

`session-mapper.ts` 出去的每个字段都会过旧桌面端的 strict schema。新增字段不是「兼容性风险」，
而是「确认窗直接消失」。因此 v3 路径只做源头剥离：允许预览降级，绝不允许 permission gate 降级。

### 4. 流重试的三道闸

`runner-stream.ts` 的重试顺序不可交换：

1. `emittedRetryBoundaryEvent`：已发出可见输出，禁止重放；
2. `retryBudgetAllows`：预算耗尽，禁止重试（unbounded 除外）；
3. 失败策略表：确定性错误（鉴权刷新失败等）即使预算充足也不重试。

compact 的 EPIPE/ConnectionClosed 必须插在 1 与 2 之间先放行，否则「连接已死」会被
通用 retryable 集合漏掉；但一旦阶段判定为 `response_body`，又必须交回 Core 的 commit boundary，
不能在 adapter 内重放。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 在 `sleep` 之后才 `admission.release()` | 退避窗口占满并发槽，全局吞吐随重试次数下降 |
| 只 `iterator.return()` 不 `consumeStream()` | AI SDK tee 持有旧连接，连续重试后请求卡在发送前 |
| 空完成重试前不清 `visibleEvents` | UI 出现空消息气泡与重复 start |
| 把 `start` 当成 retry boundary | 连接未建立就被判定「已提交」，SSE 重试失效 |
| 用 `streamOutputCommitted` 代替 `emittedRetryBoundaryEvent` 做重试闸 | 鉴权刷新后重复输出半截正文 |
| `sidePaneMemoryKey` 按 task 切分 | 切换对话后侧栏布局丢失 |
| visibility 事件顺手创建 shell | 关闭后仍出现无法操作的浏览器 tab |
| v3 映射透出新字段 | 旧桌面端 permission.requested safeParse 失败，确认窗不弹 |

## 顺延

无。B14 计划内 6 个文件全部达标；下一批按 `ZC-DEEP-CORE-PLAN.md` 的 B15 清单推进。
