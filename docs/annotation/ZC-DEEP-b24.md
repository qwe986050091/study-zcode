# ZC-DEEP-b24

> 批次：B24（计划 11 文件 / 缺口 1,874 行，本批取缺口前 8 个）。
> 覆盖三条链路：终端与文件树的资源/代际治理、注入脚本与远端同步的数据边界、Host 进程生命周期与 CLI 入口收口。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b24\orig`。
> 规范母本：[ZC-DEEP-CORE-PLAN.md](./ZC-DEEP-CORE-PLAN.md)（第 5 节固定动作）。

## 校验

```
node zc-verify.mjs ZC-deep-b24
SUMMARY files=8 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1448

deep-density --baseline ZC-deep-b24/orig --ext .ts,.tsx --threshold 30 --mode code
31.36  1313  947  297  189  packages/ui/src/terminal/TerminalSession.tsx
31.42   847  592  186  183  packages/ui/src/lib/webElementPickerScript.ts
31.44   880  633  199  184  packages/ui/src/TreemappingPane.tsx
31.38   798  580  182  181  packages/ui/src/settings/RemoteMcpSyncDialog.tsx
31.37   950  679  213  181  packages/desktop/src/main/desktopHostProcess.ts
31.44   843  617  194  180  packages/ui/src/workspace-file-tree/useWorkspaceFileTreeData.ts
31.40   843  602  189  176  apps/zcode-cli/packages/cli/src/run.ts
31.32   742  562  176  174  packages/ui/src/v4/featureSuggestedPrompts.ts
SUMMARY files=8 coreBelow30=0 needLines=0 min=31.32 median=31.40 newComments=1448
PASS: all 8 file(s) >= 30% (mode=code)
```

列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`。
`// INV-` 计数：6 个文件 20 条、3 个文件 19 条（均落在 18~20 的口径内）。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/terminal/TerminalSession.tsx` | 单个 xterm 实例 + 单条 PTY 的生命周期（创建、fit/resize 调度、主题下发、IME 兜底、右键菜单） | INV-01~20；resize 必须 `lastSent + pending` 双 ref 去重；resize 请求串行、in-flight 期间只覆盖 pending；PTY id 就绪必须主动 flush；drag 节流只在 `isPanelResizing` 生效且 final 绕过；隐藏容器绝不 fit（0 宽会被 fit 成 1x1）；`isVisibleRef` 只由 effect 同步；focus 延后一帧并二次校验可见性；IME 兜底只挂 Windows；Cmd+V 先 preventDefault 再手读剪贴板；40ms/150ms 两个消费窗口不可合并；persistent 路径订阅必须进 registryDisposers；复用分支 cleanup 只 detachDom 不 dispose；PTY 未就绪卸载必须 release 占位 entry；create 失败 release 前必须校验 ownership；`ptyCancelled` 不得用于常驻订阅；persistent 主题 observer 读 `entry.profileTheme`；主题双写 ref 与 entry；`windowsPty` 必须 normalize；字号 6~72 且 fontFamily 回退；cleanup 先清订阅后 dispose | 189 |
| `packages/ui/src/lib/webElementPickerScript.ts` | 注入 webview 页面上下文的 DOM 拾取器脚本（悬停高亮、信息浮窗、点击采集） | INV-01~20；同页面只允许一个实例，启动前 cancel 旧实例；`stateKey` 必须与取消脚本字面量一致；Promise 只 resolve 一次；监听器移除参数必须与注册完全一致（含 capture）；点击必须 `stopImmediatePropagation`；密码框只返回掩码、绝不读 value；HTML 摘要先 clone 再剥 script/style 并删 input.value；attributes 白名单显式排除 value；selector 限 8 层且遇 id 早停；XPath 限 12 层且保证单斜杠开头；文本统一 truncate 归一；overlay/label 必须 `pointer-events:none`；hoveredElement 只由 mousemove 更新；浮窗自遮挡与零尺寸必须隐藏；定位先试四个外侧候选；Esc 只响应 Escape；三个监听器必须捕获阶段；脚本函数体禁止引用外部标识符；注入串必须 `JSON.stringify` options | 183 |
| `packages/ui/src/TreemappingPane.tsx` | 把对话内的文件活动聚合成目录树，用面积化矩形展示并提供节点详情 | INV-01~20；树只由 buildTree 一次性构建、选中只存路径；选中回落顺序 `findFirstFile` → 树根；目录先于文件、同类按 diff 降序再字典序；目录权重聚合子树；面积权重用 `sqrt(weight)` 同时影响宽高；diff 为 0 的文件不得权重为 0；kind 只存在于文件节点；pending 按子树累加；views 先含目录自身再叠子节点；路径统一斜杠并去空段；`getParentPath` 无分隔符返回 ROOT；ensureDirectory 逐段累积；选中必须全路径相等；选中视觉不得依赖 ring/box-shadow；最近触达只用边框色；目录容器不得 hover 变色；flexGrow 与 flexBasis 同源；isLive 由 source.kind 与 streaming 共同决定；事件只取最近 4 条且 key 含 index；目录点击必须 stopPropagation | 184 |
| `packages/ui/src/settings/RemoteMcpSyncDialog.tsx` | 远端 MCP 同步弹窗：候选加载、按行选择、preflight、导出与导入、逐项结果 | INV-01~20；步骤单向推进、失败回 selection；in-flight 禁止关闭弹窗；`syncInFlightRef` 必须在 finally 复位；selectedIds 只存 id；默认只选远端不存在的项；已存在行必须 disabled；可见过滤不得缩小 selectedIds；selectedSyncIds 取交集；overwrite 固定 false；localHomeDir 优先用导出结果；preflight 必须先于 export/import；preflight 超时走专门文案；`onSynced` 必须先于 `setImportResult` await；打开即重置全部状态；异步加载用 cancelled 丢弃过期响应；indeterminate 只能命令式设置；全选/清空基于 `visibleMissingIds`；rows 与 statuses 按 name 关联；结果 key 含 status；错误文案必须来自 intl | 181 |
| `packages/desktop/src/main/desktopHostProcess.ts` | Main 进程 fork 唯一 Local Host utilityProcess，转发 InitLocal/ServicePort/广播并管理生命周期 | INV-01~19；hostId 每次 fork 唯一且不由 workspacePath 派生；startupId 在 InitLocal 之前绑定；`ZCODE_PROCESS_LABEL` 最后写入 env；`ZCODE_CUA_LAUNCHER_PID` 只在 darwin 注入；schema 校验失败必须 return；每个消息分支处理完必须 return；`exitedHostProcesses` 只在 exit 回调写；UtilityProcess 没有 exitCode，存活只看该表；强杀下限 3.5s 只能抬高；dispose 幂等靠定时器表；exit 清理顺序为标记 → 通知 CUA → flush 日志 → 注销；windowId 必须在 exit 回调外取好；广播用 `webContents.id`、实时总线用 `win.id`；ServicePort 的 port2 必须随 InitLocal transfer；`attachInitialServicePort=false` 时不建 MessageChannel；agent 注册与注销同 pid；运行任务计数为 0 必须 delete；Cron/OffPeak 只搬字段由 scheduler 结算；CUA 状态唯一所有者是 Host | 181 |
| `packages/ui/src/workspace-file-tree/useWorkspaceFileTreeData.ts` | workspace 文件树的 children/展开态/加载态/错误态与 Git 状态投影 | INV-01~20；切换 workspace 与卸载都要自增 generation；异步写回必须同时校验 generation 与 requestVersion；目录请求序号按目录独立递增且裁剪时不能删；loading/loaded 的 ref 与 state 成对更新；只有 force 绕过短路；silent 只影响展示；ignored 晚到不得清其它目录标记；自动展平只沿普通单子目录（防软链爆栈）；Git 状态失败必须清可用标志；Git 请求序号失败也要推进；只有 watcher 失败才裁子树；手动刷新失败必须 invalidate；手动刷新不得复用 watcher 裁剪；batch version 只由 cancel 与新一轮推进；worker 每轮重查 generation；`refreshLoadedDirectories` 必须防重入；finally 复位必须带版本校验；watcher 事件按目录去重并 debounce；超阈值退化为根 + 展开目录；rows 不在 hook 内缓存 | 180 |
| `apps/zcode-cli/packages/cli/src/run.ts` | CLI 进程唯一入口：自执行子命令分流、全局参数归一化、作用域校验与分发 | INV-01~19；自执行子命令必须在 parseGlobalArgs 之前分流；参数错误一律 stderr + return 1；`--output-format` 拒绝未知值；`--resume` 与 `--continue` 互斥；`--browser-executable` 只在 headless 合法；`--target` 与 `--prompt` 互斥；`--surface` 白名单；`--force-mcs` 与 `--toolsearch-mode` 共用作用域；`--workflow-mode` 同作用域；`--memory-bench` 只接受 `--prompt`；headless 默认 yolo 且 TUI 不套用；help/version 必须在分发前返回；app-server 是常驻协议进程；协议子进程不读用户 .env；dotenv 失败只在协议路径抛错；resolveCliCwd 在所有参数归一化之后；commandDeps 的 env/logger 只构造一次；未知子命令写 help 到 stderr 并 return 1；版本号只来自 `__CLI_VERSION__` | 176 |
| `packages/ui/src/v4/featureSuggestedPrompts.ts` | 新建会话页推荐任务的两池静态语料（office / coding） | INV-01~19；id 全局唯一且稳定；mode 只有两个值；中英 label 同义同批改；中英 prompt 同义同批改；`plugin.stableId` 必须与 prompt 里的 `plugin://` 一致；`plugin.label` 与市场展示名一致；有 plugin 必须 `iconStyle=plugin`；无 plugin 不得标 plugin；iconUrl 只有 CDN 才拼 ASSETS；ASSETS 不得拼用户输入；prompt 不写死日期/版本；prompt 必须含「不要编造」；prompt 必须声明禁止的破坏性动作；占位符统一方括号；池内顺序即展示顺序；新增条目追加到池末尾；过滤不复制对象；本文件不得引入 React/hooks；图标 import 必须来自已有资源路径 | 174 |

