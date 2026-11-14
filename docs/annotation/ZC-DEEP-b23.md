# ZC-DEEP-b23

> 批次：B23（计划 11 文件 / 缺口 1,958 行，本批取缺口前 8 个）。
> 覆盖四条链路：桌面端 Chrome 数据导入与命令分发、Provider 门面层的串行写、Host 任务投影的代际治理、Web 远控传输与 UI 只读代码视图。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b23\orig`。
> 规范母本：[ZC-DEEP-CORE-PLAN.md](./ZC-DEEP-CORE-PLAN.md)（第 5 节固定动作）。

## 校验

```
node zc-verify.mjs ZC-deep-b23
SUMMARY files=8 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1513

deep-density --baseline ZC-deep-b23/orig --ext .ts,.tsx --threshold 30 --mode code
31.76   903  655  208  192  packages/desktop/src/main/chromeLocalStorageManager.ts
31.43   942  700  220  190  packages/ui/src/v4/ConversationDraftSuggestedPromptsContainer.tsx
31.97  1310  976  312  198  packages/desktop/src/host/windowHostControllerService.ts
31.49   876  632  199  188  packages/provider/src/facades.ts
31.36   978  692  217  188  packages/ui/src/components/ui/code-viewer.tsx
31.40   951  688  216  188  packages/web/src/web-remote-control/adapters/webRemoteControlTransport.ts
31.30   877  639  200  185  packages/desktop/src/main/desktopCommandHandlers.ts
31.26   818  611  191  184  packages/desktop/src/main/forceUpdatePrompt.ts
SUMMARY files=8 coreBelow30=0 needLines=0 min=31.26 median=31.44 newComments=1513
PASS: all 8 file(s) >= 30% (mode=code)
```

列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`。
每个文件 `// INV-` 均为 19 条（口径要求 18~20）。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/desktop/src/main/chromeLocalStorageManager.ts` | Chrome Profile → 一次性 Profile → CDP → Electron Session 的 Cookie/LocalStorage 导入 | INV-01~19；Cookie 库路径必须相对且解析后仍在 profilePath 内；origin 只从复制后的快照扫描；候选 origin 必须与 `URL.origin` 完全相等；日志只允许稳定分类码；临时目录清理失败不得覆盖成功结果；建连与每条命令都受 `CDP_TIMEOUT_MS`；socket 关闭必须 reject 全部在途请求；request id 单调且结算前出表；导航后必须复核 `location.origin`；Fetch 拦截只放行 Document；helper 必被终止；一次性 `--user-data-dir` 与 `--remote-debugging-port=0`；写回条数必须等于源 entries；destroy 前必须 `flushStorageData` | 192 |
| `packages/ui/src/v4/ConversationDraftSuggestedPromptsContainer.tsx` | 推荐 Prompt 的 latest-wins 写入 Composer，并承载插件安装/启用流程 | INV-01~19；选择入口先自增 `requestVersion`；每个 await 之后写 Composer 前重查版本；abort 同时表示取消与陈旧；Plugin 项必须一次写入而非两阶段；`draftRevision` 在旧 operation 收敛后、新的开始前捕获；关闭 Popover 必须取消同一 operation；安装超时必须 `cancelPluginOperation`；进度订阅在 finally dispose；workspace/attachment 变化必须加版本并取消；关闭推荐先落设置再回写引导；埋点早于导航且不可 await；只允许官方 Marketplace 且 `sourceTrust=official` | 190 |
| `packages/desktop/src/host/windowHostControllerService.ts` | Host 侧 Controller：按 source scope 聚合 local/remote task 与 agent 服务的 V4 投影 | INV-01~19；`sourceKey` 必须含 kind + 标识 + identity/path；一个 sourceKey 只有一个投影 owner；换 owner 必须走 `replaceDisconnectedSource`；刷新读完后提交前必须比对代际；同 taskService 的在途刷新复用同一 promise；`force=false` 的短路三条件；写前后都必须 `assertCurrentSource`；离线 source 读取必须抛错；写已持久成功后刷新失败只上报；断线保留最后可信投影并让代际加一；未读信号必须先于列表刷新发出；`single-flight` 不得吞掉途中事件；observer 只复用同一 agentService；回调必须校验 observer 身份；attachment dispose 后禁止迟到写回 | 198 |
| `packages/provider/src/facades.ts` | Provider Registry 快照 → 设置视图/模型选择视图，并串行化配置写入 | INV-01~19；所有写只能经 `#mutations`；写后必须 refresh 再生成 view；同 provider 写操作串行；队列必须吞掉前一个 rejection；队列项完成且仍是队尾才清理；`waitForProviderOperations` 必须等当前队尾；草稿写前比对 revision；`personalRevision` 必须取自同一份 snapshot；`assertCurrent` 必须在同一 snapshot 身份下通过；配置成员名单不得与可执行模型名单混用；Account 名单不得与内置模型取并集；`resolveModelConfig` 必须区分继承值与生效值；改名预览先 `renameExactModel` 再 `setExact`；固定模式必须清推荐标记；`getView` 先 `requireSnapshot` | 188 |
| `packages/ui/src/components/ui/code-viewer.tsx` | 纯文本代码的只读视图：行号、语法高亮、行内评论草稿与已提交评论 | INV-01~19；行号换算以 `firstLineNumber` 为唯一原点；`CodeCommentRange` 使用前必须 `normalizeRange`；`cacheKey` 必须覆盖主题/语言/文件名/内容指纹；`markedLines` 只着色行号；着色规则必须经 `unsafeCSS` 注入 Shadow DOM；标注从 1 起且落在有效区间；草稿只在 `canCreateComment` 为真时存在；空选中文本不得提交；评论与草稿不得共用插槽；提交成功必须同时清 `activeDraftRange` 与 `draftText`；评论是「末行之后追加」而非覆盖；gutter 补丁不接管 pointer 事件；observer 按 Root 去重并在清理阶段 disconnect；同帧多次变更只补丁一次；补丁只在 effect 内且 ref 已挂载后启动；聚焦定位先评论节点再代码行；只改 `scrollTop` 并回写 `scrollLeft`；重试有上限；定位随 `cacheKey` 重跑 | 188 |
| `packages/web/src/web-remote-control/adapters/webRemoteControlTransport.ts` | 手机端到 relay 的终端 WebSocket 生命周期：鉴权、配对、心跳、重连、前后台恢复 | INV-01~19；`socketGeneration` 是唯一代际标识；每个 socket 监听器首句必须是 `socket === this.socket` 短路；`closeSocket` 必须自增代际并 abort token；`intentionallyClosed` 时 connect/scheduleReconnect 直接返回；`authenticated` 只在 `auth_ack` 且 `device_sid` 匹配后置真；已配对后的 waiting 不得清 `wasPaired`；`wasPaired` 只在新一轮计时器回调里清；`hadPairedSession` 只由 start 重置；waiter 结算必须清自己的计时器；`waitForPaired` 只在未 paired 时挂 waiter；`DEVICE_OFFLINE` 必须先开宽限计时器；宽限计时器只能有一个且进 paired 时清除；每次心跳 ack 都要重置退避；`suspend` 对未认证连接必须 `closeSocket`；suspended 下计时器回调早退；send 同时校验 readyState 与帧字节上限；超限判断先于可用性判断；状态迁移必须经 `setState`；relay 诊断日志只允许开发态摘要 | 188 |
| `packages/desktop/src/main/desktopCommandHandlers.ts` | `DesktopCommandId` → 主进程动作的唯一分发入口（窗口、缩放、外链、数据清理） | INV-01~19；映射只在 `executeDesktopCommand` 的 switch；每个 case 必须 return；目标窗口只在入口解析一次；`senderWindow` 使用前校验 `isDestroyed`；缩放唯一事实源是 `webContents.zoomFactor`；无窗口时返回 undefined 且调用方不得持久化；缩放变更必须同时持久化/通知/同步按钮位置；清理确认框默认指向取消；只有 `response===1` 才清除；Coding Plan 与 Rewards 分区必须显式清理；ClearAllData 先清分区再全量清理；先 `app.relaunch` 再 `app.exit`；打包态配置只从 `resourcesPath` 解析；远端配置失败不阻断本地兜底；空字符串不算命中；HTML 属性转义必须先 `&`；端点覆盖只在非生产环境；自定义端点取消以 undefined 表示 | 185 |
| `packages/desktop/src/main/forceUpdatePrompt.ts` | 强制升级期独立无边框窗口：内联 HTML 页面 + title 协议回传用户选择 | INV-01~19；内联 HTML 必须自包含；注入初始状态必须 `JSON.stringify`；插入 HTML 的文本逐个 `escapeHtml`；detail 按行切分；主进程写页面状态必须可选链；所有 `executeJavaScript` 必须 catch；`resolveOnce` 只结算一次但关窗独立；用户关窗必须按 quit 结算；每次自动升级先解绑旧 dispose；结算前必须 `autoUpdateDispose`；action 只认 auto/manual/quit；高度协议必须先于动作协议解析；改高度必须同时 `setSize` 与 `center`；窗口显示取三事件之一；`showPromptWindow` 必须幂等；无父窗口必须显式置顶；事件监听必须在 `loadURL` 之前注册；图标读取失败降级为字母；`nativeTheme` 只用于窗口背景色 | 184 |