合计 **1,448**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 「双路径对称」比单点正确更难守

`TerminalSession.tsx` 同时存在 persistentKey（side pane，资源进 registry、卸载只 detach）与默认路径
（下侧 terminal，清理即 dispose）两条互斥路径。本批 20 条 INV 里有 6 条（INV-11~16）只服务这个对称性：
同一处改动只改一侧，另一侧不会报错，只会表现为「切回 workspace 后终端只能看不能输入」或
「scrollback 被销毁、跨 workspace 保活失效」。这类回归没有异常、没有日志，只能靠注释把契约写死在代码旁。

### 2. 双层闸门：generation 与 requestVersion 缺一不可

`useWorkspaceFileTreeData.ts` 的 stale 判定是两级：
- `workspaceGeneration` 防的是「切换 workspace 后旧 readdir 覆盖新树」；
- 目录级 `requestVersion` 防的是「同一 workspace 内旧快照覆盖新 children」。

只校验一级都会留下漏洞，而且两种漏洞的触发条件不同（一个是切项目，一个是快速刷新）。
同一模式在本文件还派生出第三条闸门 `refreshBatchVersion`——它只由 cancel 与新一轮刷新推进，
watcher worker 每轮重查，否则旧批次会在取消后继续跑并写 state。
这是 B23「代际检查放在读取完成之后、提交之前」的延续，本批补上了「多级闸门各自防什么」的注释。

### 3. 注入脚本的敏感数据边界是「白名单 + 掩码 + 不可读」

`webElementPickerScript.ts` 会被 `toString()` 序列化后注入页面，因此有三条不可动的边界：
- 函数体必须自包含，**脚本内禁止引用外部标识符**（引用即 ReferenceError，拾取器完全不出现）；
- 密码框只返回固定掩码，`value` 在 attributes 白名单里被显式排除，HTML 摘要先 clone 再删 `input.value`；
- 文本字段统一 truncate 归一，避免多行文本破坏浮窗并放大载荷。

三者互相支撑：少了任何一条，用户密码或 token 就会随上下文载荷进入聊天记录，且不可撤回。
另外 `stopImmediatePropagation` 不能降级为 `stopPropagation`——页面自身的捕获监听仍会执行并触发真实导航。

### 4. 「进程存活」不能用对象字段判断

`desktopHostProcess.ts` 的核心陷阱：Electron 的 `UtilityProcess` **没有 `exitCode`**。
任何 `child.exitCode === undefined` 之类的判断都会把存活 host 当成已退出，导致退出流程漏发 Dispose、
host 变成孤儿。唯一可信来源是只在 exit 回调里写入的 `exitedHostProcesses`。
与之配套的两条顺序约束：强杀下限 3.5s 只能抬高（降低会让 host 先死、agent 进程树被 init 接管），
exit 清理必须按「标记 exited → 通知 CUA → flush 日志 → 注销」执行（顺序错会丢最后一行日志或误删同名新 host）。