合计 **1,513**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 代际（generation）是三类跨异步边界的唯一裁决者

本批有三个文件用同一种模式解决「迟到的旧结果覆盖新状态」：

- `webRemoteControlTransport.ts` 的 `socketGeneration`：任何 await 或事件回调回到同步世界之前都要比对代际，
  旧 socket 的 `close` 否则会把新连接关掉，表现为无限重连抖动。
- `windowHostControllerService.ts` 的 `sourceRefreshGenerations`：刷新读取完成后、提交前比对，
  旧连接的迟到快照会被丢弃；`pendingReplacementByNextSourceKey` 让「断线→换 owner」只在成功后才移交投影。
- `ConversationDraftSuggestedPromptsContainer.tsx` 的 `requestVersion`：两次快速点击时只允许最后一次写入 Composer。

三处的共同点是：**代际检查必须放在「读取完成之后、提交之前」**，而不是入口处。
放到入口只能防重复进入，防不住 in-flight 的过期结果。这是本批最值得复用的一条模式。

### 2. 视觉/交互层的坐标原点只能有一个

`code-viewer.tsx` 把行号原点收敛到 `firstLineNumber`，评论坐标统一用 `CodeCommentRange`（1 起、含端点、已归一化）。
一旦在某一处改用相对行号，片段从第 100 行开始时评论会挂到第 1 行——**没有任何报错**，只是锚点整体偏移。
同理 `markedLines` 只允许着色行号而不得给行容器加 class：改了就会和 `@pierre/diffs` 自带的 hover 样式互相覆盖。