### 5. 参数收口层只决定「能不能启动」，不碰业务

`run.ts` 把全部互斥与作用域校验集中在一层，且在 `parseGlobalArgs` 之前先分流自执行子命令
（SEA 下 argv 末尾会带入口路径，晚分流就会被当成未知参数）。
两条最容易被顺手破坏的规则：`--help/--version` 必须在业务分发前 return（否则会建会话或启动 agent）；
未知子命令必须写 help 到 stderr 并 return 1（返回 0 会让脚本误判成功）。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| resize 只比较 pending、不记 lastSent | ResizeObserver 每帧重复下发，PTY 反复重排、输出闪烁 |
| resize 并发发送 | 旧请求后到达，终端最终停在错误 cols/rows |
| 在隐藏容器上 fit | clientWidth 为 0 被 fit 成 1x1，错误尺寸同步给 PTY |
| persistent 复用分支 dispose term | scrollback 与 PTY 被销毁，跨 workspace 保活失效 |
| PTY 未就绪卸载不 release 占位 entry | 重挂命中复用快路径，复用空 PTY，永久连不上 |
| create 失败 release 不做 ownership 比较 | 误删新一代 entry，终端无声消失 |
| `ptyCancelled` 用于常驻订阅 | detach 后兜底写入永久失效，中文输入丢失 |
| 拾取器脚本引用外部标识符 | 注入后 ReferenceError，拾取器完全不出现 |
| 只 stopPropagation | 页面捕获监听仍执行，点击拾取触发真实导航 |
| attributes 不排除 value | token / 密码进入 attributes 字段 |
| 只校验 generation、不校验 requestVersion | 同 workspace 内旧快照覆盖新 children |
| watcher worker 不每轮重查 batch version | 取消后旧批次继续跑并写 state |
| 只有手动刷新失败也裁子树 | 网络抖动清空整棵旧树 |
| 用 `exitCode` 判断 UtilityProcess 存活 | 存活 host 被当成已退出，Dispose 漏发、host 成孤儿 |
| 降低 3.5s 强杀下限 | host 先死，agent 进程树被 init 接管成孤儿 |
| exit 清理先去注册再 flush 日志 | 最后一行日志丢失；或注销误删同名新 host |
| 在 exit 回调里读 `webContents.id` | 窗口已销毁，读 id 直接抛异常 |
| 合并 host 消息分支或去掉 return | 同一条消息落入后续分支被二次结算 |
| 运行任务计数为 0 写成 0 而非 delete | app-quit 永远等待一个不存在的任务 |
| 自执行子命令晚于 parseGlobalArgs 分流 | SEA 下入口路径被当成未知参数 |
| 未知子命令 return 0 | 脚本误判成功，CI 静默通过 |
| 推荐条目改 id 或重排池内顺序 | 埋点断裂、运营排好的曝光优先级被打乱 |

## 顺延

本批从 B24 计划清单的 11 个文件中取缺口前 8 个，以下 3 个顺延到下一批（缺口合计 495 行）：

- `apps/zcode-cli/packages/core/src/browser-client/manifest.ts` — 165
- `packages/ui/src/browser-use/UnifiedBrowserView.tsx` — 165
- `packages/ui/src/hooks/useCodingPlanQuotaResetUi.ts` — 165

> 说明：本批开工前对 8 个目标文件逐一做了基线校验（`newComments=0`），确认上次卡死/断电没有留下半插入状态；
> 全部插入均经 `zc-insert.mjs` 原子批写入，任一 anchor 不匹配整批不落盘。