### 3. 「写成功」与「刷新失败」必须分离

`facades.ts` 与 `windowHostControllerService.ts` 都贯彻同一条：写操作已经持久成功后，后续刷新失败只上报
（`onSourceError` / 抛出可选择重试的错误），**不得把成功伪装成失败**。否则用户会重复执行一次已经生效的操作，
在删除/重命名这类非幂等命令上会直接产生二次副作用。

### 4. 敏感数据边界是「复制快照 + 稳定错误码」

`chromeLocalStorageManager.ts` 的三条禁令互相支撑：源 Profile 不得直接当 helper 的 `user-data-dir`、
LocalStorage 的 origin 只从复制后的快照扫描、日志只能出现稳定分类码。
第三点最容易被「顺手加一行 debug 日志」破坏——Cookie 值与域名一旦进日志，就是不可撤回的泄漏。
此外 helper 必须在 `finally` 里终止：每次导入泄漏一个 headless Chrome，累积会占满内存。

### 5. 强更窗口不能依赖 renderer

`forceUpdatePrompt.ts` 在 app ready 之前就可能弹窗，所以只允许引入 `node:` 内建模块，
页面与主进程只能通过 `document.title` 通信（无 preload、无 IPC）。
`resolveOnce` 的「只结算一次」与「关窗独立」必须分开判断：合并后要么 guard 收到两个动作，要么提示窗残留在强更页之上。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 代际检查放在入口而非提交前 | in-flight 的旧结果覆盖新状态，界面在两次刷新之间跳变 |
| 旧 socket 监听器不校验 `socket === this.socket` | 旧 close 关掉新连接，无限重连抖动 |
| 已配对后的 waiting 清掉 `wasPaired` | 桌面短暂重连就把手机推进失败页 |
| 把 `DEVICE_OFFLINE` 当终态 | 一两秒重连空窗被渲染成电脑端离线 |
| send 不校验物理帧上限 | 超帧消息被 relay 断开，上层已收到成功回执，消息静默丢失 |
| 评论坐标改用相对行号 | 片段从第 100 行开始时评论整体偏移，无任何报错 |
| 用 `scrollIntoView` 做聚焦定位 | 长行代码横向滚动被重置为 0，跳回行首 |
| 给行容器加 class 做标记行 | 与官方 hover 样式互相覆盖，标记行失效 |
| 写成功后把刷新失败报成失败 | 用户重复执行非幂等操作，产生二次副作用 |
| Provider 队列不吞 rejection | 一次失败后该 provider 的后续写永久失败 |
| 队列项清理不比对队尾 | Map 无限增长，或误删新队尾 |
| 写前不比对 revision | 覆盖其它窗口的并发编辑 |
| 源 Profile 直接当 helper 的 `user-data-dir` | helper 退出时写坏用户真实 Chrome 配置 |
| 日志打印 Cookie 值或域名 | 浏览器数据进日志文件，不可撤回 |
| helper 不在 finally 终止 | 每次导入泄漏一个 headless Chrome |
| CDP 命令不受超时约束 | Chrome 挂起时 IPC 永久 pending，窗口一直转圈 |
| 写回条数与源 entries 不一致仍算成功 | quota 截断被当成成功，用户看到缺数据的登录态 |
| destroy 前不 `flushStorageData` | LevelDB 未落盘即销毁，重启后数据消失 |
| switch 分支贯穿 | 顺带执行关窗、清理数据等破坏性动作 |
| 缩放自维护档位 | 与 DevTools/其它窗口改动脱节，按一次跳两档 |
| ClearAllData 先全量清理再清分区 | 全量清理已重启进程，分区数据从未被删除 |
| 先 `app.exit` 再 `app.relaunch` | 重启请求没有入队，应用直接消失 |
| HTML 属性转义先转引号后转 `&` | 二次转义，用户看到 `&amp;quot;` 字面量 |
| 强更窗口引入 renderer 依赖 | 启动早期模块缺失，卡片白屏，用户只能强杀进程 |
| `executeJavaScript` 不 catch | 窗口销毁或导航产生的 rejection 变成未捕获异常，日志刷屏 |
| 强更窗口不注册 closed 监听 | 用户关掉提示后 guard 永远等不到动作 |

## 顺延

本批从 B23 计划清单的 11 个文件中取缺口前 8 个，以下 3 个顺延到下一批（缺口合计 527 行）：

- `packages/ui/src/terminal/TerminalSession.tsx` — 177
- `packages/ui/src/lib/webElementPickerScript.ts` — 175
- `packages/ui/src/TreemappingPane.tsx` — 175

> 说明：本批开工前对 8 个目标文件逐一做了基线校验（`newComments=0`），确认断电中断没有留下半插入状态，
> 无需从快照还原。全部插入均经 `zc-insert.mjs` 原子批写入，共 12 批（每文件 3 批）。
