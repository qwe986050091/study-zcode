# ZC-DEEP-B228：`browserGuestManager.ts` 深注释（片 1–14 / 14 · A 轮 5/5）

> 目标文件：`packages/desktop/src/main/browserView/browserGuestManager.ts`（5460 行 / 2626 单元 / 未覆盖 2288）。
> 批次基线：`_annot_baseline/ZC-deep-b228/orig` = `git show HEAD:`（本批只加注释，代码零改动）。
> 编号说明：`ZC-deep-b227` 目录已被 UI 四文件批占用且无对应文档，本批顺延为 b228，避免覆盖。
> 分片原则：边界落在 guest 生命周期阶段上，不按行数硬切。

## 1. 开写前置：`--uncovered` 明细判定

```text
v3  coverage=12.9%  branch=11.8%  field=3.2%  units=2626  comments=1210
MAP comments=1210 mappedStrict=338 mappedBlock=1117 unmapped=93
    reasons=import:76,structural:14,continuation:3,gap:0,eof:0,other:0
UNCOVERED units=2288
```

逐条比对 2288 个未覆盖单元与其上方 0–2 个空行（与 `commentAbove` 同口径）：

| 判定 | 单元数 | 说明 |
| --- | ---: | --- |
| 上方窗口内有注释（写了没贴住） | **0** | 不存在「已写段落未被计入」的情况 |
| 上方窗口内无注释（没写） | **2288** | 全部是真缺口 |

结论：本文件不存在 2.71 : 1 摊薄导致的重复写风险。`MAP gap=0` 与该结果互相印证——空行不丢覆盖，块注释只对块首 1 个单元计入覆盖，其余行仍在缺口里，属**没写**而非**没贴住**。

未覆盖 Top 10（按函数聚合）：

| 函数 | 未覆盖 | 分支 |
| --- | ---: | ---: |
| `executeInScope` | 317 | 55 |
| `attachGuest` | 109 | 14 |
| `executeRecordingAction` | 103 | 19 |
| `runRecording` | 66 | 11 |
| `runRestoreSuspendedGuest` | 65 | 10 |
| `executeScreenshotWithPreparedSurface` | 61 | 7 |
| `restoreTabs` | 48 | 4 |
| `settleScreenshotCapture` | 47 | 5 |
| `toControlledView` | 39 | 0 |
| `raceBackendExecution` | 38 | 2 |

## 2. 阶段划分（六阶段 → 14 片）

| # | 片 | 行区间 | 生命周期阶段 | 未覆盖 |
| ---: | --- | --- | --- | ---: |
| 1 | 契约层：类型 / 常量 / 模块 helper | 82–618 | 横切（前置契约） | 176 |
| 2 | 注册表字段与构造 | 619–773 | attach（状态容器） | 32 |
| 3 | `attachGuest` 全流程 | 774–1138 | attach + create（现场建 shell） | 109 |
| 4 | 归属查询 / viewport 同步 / residency 上报 / `restoreTabs` | 1139–1350 | 崩溃与恢复（入口） | 104 |
| 5 | `execute` / `executeInScope` | 1351–1421 / 1422–2090 | 导航与加载（命令派发） | 344 |
| 6 | 截图 prepare 与 surface | 2091–2248 | 横切（截图） | 61 |
| 7 | 透明 presentation / abandoned capture | 2249–2400 | 横切（截图） | 62 |
| 8 | 录制生命周期 | 2401–3001 | 横切（录制） | 330 |
| 9 | tab registry：resolve / create / claim / select | 3002–3321 | create + 权限注入（claim） | 127 |
| 10 | 归属、请求生命周期、closeSession / closeWindow / closeTab | 3322–3796 | destroy（上半） | 164 |
| 11 | 崩溃守卫 / dialog / download / viewport 串行 | 3797–4211 | 崩溃与恢复 | 167 |
| 12 | CDP 恢复回滚 / `toControlledView` / residency 注册 / 持久化 | 4212–4693 | 权限注入 + 恢复 | 251 |
| 13 | runtime protection / rebind / teardown 前置 | 4694–4866 | 崩溃与恢复 | 68 |
| 14 | teardown / detach / `disposeAll` + waiter 与尾部署名 | 4867–5460 | destroy | 163 |

铁律：片 9 的 `claimTab` 与片 3 的 `attachGuest` 共享「先校验 scope 再动 residency」的顺序，跨片写注释时必须引用同一处，不重复解释。

## 3. 片 1：契约层（82–618，176 单元）

已写的判定点：

| 位置 | 写的是什么 | 为什么必须写 |
| --- | --- | --- |
| `buildViewportMetricsOverride` | 返回 `Record<string, unknown>` 而非 CDP 参数类型；宽高成对；`mobile` 不可改；`dontSetVisibleSize` 固定 | 三条 CDP 路径共用一个基准，绑定单条方法的形状会让另外两条失配 |
| `scopeKey` | 七段顺序不可重排、缺省 `remoteSessionId` 填空串保持段数 | 重排会让内存中已有 key 集体失配，表现为 tab 消失 |
| `ownedBySession` | 只比 window/workspace/session，不比 browserId/generation | 比多了会让 finalize 后的 tab 永远认领不回来 |
| `sameScope` | legacy 只与 legacy 相等 | 宽容匹配会把旧 renderer 接进真实 scope |
| `normalizeLegacyContext` | requestId 每次新生成、generation=0 哨兵、windowId=0 不属任何窗口 | 防 legacy 与结构化 scope 撞 key、防被窗口清理误伤 |
| `suspendAckKey` | 复合 key + generation 单调 | 旧 ACK 只能命中已删除 waiter，不会提前释放本轮 |
| `toRestoredShell` | browserId/generation 取 owner；`remoteSessionId` 条件展开 | 沿用旧代际会被 attachGuest 判 generation-mismatch |
| `isSideEffecting` | 先判 locator operation，再判 evaluate，最后 method 白名单 | 顺序调换会把写操作判成只读；漏登记会让取消误报 `none` |
| `safeNumber` | 取值闭包 + try 包调用 | 属性访问本身会抛错，只包类型判断拦不住 |

**声明行按六条判据重筛（126 单元）**：

| 堆 | 数量 | 判据 | 处理 |
| --- | ---: | --- | --- |
| 必须写 | 17 | 命中「哨兵值 / 谁写谁读 / 生命周期 / 不变式 / 序列化边界 / 安全属性」任一条，且答得出「删了或换掉会怎么坏」 | 已补 |
| 可写可不写 | 15 | 能说清后果但离声明较远（`browserId`、`clientMode`、`guest`、`origin`、`loading`、`mediaActive`、`openedAt`、`tabLimit` 等） | 留空 |
| 纯名字复述 | 94 | import 成员、`GuestWebContents` 结构镜像成员、已被紧邻块级说明覆盖的字段 | 豁免 |

必须写的 17 条：`requestId`（INV-08 去重键）、`browserGeneration`（INV-20 fail closed）、`windowId`（sender 绑定 + `closeWindow` 清理范围）、`workspaceKey`/`sessionId`（进 scopeKey 且落 `BrowserTabShellRecord`）、`GuestBindingLifecycle`（INV-03/04 单向退行）、`tabId`（恢复主键 + 墓碑键 + renderer 寻址三处同值）、`owner`（派发时 sameScope 基准，会被 claim/finalize 整体替换）、`rebindRequested`（漏复位会让 `runGuestAttachFlight` 跳过开窗请求）、`cdpAttached`（native 状态镜像，残留 true 会让 teardown 误判）、`lifecycle`（INV-15 终态）、`active`（INV-01 与 `activeTabByScope` 一致）、`cachedUrl`（INV-18 不得被临时 guest 覆盖）、`restoredFromStore`（孤儿关闭开关）、`DownloadRecord.path`（null=未落盘）、`DownloadRecord.state`（只有 completed 可读 path）、`onRecoveryOrphanCloseRequested`（缺省会留下死标签）。

## 4. 片 1 三项指标

| 项 | 值 |
| --- | --- |
| 文件累计覆盖率 | **13.5%**（12.9% → 13.5%，+0.6pt / +16 单元；分支 11.8% → 12.3%，字段 3.2% → 3.8%） |
| 本片新增注释行 | **33**（`comments` 1210 → 1243） |
| `adjacentDup` / `intraDup` | **0 对**（第七件 `pairs=0 hitLines=0 verbatim=0 prefix=0 paraphrase=0`） |
| 跨片重复 | 无（本片是首片） |

## 4.5 片 2：`attachGuest`（109 单元）

**前置判定**：109 个未覆盖单元里 **81** 个在向上 8 行内能找到注释——这些是块级说明只记在块首 1 个单元造成的摊薄，属「写了没计入」；**28** 个是真空白（create shell 的对象字面量字段、返回信封字段、日志参数）。两者都不重复写。

**新增 4 处判定点**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `restoring` + `markAttached` 分支 | 返回 false 表示上报的是回滚前旧代 guest，必须连 incoming guest 一起关闭 | 只 return 会让旧 guest 继续占住 tab，新一轮恢复 attach 不上 |
| `activeTabByScope.delete` | 只删指向自己的条目 | 盲删会把并行 attach 刚切好的 active 清掉，截图 prepare 找不到可产帧的 tab |
| `recoveryFlight.then` | 成功失败都摘除 flight | 留着会让 `summary`/`userTabInfo` 永远忽略该 tab 的 URL/title（INV-18） |
| `persistShell` | 每次 attach 都落盘 shell | 少这一写，重启恢复到上一次 attach 之前的页面 |

**安全审查三条结论**：

1. **身份来源**：`windowId` 在 IPC 层由 `sender` 绑定（`desktopBrowserViewIpc.ts:154` 一带），可信；`workspaceKey`/`sessionId` 由 renderer 自报，但只用于给**新建 tab** 建 owner，不与既有 tab 的 owner 合并，因此不能靠伪造字段接管已有 tab。
2. **权限注入时序**：未 claim 的 user tab 的 owner 是 `unscoped` 临时上下文，真实会话的 `sameScope` 匹配不上，命令在 claim 之前够不到它；`claimTab` 才把 owner 换成调用方上下文并激活。
3. **guest 销毁前能力失效**：`destroyed` 回调同步走 `detachGuest`，先摘监听再清 CDP 状态，没有「已销毁但仍可下发 CDP」的窗口。

**新缺陷 D-16-1**：`attachGuest` 只校验 `getType()=="webview"`，不校验 `guest.hostWebContents` 是否属于调用方窗口、也不拒绝已被其它 tab 占用的 guest；任意 renderer 传入别的窗口的 webview id 即可共享其 CDP 控制。已按格式记入 `ZC-DEFECTS.md`（A 档 / 中），本批不改代码。

**指标**：本片新增 9 行；文件累计 **14.3%**；逻辑区 **17.3%**（+0.2pt）；声明区 7.2%。六件套全 0，第七件 0 对。

## 4.6 覆盖率口径拆分（逻辑区 / 声明区）

工具 `_annot_baseline/_region-split.mjs`（读 `deep-quality --unit-lines --json`，用 TS AST 把 import / interface 字段 / 对象字面量属性 / 类型别名标为声明区，其余为逻辑区）。

| 区域 | 单元 | 已覆盖 | 覆盖率 |
| --- | ---: | ---: | ---: |
| 全文件 | 2626 | 1085 | 41.3% |
| 逻辑区 | 1835 | 1010 | **55.0%** |
| 声明区 | 791 | 75 | 9.5% |

达标线只看逻辑区；全文件数保留用于和历史对照，避免「逻辑写完、声明区豁免」被误读成「压根没做」。表内为 A4 结束后的最新值（A3 结束时为 34.3% / 45.0% / 9.5%，A2 结束时为 29.0% / 37.4% / 9.4%，A1 结束时为 26.4% / 34.0% / 8.8%，片 14 结束时为 19.7% / 24.5% / 8.5%；片 2 结束时为 14.3% / 17.3% / 7.2%，片 3 结束时为 15.2% / 18.4% / 7.7%，片 4 结束时为 15.6% / 19.0% / 7.8%，片 5 结束时为 16.6% / 20.4% / 7.8%，片 6 结束时为 16.9% / 20.8% / 7.8%，片 7 结束时为 17.5% / 21.6% / 8.0%，片 8 结束时为 17.7% / 21.7% / 8.5%，片 9 结束时为 18.2% / 22.6% / 8.1%，片 10 结束时为 18.3% / 22.7% / 8.1%，片 11 结束时为 18.6% / 23.2% / 8.1%，片 12 结束时为 18.8% / 23.4% / 8.2%，片 13 结束时为 19.1% / 23.7% / 8.3%）。片 8 那次归类把 12 个单元记进了声明区（1847/779），片 9 复跑恢复为 1835/791，总数与历史一致；逻辑区覆盖率以复跑值为准。

## 4.7 片 3：归属查询 / viewport / residency / `restoreTabs`（104 单元）

**两个数**：`uncoveredUnits=104` → 写完后 79；**真正空白单元** 62 → 10。剩下的 10 个不是漏写：`operationActive`/`captureActive`/`downloadActive` 三个字段由上方 3 行块注释整体说明，`const restored`/`for` 与 `restoreTabs` 字面量里的 `rebindRequested`/`lifecycle` 同样由 4 行块注释覆盖，只是超出了一条注释只记「块首 1 个单元」的 8 行探测窗。这 10 个按判据属于「写了没贴住」，不再重复写。

**新增判定点**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `updateViewportFromRenderer` 的守卫 | 只比 `windowId`、不走 `requireRendererOwnedTab`（布局是窗口内事实），但必须拒 `closed` | 放行已关闭 tab 会把 override 写到正在析构的 guest 上 |
| 同上的 `throw` | pane 与 guest 尺寸不一致会让点击坐标整体偏移，所以不能静默返回 | 静默成功会让 renderer 不再重试，布局长期错位 |
| `viewport` 的 `null` 分支 | `null`=清除 override 回落自然尺寸，不是 0×0 | 把 null 当零尺寸下发会把页面钉死在 0 宽 |
| `reportResidency` 的 `cachedUrl` | `restoreUrl` 空串/空白保留旧值 | webview 重建期间的空上报会抹掉真实 URL（INV-17 快照随即判过期） |
| `reportResidency` 的 `cachedTitle` | `undefined`=没上报、`null`=确实无标题 | 混同会让标题在每次驻留上报时被清空 |
| `residencyCoordinator.report` | 只信任 renderer 可见的四项，其余由 main 现算 | 页面脚本一次伪造上报就能把预算里最贵的几项清零 |
| `selected` 分支 | user tab 只置 `active` 不进索引；agent tab 走 `selectTab` 同步 INV-01 | 进索引会让不带 tabId 的 agent 命令落到用户页面上 |
| 取消选中分支 | `scopeKey(tab.owner)` 必须现算、只删指向自己的条目 | claim/release 整体换 owner 后会用旧 key 删错索引；盲删会清掉并行切换的新 active |
| `acknowledgeSuspend` | `windowId` 先于 waiter 查表 | 窗口复用后，另一窗口的迟到 ACK 会提前解除本窗口挂起 |
| `closeTabFromRenderer` 幂等路径 | 无 tab 时也要补 tombstone（INV-16） | 缺墓碑会让迟到 attach 把用户刚关掉的标签复活 |
| `closeTabDurably(tab, false)` | `notifyRenderer=false` 避免用户点 × 再收到一次关闭通知；durable 先删恢复仓库 | 重复通知让 UI 闪一次；先删 registry 会让重启后复活 |
| `whenRecoveryIdle` | 实际只等 `recoveryStore.whenIdle`，不覆盖 guest 恢复 flight（D-9-4） | 调用方误把它当「没有在途恢复」的屏障 |
| `ensureResidentFromRenderer` | 一次性 signal + `ensureGuest` 复用 flight；`null` 必须抛错 | 复用外部 signal 会被前一条命令的 abort 波及；静默返回留下空白 pane |
| `restoreTabs` 查询 | `workspaceKey` 必填、另两域缺省不收窄；store 未注入返回空数组 | 误以为省略 sessionId 等于「只恢复本会话」 |
| 同上的 `[信任边界]` | `workspaceKey` 由调用方自报，未与 sender 窗口比对（D-16-1 落点） | 跨工作区可取回别人的 shell |
| 循环入口 | 墓碑优先（INV-16）、claim 先到先得 | 恢复仓库里的旧 shell 会让已关闭标签复活；多窗口会各建一份重复标签 |
| `owner` 字面量 | `requestId` 必须新生成（INV-08）、`browserGeneration` 缺省 0 是 INV-20 哨兵、`windowId` 取 payload | 复用 requestId 让首个命令判 duplicate；旧代际让 attach 判 mismatch |
| `tab` 字面量 | 无 guest 的 shell 按未挂载初始化；`claimable` 由 origin 推出；`userOwner` 只给 user shell | `cdpAttached=true` 让 teardown 对不存在的 guest 发 detach；给 agent shell 留 `userOwner` 会让 finalize 错误交还 |
| `openedAt` / `restoredFromStore` | 沿用记录以保持 LRU 真实新近度；后者是孤儿关闭开关 | 用恢复时刻会让所有 shell 同岁；缺开关会让孤儿 shell 永久驻留 |
| 既有 tab 分支 | 同 tabId 属别的窗口时不抢 owner；返回 shell 用 `tab.owner` 而不是记录 | 抢 owner 会打断原窗口；回放旧代际会让紧接着的 attach 判 mismatch |

**纠正一条既有注释**：`updateViewportFromRenderer` 原写「自然尺寸不做 `BROWSER_VIEWPORT_LIMITS` 钳制、显式 override 才校验」，与实现相反——renderer 上来的 pane 尺寸在这里会被 `assertViewportOverride` 校验并按 override 写入；不做钳制的是 `readTabViewport` 读到的 guest 实际尺寸。已按实际行为改写。

**新缺陷 D-9-4**：`whenRecoveryIdle` 注释承诺「用 allSettled 等所有恢复 flight」，实现只有 `await recoveryStore.whenIdle()`（内部仅等 mutation 队列），且当前 main 装配根本没注入 `recoveryStore`，该方法恒立即 resolve。已按格式记入 `ZC-DEFECTS.md`（低 / B 档），本批不改代码。

**D-16-1 增补落点**：`restoreTabs` 的 `workspaceKey`/`sessionId`/`remoteSessionId` 由 renderer 自报（IPC 只覆盖 `windowId`，`desktopBrowserViewIpc.ts:309-320`），与「凭据不绑调用方身份」同根因，已并入 D-16-1 的落点表，没有单列成新缺陷。

**指标**：本片新增 **63** 行注释（`comments` 1287 → 1350）；文件累计 **15.2%**（+0.9pt / +24 单元；分支 12.8% → 13.7%，字段 5.9% → 6.3%）；逻辑区 **18.4%**（+1.1pt）；声明区 **7.7%**（+0.5pt）。六件套全 0，第七件 `pairs=0`。

## 4.8 片 4：崩溃与恢复（`restoreSuspendedGuest` → `restoreReboundGuest`）

**两个数**：`uncoveredUnits=123` → 100；**真正空白** 39 → 32。余下 32 个集中在三份 `onSuspendTabRequested`/`onResidencyChanged` 载荷字面量（五个字段 × 三次重复）与 `pageState` 分支内部——三份载荷共用同一条块注释，`pageState` 整段由 `[可达性]` 注释整体交代「当前不执行」，按判据不再逐字段重复。

**D-9-4 定性结论：有意未启用，不是漏接线。**

| 证据 | 内容 |
| --- | --- |
| 产品决策 | `index.ts:554-560` 两处显式注释：不注入 `recoveryStore`，「Browser shell 不跨进程恢复，完整退出即清空是产品语义」 |
| 无开关 | `enableBrowserTabRecovery` / `tabRecovery` / `restoreShells` 在 `packages/**` 0 命中 |
| 无调用方 | `packages/ui` 内 `browserViewRestoreTabs` 0 命中，只有 preload 与 `globals.d.ts` 暴露 |
| INV 范围 | INV-17/19/20 只约束进程内 suspend/restore/residency generation，无一条声称跨重启恢复 |
| 测试 | `browserGuestManager.test.ts` 10 处手工注入假 `recoveryStore`；测试通过只证明注入后可用 |
| 反证 | `browserTabRecoveryStore.ts` 的 INV-03（`windowBindingId` 恒为 null）/INV-09（会话隔离）是跨进程恢复才需要的约束，说明实现完成后被产品关闭 |

因此 `restoreTabs` 恒返回 `[]`、`persistShell`/`persistRecoverySnapshot` 首行判空即 `return`、`whenRecoveryIdle` 恒立即 resolve。已在三处加整行 `[可达性]` 注释（`restoreTabs` 入口、`persistShell` 入口、`BrowserTabRecoveryStore` 类头），并写清四件开启条件（见 D-9-4）。

**可达性边界要说准**：不是「整条恢复链路都坏了」。`restoreGuestState` 在无 store 时 `getPageState` 得到 `undefined`，会跳过 pageState 校验直接 `loadURL(cachedUrl)`——**进程内 suspend/resume 的 URL 恢复仍然可用**，缺的只是跨进程落盘与多步历史（`navigationHistory.restore`）。

**新增判定点**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `markRestoring` 返回空 | 不是失败，不能 `failRestore` | 会把刚恢复成功的 tab 重新打回 suspended |
| 只有 `before=suspended` 才通知重建 | `restoring` 重复进入不再发第二次请求 | 并发 restore 各拉起一个 webview，attach 时争抢 `tab.guest` |
| restoring 载荷的 `generation` | 取 `transition.generation` 而不是观测量 | 两轮共用一个栅栏值，迟到 attach 能通过代际比对 |
| `waitForGuest` 失败 | `failRestore` 推进 generation 后同步发 suspended | 不推进则本轮迟到 attach 仍被接受；不通知则 renderer 永久停在 restoring |
| 回退载荷的 `generation` | 取 `failed.generation` | 用 `transition.generation` 会让新旧两轮在同一代际竞争 |
| 孤儿分支 | 先 `removeTabRecovery` 再关 tab | 顺序反了 shell 留在磁盘，下次启动恢复出同一条孤儿 |
| `completeRestore` 失败 | 只返回 null，不补发终态 | generation 已被并发路径替换，补发会让 renderer 收到过期 live |
| 终态 residency | 只允许 `live-visible` / `live-background` 两档 | 原样回传会让 renderer 停在 restoring 占位 |
| 恢复成功 | 清 `restoredFromStore` | 下一次普通 page-state 淘汰被误判成 recovery-orphan |
| `restoreGuestState` | `[可达性]` + 无 URL 必须返回 false | `loadURL("")` 落到 about:blank 会被当成恢复成功并提交 live |
| `restoreReboundGuest` 入口 | await 前先验 `tab.guest === guest` | 把历史写进即将析构的旧 guest |

**同类排查（用户点名的两条）**：

| 检查对象 | 结论 | 证据 |
| --- | --- | --- |
| `setupCdpCrashGuard` | 已接线，非死代码 | `:1157` 在 `!isSameGuest` 时注册；`:3940` 注册前先执行旧 cleanup；`:5223-5227` 在 teardown 调用 `crashGuardCleanup` 并置空 |
| `runGuestTeardown` | 已接线，非死代码 | `:5074`/`:5087` 两个入口（replacement / 显式 teardown）；内部 `:5199-5241` 依次执行 `downloadCleanup`/`crashGuardCleanup`/`cdpMessageCleanup` 并置空，与 INV-27 一致 |
| 附带发现 | `setupDialogTracking` 同样在 `:1158` 接线，`cdpMessageCleanup` 在 teardown 清理；未发现「注册了但没人调用」的第三例 | 同上 |

**指标**：本片新增 **28** 行（`comments` 1350 → 1378，`addedCommentLines` 974 → 1003；其中 7 行是三处 `[可达性]` 注释）；文件累计 **15.6%**（+0.4pt / +11 单元，分支 13.7% → 14.9%，字段 6.3%）；逻辑区 **19.0%**（+0.6pt）；声明区 **7.8%**（+0.1pt）。六件套全 0，第七件 `pairs=0`。

## 4.9 片 5：teardown 与总收口（`runGuestTeardown` / `detachGuest` / `disposeAll`，150 单元）

**片界**：`detachGuestBeforeReplacement` → `beginGuestTeardown` → `runGuestTeardown` → `waitForGuestCdpIdle` → `collectMemoryDiagnostics` → `detachGuest` → `hasGuest` → `disposeAll`。

**两个数**：`uncoveredUnits=150` → 103；**真正空白** 4 → 剩 4（`5080`、`5095`、`5288`、`5290`）。这 4 个都是块注释摊薄的续行或模板字符串结尾，已由上方整段说明覆盖，按判据不重复写。

**判定点（顺序反了会怎样）**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `runGuestTeardown` 入口 | 先置 `detaching` 再 abort 请求 | 并发到的 `attachGuest` 会在取消与置位之间看到 `attached`，把正在拆的 guest 当可复用 |
| CDP idle 超时 | 只 `warn`，仍继续 detach | 判负会让 `closeTab` 永久挂起；这是对 INV-05 的有意降级（见 D-9-5），不是疏漏 |
| destroyed 且 `cdpAttached` | 返回 false，不假装已断开 | 直接清标志会让后续代际断言放过仍挂着旧 Debugger 的 guest；继续重建则撞 INV-04 的 UAF 窗口 |
| `detach()` 后二次 `isAttached()` | `detach()` 无返回值，只能复核 | 不复核就无法确认 native 已断开，返回值变成猜测 |
| detach 抛错回滚 `attached` | 不留在 `detaching` | 留 `detaching` 会让该 guest 上任何 CDP 命令与录制在 `assertCurrentGuest` 处永久抛错 |
| `cdpAttached=false` 先于 `detachGuest` | 先清标志再收口 | 反了会把一次已确认断开的正常收口误报成崩溃路径 |
| `detachGuest` 的 INV-18 分支 | 恢复在飞时不回写 `cachedUrl` | 替身的 `getURL()` 会覆盖逻辑地址，下一次恢复加载错误页面 |
| `guestLifecycle` 终态二态 | `destroyed` 表示 guest 先被销毁，`detached` 表示本进程主动断开 | 当前无分支按值分叉，仅用于事后判断崩溃路径；写错会误导排障 |
| `disposeAll` 迭代 `tabs` | 直接迭代 Map | `closeTab` 只删当前 key 时安全；若将来连带删别的 key，必须先复制再遍历 |
| `downloadWaiters` 清空 | 每轮重读 `waiters[0]` | 索引递增会跳过被前移的元素，快照遍历会重复 resolve |
| 下载 vs 录制产物 | 下载只清索引，录制删 artifact | 删下载文件等于替用户做破坏性决定；录制是本次运行的临时产物 |
| `suspendAckWaiters` | 逐个 `resolve` 再清 | 只清引用会让 renderer 永远挂在 await 上（INV-34） |
| 四个 flight | 只清引用，不在此结算 | 缓存里是 Promise 而非 deferred；结算点在超时、`resolveWaiters` 与 `closeTab` |

**时序缺口排查结论**：本片范围内没有发现「注册了但 cleanup 不完整」。`downloadCleanup` / `activityCleanup` / `crashGuardCleanup` / `cdpMessageCleanup` 四组都在 `detachGuest` 里 `try/catch + finally` 置空；`disposeAll` 经同步 `closeTab → detachAndCloseGuest → detachGuest` 收口，不需要额外补清理。唯一的边界提示是 `disposeAll` 对 flight 只 `clear()`：这依赖 `waitForGuestCdpIdle` 的超时兜底让 teardown flight 落定，已写进注释，不改代码。

**新增缺陷**：`D-9-5`（低，B 档）——**有意降级**：CDP idle 超时后仍 detach 并返回 teardown 成功，主动放弃 INV-05「`pendingCdpCommands` 归零前不得宣称成功」的严格保证。放弃它换来的是 `closeTab` 与替换路径不会永久挂起；只有当未结算命令含写操作时才会变成真问题。INV-05 原文不改、继续作为水位，条目只登记取舍，不得靠改条款消掉水位。

**指标**：本片新增 **38** 行（`comments` 1410 → 1448，`addedCommentLines` 1003 → 1073）；文件累计 **16.6%**（+1.0pt / +27 单元，分支 14.9% → 18.2%，字段 6.3%）；逻辑区 **20.4%**（+1.4pt）；声明区 **7.8%**（持平）。六件套全 0，第七件 `pairs=0`。

## 4.10 片 6：截图 prepare 与 surface（2091–2248，59 单元）

**片界**：`executeInScope` 的截图分支（`screenshotCommand` 定性 → 在飞闸门 → abandoned 闸门 → surface 分支）与 `executeScreenshotWithPreparedSurface` 的签名/lease 起点。

**两个数**：`uncoveredUnits=59` → 52；**真正空白** 35 → 18。余下 18 个集中在 `ok:false` / `error` / `message` / `sideEffect` / `elapsedMs` 返回信封字段与日志模板串，已被上方整段说明覆盖，按判据不重复写。

**判定点**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `handleDialog` 成功才清 `pendingDialogs` | 失败保留给 detach/closeTab 按 INV-28 清理 | 提前删会让页面上仍挂着的对话框再也关不掉 |
| `screenshotCommand` 一次性定性 | 在飞闸门、abandoned 计数、surface 分支共用同一判定 | 各处各自判断 method 会漂移，某条路径绕过并发闸门叠 CDP |
| `isInFlightScreenshotAlive` 闸门 | 只认 `runningRequests` 中未 abort 的条目 | 死槽位会秒拒到 tab 关闭（INV-23） |
| abandoned 计数只对截图读 | 非截图命令不叠加底层 capture | 用残留计数拒绝会误伤正常调用 |
| 截图走独立 surface 分支 | 其余命令直连页面 executor | 两条路径最终都要过 `raceBackendExecution`，否则取消语义不一致 |
| 只给截图登记 tracker | 录制有独立生命周期，普通命令没有可被放弃的底层 capture | 给普通命令登记会让 `captureActive` 虚高、拖住 tab 回收 |
| 第二道 race | `settleScreenshotCapture` 已在 capture 层收敛 abort/deadline | 覆盖「结果已产生、请求恰被 abort」的窗口 |

**时序缺口 → 新缺陷 D-9-6**：`isTabCaptureActive`（`:4944-4952`）只读 `inFlightScreenshots` / 运行中的录制 / `guest.isBeingCaptured()`，**从未读 `abandonedScreenshotCaptures`**。截图被 abort 或 hidden-deadline 先结算后，tracker 由 `clearTrackedScreenshot` 按 identity 删除，而底层 CDP `Page.captureScreenshot` 仍 pending；此时 `refreshRuntimeProtection` 上报 `captureActive:false`，`isBrowserTabResidencyProtected` 不再保护该 tab，tab 数达上限时可被 LRU 回收，pending 命令在销毁的 webContents 上失败。这与 `:4942-4944` 注释「截图活跃包括已放弃但底层未结算」的承诺相反。已按格式记入 `ZC-DEFECTS.md`（低 / B 档），本批不改代码。

**为什么没把「截图时机与可见性」立成缺陷**：`readTabViewport` 在进入 viewport 临界区前取值，理论上存在「排队期间 resize 使 prepare 载荷过期 → `sameBrowserScreenshotViewport` 拒绝 ready → 35s 超时」的 TOCTOU；但触发需要精确并发，结果只是该次截图失败、无状态损坏，按「不收录纯竞态」的门槛未立条，仅在 `:2252-2254` 既有注释旁保持现状。

**指标**：本片新增 **13** 行（`comments` 1449 → 1462）；文件累计 **16.9%**（+0.3pt / +7 单元，分支 18.2% → 19.0%，字段 6.3% 持平）；逻辑区 **20.8%**（+0.4pt）；声明区 **7.8%**（持平）。六件套全 0，第七件 `pairs=0`；`zc-gate` 第一遍 2 行 water（`:2105`、`:2197` 为列举式），改写成带因果连词的句子后归零，未删任何既有注释。

## 4.11 片 7：截图执行体 / presentation / abandoned capture（2247–2576，125 单元）

**片界**：`executeScreenshotWithPreparedSurface` 全体 + `startHiddenWindowCapturePresentation` + `settleScreenshotCapture` + `abandonBackendCapture` / `releaseAbandonedBackendCapture` / `isInFlightScreenshotAlive`。表内「2249–2400 / 62 单元」是注释前基线行号，`settle/abandon` 当时被算进了片 8 的行区间；本片按语义收齐，故单元数为 125。

**两个数**：`uncoveredUnits=125` → 110；**真正空白** 31（余下是返回信封 / 错误对象字段与日志模板串，已被上方整段说明覆盖）。

**判定点**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `readTabViewport` 在临界区前 | 排队期间 resize 会让 prepare 载荷过期、ready 被拒并拖到 35s 超时；**不立条**，因触发需精确并发、后果仅该次失败、无状态损坏 | 把纯竞态记成缺陷会稀释册子可信度 |
| prepare 后四联守卫 | aborted / 换代 / 已销毁 / lease 指向别的 webContents 任一成立都放弃 | 对着旧 guest 的 surface 截图并当成本 tab 的结果 |
| surface 失效前后各判一次 | ready 后、capture 前以及 capture 后各查 `lease.invalidated` | 拿被收回的 surface 截图；或把黑帧/旧帧返给模型 |
| `captureViewportScreenshot` 惰性闭包 | 只有归一化路径真读合成 surface 时才调 `capturePage` | 普通 CDP 路径白多一次 capturePage |
| `!result` 兜底 | 回调走完却没赋值说明漏分支 | 返回 undefined 更难定位 |
| 截图 catch 报 `sideEffect:"none"` | 截图只读，已下发后报 none 不会诱导重复写 | 写命令必须报 uncertain，两者不能混用口径 |
| `settleScreenshotCapture` 的 settled 幂等 | abort 与 execution 同时到只有一方 finish、只记一次名额 | 名额重复计数，上限永远回不到 0 |
| 先挂 abort 监听再查 `aborted` | 反序会在两步之间漏掉一次 abort | execution 悬空到上游 watchdog |
| rejection 分支也 finish | 漏掉则失败永不结算 | viewport mutation 队列与 in-flight 槽位一起卡死 |
| deadline 只在隐藏窗口传 | 可见窗口由上游 30s cancelRequest 约束 | 重复设表导致提前判死可见窗口截图 |

**D-9-6 代码侧指路**：按用户要求，在 `abandonedScreenshotCaptures` 的**写点**（`abandonBackendCapture` 的 `set`）、并发闸门**读点**（`executeInScope` 的 `abandonedCaptures`）、保护判定**缺口点**（`isTabCaptureActive`）三处各加一句「保护链在此断开，见 D-9-6」；`isTabCaptureActive` 上方原有的意图句保持原文不动，作为水位。

**指标**：本片新增 **34** 行（`comments` 1462 → 1496）；文件累计 **17.5%**（+0.6pt / +15 单元，分支 19.0% → 19.7%，字段 6.3% 持平）；逻辑区 **21.6%**（+0.8pt）；声明区 **8.0%**（+0.2pt）。六件套全 0，第七件全 0；`zc-gate` 首遍 4 行 water、二遍 2 行、三遍 1 行，逐行补因果连词后归零。

## 4.12 片 8：录制生命周期（原表 2401–3001 / 330 单元）

**片界**：`recordingNow` → `createRecordingEntry` / `snapshotRecording` / `setRecordingPhase` / `setRecordingTerminal` / `abortRecordings` / `runRecording` / `restoreRecordingViewport` / `executeRecordingActions` / `executeRecordingAction` / `executeRecordingBrowserCommand` / `resolveRecordingSelector{Point,ScrollTarget}` / `moveRecordingPointer` / `installRecordingCursorOverlay` / `removeRecordingCursorOverlay` / `animateRecordingScroll`，到 `resolveTab`（片 9）之前收口。按用户裁量预切 8a（入口与生命周期）/ 8b（动作分发与动画），一次落盘、不中途汇报。

**两个数**：`uncoveredUnits=329` → **真正空白 216**；余 113 是块注释摊薄的单条语句、返回信封字段与日志参数，按判据属「写了没贴住」，不重复写。

**判定点**（选摘）：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `createRecordingEntry` 的 `context` | 必须整体快照；`recordingStatus/Cancel` 用 `entry.context` 做 `sameScope` | 持有 `tab.owner` 引用时，claim/finalize 换主后旧 scope 查不到自己的录制 |
| `setRecordingTerminal` 的幂等 | 守卫在调用方（三处都先判 `status==="running"`），本函数只保证 `cleanupTimer` 单挂（INV-25 守卫分两处） | 新增调用点不判 status 会把 `cancelled` 覆盖成 `failed/completed` |
| `abortRecordings` 的顺序 | 必须先 `abort` 再写终态 | 反序时 `runRecording` 的 catch 先看到 running，把本次取消记成 failed |
| `runRecording` 的超时起算点 | `maxDurationMs` 从 surface 就绪后开始，不含 prepare；prepare 由 `activityTimeoutMs = max+30s` 兜 | 两段共用一块预算时，慢 prepare 会吃掉取景时间 |
| `assertCurrentGuest` 先判 `detaching` | 该阶段 `tab.guest` 可能还没换，只比引用会放行正在 teardown 的 guest | 在已 detach 的 CDP 会话上继续录制 |
| `onCaptureComplete` 清 `timeout` | **不立条**：编码阶段因此再无超时兜底，卡住只能靠调用方 cancel；理由（换取「不误杀已拍完的视频」）写进 `:2809-2811` 注释 | 不写理由会让下一个人以为是漏了兜底 |
| `runRecording` 的 finally 四步 | 停表 → 摘光标 → 还原 viewport → 释放 surface，顺序不可换 | 先放 surface 会让后续 `setTabViewport` 落在已换比例的画面上 |
| `restoreRecordingViewport` | `closed` 早退；`previous` 为空走 `reset`（不能用默认尺寸代替） | 与 teardown 抢 CDP；把「从未设置」与「显式设成默认值」混同 |
| `executeRecordingAction` 的 `cancelled` / `timeout` | 必须分流：取消落 `cancelled`，超时落 `failed` | 用户主动取消的录制在结果里显示为失败 |
| `moveRecordingPointer` / `animateRecordingScroll` 的 60 帧 | 长 duration 按 16ms 逐帧会生成上千条 CDP | 压住主进程，后续动作排不进时间轴 |

**本片新缺陷两枚**：`D-9-7`（光标 overlay 注入失败会中止整段录制、导航后不重注入，与上方注释正相反）、`D-9-8`（`abortRecordings` 上方给的两条取消理由均不成立：状态由自身同步写定，半成品被 `recordBrowserVideo` 主动删除）。代码侧已在 `installRecordingCursorOverlay` 与 `abortRecordings` 原地挂编号指路，意图句原文未改。

**指标**：本片新增 **59** 行（`comments` 1496 → 1555）；文件累计 **17.7%**（+0.2pt / +7 单元，分支 19.7% → 20.1%，字段 6.3% 持平）；逻辑区 **21.7%**（+0.1pt）；声明区 **8.5%**（+0.5pt）。六件套全 0，第七件全 0；`zc-gate` 首遍 10 行 water、二遍 1 行、三遍归零（逐行补「必须 / 否则 / 因此」等因果谓词，未删任何既有注释）。

## 4.13 片 9：tab registry（原表 3002–3321 / 127 单元）

**片界**：`resolveTab` / `createTab` / `ensureGuest` / `waitForGuestRecovery` / `runGuestAttachFlight` / `ownedTabs` / `canClaimUserTab` / `openUserTabs` / `hasDiscoverableUserPage` / `claimTab` / `selectTab` / `releaseToUser` / `finalizeTabs`，到 `effectiveActiveTabId` 之前收口。

**两个数**：`uncoveredUnits=127` → 真正空白 **42**；其余 85 是既有块注释摊薄的返回字段与单条语句。

**判定点**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `resolveTab` 的显式分支 | 查不到/已关闭/跨 scope 一律 `undefined`，不能回退 active | 越权或拼写错误被静默改写成「操作另一个页面」 |
| `resolveTab` 的索引读取 | 索引可能陈旧，读路径重新校验 lifecycle 与 owner，但不顺手清理 | 并发读在遍历中改 map，迭代行为不确定 |
| `resolveTab` 的回退顺序 | active → default → 最近存活；`recent` 放最后 | 从未激活的 tab 抢走命令落点 |
| `createTab` 的 legacy id | legacy 复用 `sessionId` 换稳定身份，新路径用 UUID；墓碑不随创建清除（D-9-9） | 关闭后重建撞上自己的墓碑，attach 永久被拒 |
| `ensureGuest` 的 destroyed 分支 | 先同步 `detachGuest` 再建 flight | 中间留 await 会让另一命令复用到已销毁 guest |
| `waitForGuestRecovery` | 必须 `settled.value === guest` 比对 identity | 换代后把新 guest 当旧 guest 返回，CDP 打在错误会话 |
| `runGuestAttachFlight` 的重放条件 | 只在「曾 attach 过」或「已知失败原因」时 `requestGuestRebind` | 新 tab 首次等待超时就无限重建 webview |
| `canClaimUserTab` | 用 `ownedBySession` 而非 `sameScope` | 换成 `sameScope` 会让 claim 永远失败 |
| `openUserTabs` 的排序 | 实际只比较 `active`，组内靠稳定排序维持插入序 | 恢复的 tab 顺序与 `openedAt` 不一致，不能据此推断新近度 |
| `selectTab` 的上报 | 未选中的候选也要 `selected:false`；方法本身不校验调用方 | 旧 active 继续自报选中；新调用点绕过 `resolveTab` 即可改别的 scope |
| `releaseToUser` | 清索引只删指向自己的条目、`requestId` 必须新生成、lifecycle 回 `active`；viewport 复位不在本函数（D-9-10） | 复用请求 id 触发 INV-08；handoff 状态残留导致后续 attach 被拒 |

**本片新缺陷两枚**：`D-9-9`（legacy 复用 `sessionId` 作 tabId，关闭后重建被 `closedTabIds` 永久拒绝）、`D-9-10`（`releaseToUser` 注释称清后台 viewport，实现只改归属）。两处均按「意图句原文保留 + 代码原地挂编号」处理；D-9-9 在读点（`attachGuest` closed 分支）、写点（`createTab` 覆盖条目）、缺口点（`resolveTab` 的 legacy 分支）各留了指路。

**指标**：本片新增 **36** 行（`comments` 1555 → 1591）；文件累计 **18.2%**（+0.5pt / +12 单元，分支 20.1%、字段 6.3%）；逻辑区 **22.6%**（+0.9pt）；声明区 8.1%。六件套全 0，第七件 0 对；`zc-gate` 首遍 2 行 water（`selectTab` 信任边界句、`releaseToUser` 指路句），补谓词后归零。

## 4.14 片 10：归属 / 请求生命周期 / closeSession / closeWindow / closeTab（原表 3322–3796 / 164 单元）

**片界**：`effectiveActiveTabId` / `summary` / `readTabViewport` / `withMeta` / `cancelledOrUnavailable` / `unavailableTabResult` / `cancelledResult` / `abortRequest` / `releaseGuestCdpAfterIdle` / `endTurn` / `closeSession` / `closeSessionTabs` / `closeWindow` / `removeTabRecovery` / `closeTabDurably` / `closeTab`，到 `setupCdpCrashGuard`（片 11）之前收口。

**两个数**：`uncoveredUnits=164` → 真正空白 **61**；余 103 是既有块注释摊薄的返回信封字段与单条语句。

**判定点**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `summary` 的 `active` | 用 `effectiveActiveTabId` 现算，不读 `tab.active` | 字段滞后时列表出现两个 active |
| `summary` 的 `lifecycle` | 只暴露 deliverable/handoff；closed 不出现、suspended/restoring 不外露 | 暴露中间态会诱发调用方对不可用 tab 重试 |
| `withMeta` | `openTabIds` 现算不缓存；`currentUrl` 优先读 guest 但必须 sanitize（INV-30） | 缓存会报幽灵 tab；未脱敏 URL 进模型轨迹 |
| `cancelledOrUnavailable` | 先判 aborted 再判 unavailable | 反序把用户取消报成 `backend_unavailable`，模型会重试 |
| `cancelledResult` | `_context` 故意不用；`sideEffect` 由 `dispatched` 决定（INV-33） | 自带 meta 会覆盖调用方的 lifecycleOverride；未下发时会误报 uncertain |
| `releaseGuestCdpAfterIdle` | 先比 tab identity 再比 lifecycle；失效就放弃不重试 | 换代后把 detach 打到新 guest 上 |
| `closeSession` | 按 `scopeKey` 兜底清 active/default，再清 `sessionNames`/`visibilityByScope` | 同 key 新会话读到上一轮索引与可见性 |
| `closeSessionTabs` | 注释称 `allSettled`，实现逐条 await（D-9-11） | 一次持久化失败让后续 tab 留在 registry |
| `closeWindow` | 只清 `naturalViewportByWindow`，scope 级索引与可见性缓存未清（D-9-12） | windowId 复用时新窗口继承上一轮可见性 |
| `closeTabDurably` | 刻意先删恢复仓库再关内存 tab（与 `closeTab` 相反） | 反序会在写盘失败后留下「已关但重启复活」的 tab |

**本片新缺陷两枚**：`D-9-11`（`closeSessionTabs` 声称 allSettled，实际一条失败即中断）、`D-9-12`（`closeWindow` 漏清 scope 级索引与可见性缓存）。

**指标**：本片新增 **17** 行（`comments` 1591 → 1608）；文件累计 **18.3%**（+0.1pt / +2 单元，分支 20.1%、字段 6.3%）；逻辑区 **22.7%**（+0.1pt）；声明区 8.1%。六件套全 0，第七件 0 对；`zc-gate` 首遍 1 行 water（D-9-11 指路句为短句），补主语后归零。

## 4.15 片 11：崩溃守卫 / dialog / download / viewport 串行（原表 3797–4211 / 167 单元）

**片界**：`setupCdpCrashGuard` / `onRenderProcessGone` / `setupDialogTracking` / `handleDialog` / `setupDownloadTracking` / `waitForDownload` / `finishDownloadWaiter` / `setTabViewport` / `applyBackgroundViewportFallback` / `restoreNaturalViewportAfterBackground` / `maybeRestoreBackgroundViewport` / `enqueueViewportMutation` / `insideViewportMutation`，到 `runRestoreSuspendedGuest`（片 12）之前收口。

**两个数**：`uncoveredUnits=167` → 真正空白 **44**；余 123 是既有块注释摊薄的字段与单条语句。本片是全文件注释密度最高的一段（P2 批次已写过），因此只补「身份比较」与「顺序」两类缺口。

**判定点**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `setupCdpCrashGuard` 入口 | 先执行 `crashGuardCleanup` | 重复 setup 挂两份监听，崩溃时 detach 两次、第二次抛 not attached |
| `onRenderProcessGone` | 身份匹配才改 `guestLifecycle="detaching"` | 旧 guest 崩溃把当前 tab 卡在中间态（INV-03） |
| `setupDialogTracking` 的 `Page.enable` | 失败只 log，不阻断 attach | 域未开启就让整次 attach 失败 |
| dialog 的 `onMessage` | 必须比对 `current.guest === guest` | 迟到事件把旧页面 dialog 写进新 tab（INV-28） |
| `setTabViewport` | 先清 `backgroundViewportFallback` 再写 override | `readTabViewport` 优先读 fallback，agent 尺寸被后台兜底顶掉 |
| `applyBackgroundViewportFallback` | 用引用比对确认下发时 fallback 仍是自己那份 | await 期间 agent 已设 override，旧兜底覆盖新状态 |
| `restoreNaturalViewportAfterBackground` | 每个 await 后重校验 guest/fallback/override | 读到另一次 mutation 的布局值 |
| `enqueueViewportMutation` | 清空 `viewportMutation` 前比 identity | 盲清会从中间断开队列，后续写入不再串行（INV-21） |
| `setupDownloadTracking` | 同时比 `contents` 与 `tab.guest` | 同 session 其它 guest 的下载记到本 tab |
| `waitForDownload` | 先消费队列再挂 waiter | 早到的事件留在队列里，下一次等待拿到上一个 id |

**本片无新缺陷**：`waitForDownload` 在 will-download 时即返回 id、`path` 可能为 null 是接口层已声明的契约（由 `done` 回填），不按缺陷记。

**指标**：本片新增 **20** 行（`comments` 1608 → 1628）；文件累计 **18.6%**（+0.3pt / +9 单元，分支 21.1%、字段 6.3%）；逻辑区 **23.2%**（+0.5pt）；声明区 8.1%。六件套全 0，第七件 0 对；`zc-gate` 首遍即 0 water。

## 4.16 片 12：CDP 恢复回滚 / `toControlledView` / residency 注册 / 持久化（原表 4212–4693 / 251 单元）

**片界**：`runGuestCdpSessionRestore` / `rollbackGuestCdpRestore` / `sendGuestCdpCommandRaw` / `sendGuestCdpCommand` / `toControlledView` / `registerTabResidency` / `closeTabForLimit` / `restoreSuspendedGuest` / `runRestoreSuspendedGuest` / `restoreGuestState` / `restoreReboundGuest` / `persistRecoverySnapshot`，到 `persistShell`（片 13）之前收口。

**两个数**：原表本片 251 单元，开写前未覆盖 **218**；其中真正空白 **97**，余 121 是既有块注释摊薄的载荷字段、日志模板串与单条语句，按判据不重复写。

**判定点**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `runGuestCdpSessionRestore` 的 `cdpAttached` | 必须回读 `isAttached()`，不能直接置 true | attach 静默失败时 teardown 会对不存在的会话 detach，后续命令也跳过重建 |
| 同上的 `replayViewport` | 入队到执行之间重新比 `guest` / `lifecycle` | 旧 tab 的 metrics 写到新 guest 上，首帧尺寸与缓存分叉且无人纠正 |
| `rollbackGuestCdpRestore` | `[权衡]` 标出「只清本次写入」与「无条件 detach」的边界 | 读者会以为 detach 被禁止；新增已 attach 入口时必须先记 attach 前状态 |
| `sendGuestCdpCommandRaw` 的 zoom 复位 | 只在 `!sessionId && tab.guest === guest` 且 method 为 metrics override 时做 | 子会话复位改错对象；换代后复位会掩盖新页面自己的首条命令 |
| `sendGuestCdpCommand` 的断言顺序 | 先 `assertCurrentGuest` 再比 guest/lifecycle | 只剩笼统的 detaching，排查被引向错误方向 |
| `toControlledView` 的 `executeJavaScript` | 固定 `userGesture=true` | 站点把写操作绑在 user activation 上时，命令报成功但页面没有变化 |
| `registerTabResidency` 的 `lastActivityAt` | 取 `openedAt` 而不是 `now()` | 恢复的 tab 因登记变成最近活跃，LRU 永远挑不到它 |
| `closeTabForLimit` 的过期记录 | tab 不存在/已关闭返回 true | 返回 false 会让调用方拒绝新建，而预算其实早已不超 |
| `restoreSuspendedGuest` 的取消返回 | 单个 caller 取消只返回 null，不回滚 coordinator | 共享 flight 仍会推进，回滚会把别人的成功打回 suspended |

**本片无新缺陷**。`rollbackGuestCdpRestore` 上方「不能 detach 整个 CDP」与实现的无条件 detach 在字面上不一致，但两个调用方进入时必为 detached（restore flight 只在 `!isAttached()` 时新建），**按门槛不立条**：触发需「已 attach 的入口复用本函数」（当前不存在）、后果仅该次会话被重建、无状态损坏；理由已写进 `:4528-4534` 注释。

**指标**：本片新增 **22** 行（`comments` 1628 → 1650，`addedCommentLines` 179 → 201）；文件累计 **18.8%**（+0.2pt / +5 单元，分支 21.6%、字段 6.3%）；逻辑区 **23.4%**（+0.2pt）；声明区 **8.2%**（+0.1pt）。六件套全 0，第七件 0 对；`zc-gate` 首遍即 0 water。

## 4.17 片 13：runtime protection / rebind / teardown 前置（68 单元）

**片界**：`persistShell` / `requireRendererOwnedTab` / `setupActivityTracking` / `refreshRuntimeProtection` / `hasRunningRequestForTab` / `isTabCaptureActive` / `hasPendingDownloadForTab` / `detachAndCloseGuest` / `rejectGuestAttach` / `requestGuestRebind` / `closeGuestWebContents` / `now` / `warn` / `detach` / `detachGuestBeforeReplacement`。

**判定点**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `persistShell` 的 `windowBindingId` | 固定写 `null` | 写死窗口会把跨进程恢复的 tab 绑回旧窗口 |
| 同上的 `viewport` | 只持久化显式 override，不落 `backgroundViewportFallback` | 下次启动把「曾经的后台尺寸」当用户布局，自然尺寸回退被跳过 |
| `requireRendererOwnedTab` 的 `skipRemoteSession` | 只给 `closeTabFromRenderer` 这类关闭收敛路径用 | 操作/attach 路径跳过该字段，重连后的旧 runtime 能操作新会话的 tab |
| `setupActivityTracking` 的 `onLoadingStopped` | 恢复 flight 在飞时不回写 `cachedUrl`/`cachedTitle` | 临时 guest 的地址覆盖 logical cache（INV-18） |
| 同上的 `onAudioChanged` | 不做身份比对只重读当前 guest | 若改成写 tab 字段，换代瞬间会把旧 guest 的音频状态记到新 guest |
| `hasRunningRequestForTab` | 追加 D-9-1 指路：实现只按 tabId 过滤，未看 dispatched/aborted | 读者会按注释以为取消后的请求不阻止 detach |
| `detachAndCloseGuest` 的 guest 引用 | 先保存 `tab.guest` 再 detach | detach 触发 destroyed/cleanup 后重读可能指向新 guest，旧 WebContents 漏关 |
| `rejectGuestAttach` 的关闭条件 | 只有 incoming 未被收养时才 close | 并发 attach 已把它写进 `tab.guest` 时盲关，会拆掉刚接管的页面 |
| `requestGuestRebind` 的 `attachFailure` | 必须在三个早退之前写 | 不重绑时 `summary`/重试看不到最近一次失败原因 |
| `closeGuestWebContents` | `waitForBeforeUnload: false` | 站点用 beforeunload 无限拖延，teardown 被页面脚本永久挂起 |
| `detach` | 收口是同步的，不存在新命令插入窗口；未知 key 静默返回 | 误以为有 await 窗口；对已关闭 tab 重发屏障会多一条报错 |
| `detachGuestBeforeReplacement` 的未知 tab | 返回 true | 回 false 会让 renderer 永远停在重建前，ACK 不会再来 |

**本片无新缺陷**；补的是已登记 `D-9-1` 的代码内指路（`hasRunningRequestForTab`）。

**指标**：本片新增 **20** 行（`comments` 1650 → 1670，`addedCommentLines` 201 → 221）；文件累计 **19.1%**（+0.3pt / +7 单元，分支 22.3%、字段 6.3%）；逻辑区 **23.7%**（+0.3pt）；声明区 **8.3%**（+0.1pt）。六件套全 0，第七件 0 对；`zc-gate` 首遍 2 行 water（viewport 列举、D-9-1 尾句），改写后 0。

## 4.18 片 14：teardown / detach / `disposeAll` / waiter 与尾部 helper（163 单元）

**片界**：`beginGuestTeardown` → 文件尾（含 `runGuestTeardown`、`waitForGuestCdpIdle`、`detachGuest`、`disposeAll`、三个 waiter helper、viewport/dialog/URL 工具函数）。

**判定点**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `linkAbortSignal` | 返回注销函数；已 abort 必须同步转抛 | 匿名包装器无法外部移除，signal 会长期持有已结束请求的 controller |
| `waitForPromiseWithSignal` | 三态返回、不真正取消底层、rejection 统一包 Error | 每处调用点都要重写取消归一化；非 Error reason 在 IPC 桥上丢失 |
| `waitForDelay` | 只回 boolean；abort 必须 `clearTimeout` | timer 攥着闭包到超时，取消频繁时等同持续泄漏 |
| `waitForCondition` | 三态区分 timeout/cancelled；轮询上限 `min(50, remaining)` | 合成 false 会让取消走超时分支；固定间隔会睡过 deadline |
| `readScreenshotSurfaceInvalidation` | 原样透传 Error reason | 日志丢掉「被哪条路径取消」，surface 失效与超时无法区分 |
| `raceBackendExecution` | 入口先判 aborted；拒绝分支省略 sideEffect 的防御性说明 | 漏判会把取消结果落到 `execution.then` 当成成功；防御分支被误读成可达路径 |
| `isBrowserViewportSize` / `assertViewportOverride` | 形状与范围分开校验 | 合并后 renderer 只收到「类型不对」，无法提示合法范围 |
| `isBrowserPointValue` | 允许负数与小数 | 用整数/正数判断会把滚动容器外的合法命中全部拒掉 |
| `abortError` | `name=AbortError`，文案只用于日志区分 | 上层按文案识别取消，改文案就会破坏取消判定 |
| `normalizeBackgroundViewport` | 夹到 `BROWSER_VIEWPORT_LIMITS` | CDP 拒绝越界 metrics，后台操作集体失败 |
| `isScreenshotCommand` | 覆盖原生 method 与 playwright `elementScreenshot` | 元素截图不计入 captureActive，与整页截图抢同一个 compositor |
| `safeStr` / `safeBool` | 属性访问本身可抛；fallback 由调用方选 | 只判返回值类型拦不住 destroyed 对象；统一 fallback 会掩盖「最坏情况」语义 |
| `normalizeDialogType` | 未知类型按 alert | 丢弃会让弹窗永远挂着（没有 handleDialog 入口） |
| `sanitizeBrowserMetaUrl` 根路径 | 去掉尾斜杠 | origin 与 `/` 两种写法产生两个 key，轨迹按 URL 去重失效 |
| `collectMemoryDiagnostics` | 追加 D-9-13 指路：注释称四类计数，实现只回两项 | 读者会以为 guest/waiter/recording 泄漏可从采样观察 |

**新缺陷 D-9-13**：`collectMemoryDiagnostics` 注释称统计 tab/guest/waiter/recording 四类数量，实现只返回 `tabs`/`closedTabIds`，三类泄漏在诊断采样里不可见（C 档 / 低）。已按格式记入 `ZC-DEFECTS.md`，本批不改代码，注释原文保留为水位并在实现处挂编号。

**指标**：本片新增 **39** 行（`comments` 1670 → 1709，`addedCommentLines` 221 → 260）；文件累计 **19.7%**（+0.6pt / +16 单元，分支 22.3%、字段 6.3%）；逻辑区 **24.5%**（+0.8pt）；声明区 **8.5%**（+0.2pt）。六件套全 0，第七件 0 对；`zc-gate` 首遍 2 行 water，改写后 0。

## 4.19 A1 命令派发：`execute` / `executeInScope` / `raceBackendExecution`

**片界**：`execute`（1493–1560）、`executeInScope`（1564–2402，含 visibility / viewport / 录制查询与取消 / activate / claim / finalize / newTab / 通用命令 / download 等待 / dialog / 截图闸门）、`raceBackendExecution`（5806–5855）。

**单元账**：计划 201 逻辑 + 173 声明。实际新增 **177** 行，逻辑区 450 → **624**（+174，34.0%），全文件 517 → **694**（26.4%），声明区 67 → 70。差的 27 个逻辑单元是参数行与已在既有块注释 2 行内的行，按判据不重复写。

**判定点**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `execute` 的 `linkAbortSignal` | 注销必须放 `finally` 首位，早于 `executeInScope` 抛错 | 已结束请求的 signal 继续持有 controller，迟到 abort 改终态 |
| `executeInScope` 的 `tabId` 回填 | `running.tabId` 必须在 `ensureGuest` 前写 | 恢复期间 abort 找不到请求，取消变成纯等待 |
| `activateTab` | 先查 `tabs` 再 `ensureGuest`，`closed` 直接拒 | 对已关闭 tab 重建 guest，等于复活用户刚关的标签 |
| `claimTab` | 校验必须早于 `claimTab`，owner 是整体替换 | 失败路径留下半改 owner，tab 两边都不认 |
| `finalizeTabs` | 先收集全部 `unknown` 再落状态 | 部分成功会让调用方以为全部完成 |
| `newTab` 失败分支 | `cancelledOrUnavailable` 必须先算再 `closeTabDurably` | close 把 lifecycle 置 closed 后算不出取消原因 |
| `download` 等待 | `null` 要按 signal 区分取消与超时；超时不回 path | 取消被报成 timeout，调用方重试已取消的命令 |
| `handleDialog` | `try` 只包 `assertCurrentGuest`；`dispatched` 在 CDP 调用前 | assert 失败若进通用错误路径，会丢掉 `sideEffect:none` |
| 截图闸门 | 只有 alive tracker 才占位；旧死 tracker 由新请求取代 | 命令已返回的死槽位让该 tab 秒拒到自己被关闭（INV-23） |
| `raceBackendExecution` | `finish` 内「置 settled → 摘监听 → resolve」顺序固定 | 先摘监听会重复 resolve；先 resolve 会让调用方在监听仍挂着时继续 |

**质量复核（本轮返工，全部发生在落盘后自检）**：

- 删掉 9 行与既有块注释语义重复的新增注释（`screenshot superseded`、`surface lease` 分支、`两条路径过 race`、tracker 登记/identity/删除后刷新）。它们对应的行在既有 3–6 行块注释覆盖范围内，只是超出 `commentAbove` 的 2 行窗口，重复写属于摊薄而非补缺。
- 改掉 3 处事实错误：原文写「失败分支不回 tab」，但 `withMeta` 只要收到 `tab` 参数就会回 `meta.tabId`；download / guest 已销毁 / dialog 三处实际都传了 `tab`，已改为「仍带 tab 返回」。
- 改掉 2 处职责误述：`handleDialog` 的 `try` 只包断言、不包 CDP 发送；`sendGuestCdpCommand` 校验的是 guest 生命周期与按需 re-attach，不校验 scope。
- 其余断言逐条对照实现：`withMeta` 的 `lifecycleOverride`、`activeTabByScope` 回落、`normalizePlaywrightTimeout(…, 120_000)` 上限、`inFlightScreenshots` identity 删除均与代码一致。

**指标**：新增 **177** 行；六件套全 0（`codeTokenDiff=0`、`deletedNonZero=0`、`nonCommentAdded=0`），第七件 0 对，`zc-gate` 首遍 4 行 water（三处多逗号列举、一处 `markDeliverable` 列举），改写后 0。

## 4.20 A2 录制：`executeRecordingAction` / `runRecording` / `installRecordingCursorOverlay`

**片界**：`runRecording`（2874–3009）、`executeRecordingAction`（3055–3234）、`installRecordingCursorOverlay`（3331–3372）。

**单元账**：计划 129 逻辑。实际新增 **70** 行，逻辑区 624 → **687**（+63，37.4%），全文件 694 → 761（29.0%），声明区 70 → 74。计划与实际差 66 个逻辑单元，原因分三类，全部可核：

| 类别 | 单元数 | 为什么不逐条注 |
| --- | ---: | --- |
| `installRecordingCursorOverlay` 的注入脚本 | 25 | 全部位于 `executeJavaScript` 的模板字符串内。加 `//` 会改页面脚本内容，`check-comments-in-strings` 直接判违规，属结构性不可注。函数外层已有 5 行块注释说明「只注入一次、导航后不重注入（D-9-7）」。 |
| `runRecording` 的既有块注释覆盖区 | 约 26 | 2873–2874、2893–2894、2898–2899、2929–2932、2939–2940、2964–2965、2975–2977、2995–2997、3000–3001 九处块注释已逐段说明；再写只是重复，按 A1 的返工口径不补。 |
| `executeRecordingAction` 的对象字面量与参数行 | 约 15 | 已由所在动作分支的相邻注释覆盖，且属声明区判据里的「可写可不写」。 |

**结构性不可注的口径（2026-11-10 定）**：上表第一类 25 个单元不是「没写」，而是按 `DEEP-SPEC` §7.4 新增条款判为**不可注**——注入脚本是发给 guest 执行的源码，注释进去改变的是被执行代码的语法，不是页面显示的文字。该口径与 electron 录制器注入的 7 行同类，已并入 DEEP-SPEC，不再每批重新发现一次；A5 的 `installRecordingCursorOverlay` 25 个单元同样按此扣除，不进任何一批的可注分母。

**判定点**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `runRecording` 默认值 | viewport / fps / maxDurationMs / settleMs 各自独立兜底，不能解构后统一默认 | 统一兜底会让显式传 0 的 fps 被改成 25 |
| `lease` / `timeout` 声明 | 必须在 `try` 外声明 | 在 `try` 内声明，`finally` 看不到，surface 泄漏且定时器不清理 |
| `coordinator` 缺失 | 显式抛错，不降级 | 降级会录出空帧，且调用方以为成功 |
| `lease.webContentsId` | 必须等于当前 guest | prepare 期间重绑会让录制拍到另一个页面 |
| `invalidated` | prepare 后立刻读，reason 非空即中止 | 继续录只会得到黑帧 |
| `generation` / `detaching` | 引用、代际、detaching 三者都要判 | 只比引用会放行正在拆的会话 |
| `installRecordingCursorOverlay` | 只在开始时注入一次，导航后不重注入（D-9-7） | 后续导航的画面没有光标，观众看不出操作位置 |
| `executeRecordingAction` 的 locator 分流 | 有 selector 走 Playwright，无 selector 的 click 才落坐标；type/waitFor 无 selector 直接报错 | 空 selector 传给 Playwright，或同一动作执行两次 |
| `doubleClick` | 映射成 `dblclick`，不是两次 click | 两次 click 落在双击检测窗口外，页面只收到两次单击 |
| `hover` 坐标 | selector 先算元素中心；`typeof` 判 0，不用真值 | `(0,0)` 是合法坐标，真值判断会退化成 move |
| `scrollTo` | 读当前滚动位置后传差值 | 传绝对值会滚到错误位置 |
| `drag` | 原始 CDP 按下—移动—抬起，`buttons:1` 贯穿移动段 | 缺 `buttons:1` 页面认为鼠标已松开，drop 不触发 |

**返工**：删 1 行与 2893–2894 既有块注释重复的 `assertViewportOverride` 说明；`zc-gate` 首遍 6 行 water（默认值、fill、timeout、scroll、拖拽间隔的列举式），改写后 0；另把 `sendGuestCdpCommand` 与 `handleDialog` 的职责误述归在 A1 批次，未重复计入。

**指标**：新增 **70** 行；六件套全 0，第七件 0 对，`waterLines=0`。

## 4.21 A3 attach 与恢复：`attachGuest` / `runRestoreSuspendedGuest` / `restoreGuestState` / `setupActivityTracking`

**片界**：`attachGuest`（847–1208，logic=63）、`runRestoreSuspendedGuest`（4999–5109，logic=24）、`restoreGuestState`（5114–5178，logic=23）、`setupActivityTracking`（5301–5345，logic=32）。

**单元账**：计划 142 逻辑。实际新增 **141** 行，逻辑区 687 → **826**（+139，45.0%），全文件 761 → 901（34.3%），声明区 74 → 75。差 3 个单元是注释落在已覆盖单元或声明单元上的重叠，不另补。

**为什么这批能接近 1:1**：A2 的差额来自 25 个注入脚本单元；A3 四个块没有模板字符串内代码，参数行与返回信封虽有既有块注释，但每行仍能写出**不同角度**的事实（顺序约束、失败后果、身份比对），因此按 A1 的口径逐行落注释，不重复块注释原句。

**判定点**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `attachGuest` 的 `fromId` | 只按进程内 id 取对象、不校验归属（D-16-1 起点） | 会误以为拿到 guest 就已授权，后续 scope 比对被省略 |
| `recoveryRequested` 的生效条件 | 只有 tab 未关闭才请求重绑 | 对 closed tab 重绑会重建出已删除的页面 |
| 新建 tab 的 `registerTabResidency` | 入表后同段登记与 `tabs.set` 之间不能有让出 | 中间让出会让预算看到一个无可见性的 tab |
| 二次 `closed` 检查 | 覆盖「创建分支刚插入、close 同时在途」 | 终态被 attach 改回 active（INV-15） |
| `remoteSessionId` 比对 | 空串也参与比较 | 缺省值 fail-open，远程重连的旧 tab 被新 runtime attach |
| 挂起拒绝 / 代际拒绝 | 两条分支都必须 `closeGuestWebContents` | 只 return 会让 incoming WebContents 无主驻留 |
| `shouldRestoreAfterRebind` | 「曾挂载 + 非挂起拒绝 + 有可恢复 URL」三者同时成立 | 首次 attach 重放会多一次 about:blank 闪烁 |
| `debugger.attach` 回读 | 以 `isAttached()` 为准，异常走 `safeBool` | 假定 attach 成功会让 `cdpAttached` 与 native 状态分叉 |
| `guestGeneration` 递增 | 只对换代 +1 | 同一 guest 重复 dom-ready 也 +1 会把在途命令全判 stale（INV-02） |
| `active=true` 分支 | claimable tab 不经过 `selectTab`，必须显式置 active | 列表里没有任何 active 项；自然尺寸也无人恢复（INV-22） |
| `active=false` 分支 | 必须同时报 `selected/visible=false` | 预算仍按可见计，该 tab 永远不被挂起 |
| 恢复 flight 的清除 | 按 promise identity 删除，成功失败都摘 | 留下的条目让 `summary` 永远忽略该 tab 的 URL/title（INV-18） |
| `runRestoreSuspendedGuest` 的 `before` | 必须在 `markRestoring` 之前取 | 之后再取，`before.residency` 已不是进入态 |
| `failRestore` 的两处调用 | 超时与导航失败都推进 generation | 不推进的话迟到旧 guest 还能占住 tab（INV-20） |
| 孤儿关闭顺序 | 先删恢复仓库 → 通知 renderer → `closeTab` | 顺序反了会让 shell 留在磁盘上，下次启动再恢复出同一条孤儿 |
| `restoreGuestState` 的 `ERR_ABORTED` | 以实际 `navigationHistory` 为准判是否已生效 | 误判失败会删掉有效快照并发起第二次导航 |
| `entries` 为空的快照 | 等同于没有快照 | `navigationHistory.restore` 传空历史会清掉当前页 |
| `setupActivityTracking` 的身份守卫 | 五个回调都闭包捕获 guest 并比对 `tab.guest` | 旧 guest 的迟到事件改写新 tab 的 loading/media |
| `onLoadingStopped` 的回写闸门 | 恢复 flight 在飞时不写 URL/title | 临时页面覆盖 logical cache（INV-18） |
| `activityCleanup` | 逐个按函数引用解绑 | `removeAllListeners` 会连带摘掉别的模块的监听 |

**返工**：`zc-gate` 首遍 1 行 water（`fromId` 那行用了「、+，」两个分隔符且无谓词），改写为带「所以」的单句后归零。没有与既有块注释重复而删除的行。

**指标**：新增 **141** 行；六件套全 0，第七件 0 对，`waterLines=0`；`zc-verify added=1721`。

## 4.22 A4 截图与销毁：8 个块

**片界**：`constructor`（20）、`ensureGuest`（21）、`setupDownloadTracking`（19）、`executeScreenshotWithPreparedSurface`（31）、`settleScreenshotCapture`（25）、`runGuestTeardown`（24）、`detachGuest`（24）、`disposeAll`（22），计划 186 逻辑单元。

**单元账**：新增 **186** 行，逻辑区 826 → **1010**（+184，55.0%），全文件 901 → 1085（41.3%），声明区 75 未变。差 2 个单元是注释落在已覆盖单元上的重叠。

**判定点**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| constructor 回调参数 | `onCloseTabRequested` 只通知，真正的关闭由上层发起 | 回调里删 registry，伪造 tabId 就能关别人的标签 |
| `onViewportChanged` | `null` 是清除 override 的哨兵，不是 0×0 | 把 null 当零尺寸下发，页面钉死在 0 宽 |
| `onEvict` 绑定 | 直接绑 `closeTabForLimit` | 匿名包装会让淘汰绕过 durable 关闭，留下可恢复 shell |
| `ensureGuest` 的单飞 | 复用 `guestAttachFlights` 里已有 promise | 并发命令各建一个，renderer 收到多次 openTab（INV-06） |
| 清理函数 | 成功失败都挂同一个 `clearFlight`，并按 identity 比较 | 迟到的旧 flight 清掉新一轮登记 |
| `setupDownloadTracking` | `will-download` 只在 session 层触发，回调内必须比对 contents | 别的 tab 的下载被记到本 tab 并唤醒错误的 waiter |
| 下载队列 | 无 waiter 时按 tab 入队；有 waiter 时直接 `finishDownloadWaiter` | 早到的下载丢失；等待方拿到错误的 id |
| 截图 surface 闸门 | 四种失效条件合并为一条 error，`lease.invalidated` 保留细分原因 | 失效 surface 继续 capture，返回黑帧 |
| 像素归一化 | 只在 `surfaceScale<0.999` 或 zoom>1 时构造；空 PNG 返回 undefined | 返回非 CSS 像素或 0 字节，模型按错误的尺寸推理 |
| `settled` 与 `finish` | `settled` 先置位，`finish` 返回是否由本次触发 | abort 与 execution 同时到达会重复记账、重复 resolve |
| `deadline` | 只在隐藏窗口路径设置，超时记 `timeout` 后 abandon | 悬空 capture 拖死 viewport mutation 队列 |
| `runGuestTeardown` | 先置 `detaching` 再取消请求；超时只 warn 不判负 | 顺序反了会让 attach 复用正在拆的 guest；判负会让 closeTab 永久挂起 |
| 二次 `isAttached` | detach 后再查一次，仍 attached 必须判负 | 卸载 DOM 走隐式析构，触发 INV-04 的 UAF |
| 失败回滚 | 只在 guest 未销毁时把 lifecycle 回滚到 attached | 给销毁中的对象写 attached 会掩盖真实终态 |
| `detachGuest` 的 URL 回写 | 无在飞恢复才写 `cachedUrl`/`cachedTitle` | 恢复期替身页把 about:blank 写进逻辑缓存（INV-18） |
| `detachGuest` 的清理顺序 | 先停 idle timer，再清 guest 字段 | timer 回调在 guest 置空后触发 |
| `disposeAll` 的索引清理 | `activeTabByScope`/`defaultTabByScope`/`naturalViewportByWindow` 一并清 | 悬空 key 让 dispose 后的 report 重建 scope 状态 |
| `disposeAll` 的 waiter | `suspendAckWaiters` 逐个 resolve 再 clear | renderer 永远挂在 await 上（INV-34） |
| `disposeAll` 的 flight | 四个 flight 只断引用不结算 | 迟到调用复用已失效的单飞 promise |

**返工**：`zc-gate` 首遍 12 行 water（L 类 8 行、W 类 4 行），逐条改写后归零。另修正 1 处插入位置：`detachGuest` 的日志注释被插进模板字符串的 `${}` 表达式内，已移到 `this.log?.(` 之上。没有与既有块注释重复而删除的行。

**指标**：新增 **186** 行；六件套全 0，第七件 0 对，`waterLines=0`；`zc-verify added=1907`。

**A 轮收口**：四批合计新增 177 + 70 + 141 + 186 = **574** 行，逻辑区 450 → **1010 / 1835 = 55.0%**，未到 60%。差额来自 A2 的 66 个结构性/既有注释不可注单元（25 个在注入脚本字符串内）；剩余 825 个逻辑单元分布在 `executeRecordingAction`（30）、`installRecordingCursorOverlay`（25，结构性不可注）、`executeInScope`（19）等中长尾块。A5 已按这些候选块施工，实测见 §4.23。

## 4.23 A5 中长尾补足：6 个块

**片界**：`executeRecordingAction`（30）、`executeInScope`（19）、`closeTab`（17）、`runGuestCdpSessionRestore`（17）、`moveRecordingPointer`（16）、`detachGuestBeforeReplacement`（16），合计 115 逻辑单元——与 A5 开工前列出的候选清单一致，未临时扩块。

**单元账**：新增 **115** 行，115 个候选单元全部落位（**1:1**），逻辑区 1010 → **1125 / 1835 = 61.3%**，全文件 1085 → 1200（45.7%），声明区 75 未变。A5 开工前剩余 825 逻辑单元，本批只按用户批准的 6 块施工，未追 60.4% 这个自上而下的估数。

**判定点**：

| 位置 | 写的是什么 | 写错会怎样 |
| --- | --- | --- |
| `executeRecordingAction` 的 locator 构造 | click/type/waitFor 三种 `operation` 各自固定（click 或 dblclick、fill、waitFor） | 共用同一 operation 会把 type 发成 click，页面收到空输入 |
| `locatorAction` 优先级 | 有 locator 就不再落坐标分支 | 同一动作执行两次 |
| 取消与超时的异常类型 | timeout 抛普通 `Error`，取消抛 `abortError` | 终态落错档，用户主动取消被记成失败 |
| `pointer` 更新点 | 坐标 click 与 drag 终点都要同步 x/y | 后续 hover 从旧原点起算，轨迹斜跳 |
| `moveRecordingPointer` 的 steps | 钳在 1..60，按 `durationMs` 均分 | 长 duration 逐帧展开会发上千条 CDP，压住宿主 |
| 帧循环的取消点 | 每帧与每段等待前都判 `signal.aborted` | 取消后指针仍在页面上继续移动 |
| `executeInScope` 的超时判定 | `signal.reason` 是 `DOMException` 且 name 为 `TimeoutError` | 普通取消被记成超时 |
| `pendingDialogs` 清理 | 只有 `result.ok` 才 delete | 失败时对话框再也关不掉（INV-28） |
| 截图 tracker 的 identity | 删除前比对当前 tracker 是否仍是自己 | 迟到的 settle 删掉新截图的 tracker |
| `closeTab` 的置位顺序 | 先置 `closed`、再清资源、最后删 `tabs` | 重复关闭时二次执行 detach |
| 下载 waiter 结算 | `while` 重读队首，传 null | 用索引递增会漏掉被清空的条目 |
| `runGuestCdpSessionRestore` 的重放 | `Page.enable` 先行，viewport 走 `enqueueViewportMutation` | 已在临界区再入队会等自己而死锁 |
| `detachGuestBeforeReplacement` 的双校验 | `windowId` + `guest.id`，任一不符回 false | 迟到的旧代请求会拆掉刚接管的新 guest |

**返工**：`zc-gate` 首遍 3 行 water（`:3275`、`:3563`、`:4979`，均为 L 类列举缺谓词），逐条改写后归零；其余 112 行首遍通过。

**指标**：新增 **115** 行；六件套全 0，第七件 0 对，`waterLines=0`；`zc-verify added=2022`。

## 5. 六件套（片 1–14 + A1–A5）

```text
1 code-token     SUMMARY files=1 codeTokenDiff=0
2 in-strings     SUMMARY files=1 scanned=1 stringRanges=880 violations=0 addedViolations=0
3 upstream       SUMMARY files=1 checked=1 upstreamComments=3451 missing=0
4 zc-verify      SUMMARY files=1 rewrittenSegments=0 deletedOwnCommentLines=0 codeTokenDiff=0
                 headTokenDrift=0 stringContentDrift=0 codeDeletion=0
                 upstreamCommentDeleted=0 literalCommentDeletion=0 nonCommentAdded=0
                 starSlash=0 syntaxErrorFiles=0 added=2022
5 eol            SUMMARY files=1 scanned=1 bareLF=0 remaining=0 filesWithBareLF=0
6 string-drift   SUMMARY files=1 stringDriftFiles=0 parseFailed=0
7 comment-dups   SUMMARY files=1 pairs=0 hitLines=0 verbatim=0 prefix=0 paraphrase=0
```

`zc-gate --scan` 复核：`files=1 badFiles=0 addedCommentLines=115 waterLines=0 waterRate=0.00%`（A5 增量 115；A1 177、A2 70、A3 141、A4 186，累计 1881）。片 1–5 已提交，HEAD 前移后该值为片 6~14 相对新 HEAD 的累计（片 6 增量 13、片 7 增量 34、片 8 增量 59、片 9 增量 36、片 10 增量 17、片 11 增量 20、片 12 增量 22、片 13 增量 20、片 14 增量 39）；提交前相对旧 HEAD 的累计新增为 1073。片 3 第一遍出现 3 行 water（都是多逗号列举缺谓词）、片 4 出现 1 行（`[可达性]` 句为列举式）、片 5 出现 2 行（短句无标识符）、片 6 出现 2 行（`screenshotCommand`/tracker 两处列举式）、片 7 出现 4 行（D-9-6 指路句与 surface 失效句为列举式）、片 8 出现 10 行（状态双轨 / try 起点 / 指针初值 / timeout 预算等列举式）、片 9 出现 2 行（`selectTab` 信任边界句、`releaseToUser` 指路句）、片 10 出现 1 行（D-9-11 指路短句）、片 11 与片 12 首遍即 0、片 13 出现 2 行（viewport 落盘列举句、D-9-1 指路尾句）、片 14 出现 2 行（负数坐标句、`safeBool` fallback 句），改写成带「不会 / 必须 / 否则 / 因此」的句子后归零，未删任何既有注释。

## 6. 口径记录

- 「缺口 = 没写」的前置检验方法：对每个未覆盖单元向上走 0–2 个空行找注释（与 `deep-quality.mjs` 的 `commentAbove` 完全同口径），命中即判「写了没贴住」。本文件命中 0。
- 片 2 补充了更宽的 8 行窗口统计：109 个缺口里 81 个有近邻块注释，说明块级说明的「摊薄」会系统性低估已完成的工作；两个数要一起看。
- 声明区按六条判据筛选：必须写 17 / 可写可不写 15 / 纯名字复述 94；不是整类豁免。
- 片 2 新增缺陷 `D-16-1`；`D-9-1` / `D-9-2` / `D-9-3` 位置不变；片 5 新增 `D-9-5`（有意降级 INV-05，低 / B 档）；片 6 新增 `D-9-6`（已放弃的 CDP capture 不计入 `captureActive`，低 / B 档），片 7 在代码读写点补 D-9-6 指路；片 8 新增 `D-9-7`（光标 overlay 注入失败即中止录制、导航后不重注入）、`D-9-8`（`abortRecordings` 上方两条取消理由均不成立），并给 `D-9-2` 增补 `resolveRecordingSelectorScrollTarget` 落点。
- 片 8 另有两处「按门槛不立条」：`setRecordingTerminal` 的幂等守卫其实在调用方（当前无实际竞态），`onCaptureComplete` 之后编码阶段无超时兜底（有意的取舍）。两处都在代码注释里写明「为什么」，不占缺陷编号。
- 片 9 新增 `D-9-9`（legacy 复用 `sessionId` 作 tabId，关闭后重建被自己的墓碑永久拒绝 attach）、`D-9-10`（`releaseToUser` 注释称清后台 viewport，实现只改归属，复位依赖 INV-22 的惰性自愈）；`openUserTabs` 的「按 openedAt 排序」实际只按 active 分组、靠稳定排序维持插入序，属可观测性差异，已在注释里写明，不占编号。
- 片 10 新增 `D-9-11`（`closeSessionTabs` 注释称 `allSettled`，实现逐条 await，一条失败即中断）、`D-9-12`（`closeWindow` 只清 `naturalViewportByWindow`，漏清 active/default 索引与 `sessionNames`/`visibilityByScope`）。
- 片 12 无新缺陷；`rollbackGuestCdpRestore` 的「不能 detach 整个 CDP」与实现的无条件 detach 字面不一致，按门槛不立条：触发需「已 attach 的入口复用本函数」（当前不存在）、后果仅该次会话被重建、无状态损坏，理由已写进代码注释。
- 片 13 无新缺陷；在 `hasRunningRequestForTab` 补上 D-9-1 的代码内指路（原注释称过滤 dispatched/aborted，实现只按 tabId），缺陷编号与册子条目一致，不另立新条。
- 片 14 新增 `D-9-13`（`collectMemoryDiagnostics` 注释称统计 tab/guest/waiter/recording 四类数量，实现只回 `tabs`/`closedTabIds`，三类泄漏在诊断采样里不可见，C 档 / 低）；`raceBackendExecution` 拒绝分支省略 `sideEffect` 属防御路径（`executeBrowserCommandOnView` 按 INV-02 永不 reject），按门槛不立条，理由写进代码注释。
- **缺陷必须在代码侧指路**：册子里有记录、代码里没有指向，等于只有注释线知道。片 7 起，凡登记缺陷，都要在对应读/写/缺口处各留一句「见 D-xx」；意图句不回写现状，保留为水位。
- 未立条的判定要留下「为什么不立」：`readTabViewport` 的 TOCTOU 按「不收录纯竞态」处理，理由（触发需精确并发、后果仅该次截图失败、无状态损坏）已写进 `:2262-2264` 注释，下一个人不必重新推一遍。
- A1 无新缺陷。三处与实现不符的新增注释（「失败分支不回 tab」×3）是注释线自己写错、不是代码缺陷，已按实现改写，不占编号。
- A2 无新缺陷。`installRecordingCursorOverlay` 的 25 个注入脚本单元是**结构性不可注**：注释会被 `check-comments-in-strings` 判为字符串内容变更，与其硬写不如在批次文档里记明，这也是逻辑区 60% 目标里必须扣除的一块。
- 后续批次（A3/A4）继续按「一批一提交、独立门禁」；两边引用缺陷一律按 **ID** 寻址（如 `D-16-1`），位置号会随新增条目重排——转达时为第 69 位、落表后为第 73 位，以 ID 为准。
- A5 无新缺陷。`installRecordingCursorOverlay` 的 25 个注入脚本单元按 §4.20 新口径排除，不计入可注分母；A5 的 6 个块无模板字符串内代码，因此 115 个候选单元 1:1 落位。

## 7. A 轮（unit-driven）：块级清单与进度

**达标线**：逻辑区 60%（ZCode 线统一口径，不是本文件特例）。声明区 724 个未覆盖单元按片 1–2 的六条判据处理，不追覆盖率。

| 批次 | 函数块 | 剩余逻辑 | 预计行数 | 状态 |
| --- | --- | ---: | ---: | --- |
| A1 | `executeInScope` / `execute` / `raceBackendExecution` | 201 | ~600 | **完成**：177 行，逻辑区 34.0% |
| A2 | `executeRecordingAction` / `runRecording` / `installRecordingCursorOverlay` | 129 | ~390 | **完成**：70 行，逻辑区 37.4%（25 单元在注入脚本字符串内，不可注） |
| A3 | `attachGuest` / `setupActivityTracking` / `runRestoreSuspendedGuest` / `restoreGuestState` | 142 | ~430 | **完成**：141 行，逻辑区 45.0% |
| A4 | 截图 surface / `settleScreenshotCapture` / `runGuestTeardown` / `detachGuest` / `disposeAll` / `ensureGuest` / `constructor` / `setupDownloadTracking` | 187 | ~560 | **完成**：186 行，逻辑区 55.0% |
| A5 | `executeRecordingAction` / `executeInScope` / `closeTab` / `runGuestCdpSessionRestore` / `moveRecordingPointer` / `detachGuestBeforeReplacement` | 115 | ~300 | **完成**：115 行，逻辑区 61.3% |

四批合计 659 逻辑单元是**计划上限**，不是可达值：A2 实测 129 里有 66 个不可注（25 个在注入脚本字符串内、约 26 个由既有块注释覆盖、约 15 个声明区）；A3 实测 142 里落了 139 个；A4 实测 186 里落了 184 个。A1–A4 结束逻辑区 55.0%；A5 按批准清单落 115 个单元后到 **61.3%**，补 `:4018` / `:4015` 后 **61.4%**。剩余逻辑单元不再按块盲推，改为两轮分层抽样判定（§8、§9），最终按 61.4% 定格。

## 8. 分层抽样：剩余逻辑单元的收尾判定（2026-11-10）

**抽样框**：A5 落盘后按 `_blocks2.mjs` 的「类成员块 + 未覆盖逻辑单元」口径，剩余 **624** 个逻辑单元；另有 802 个声明区/结构单元，按片 1 的六条判据不追覆盖。`_region-split` 的算术剩余是 710，与 624 的差额 86 个全是**对象字面量属性**：`_blocks2` 判声明区，`_region-split` 计入逻辑区。两者分工与权威指定见 §8.1。

**配比**：108 个类成员块按剩余单元数比例分配 60 条，最大余数法补齐，块内等距取点（脚本 `_sample.mjs`，样本明细 `sample60.json`）。前 8 个块：

| 块 | 剩余逻辑单元 | 分到样本 |
| --- | ---: | ---: |
| `installRecordingCursorOverlay` | 25 | 2 |
| `releaseGuestCdpAfterIdle` | 15 | 2 |
| `waitForDownload` | 15 | 2 |
| `setRecordingTerminal` | 14 | 1 |
| `resolveTab` | 14 | 1 |
| `applyBackgroundViewportFallback` | 14 | 1 |
| `restoreNaturalViewportAfterBackground` | 14 | 1 |
| `readTabViewport` | 13 | 1 |
| 其余 100 个块 | 500 | 49 |

**判定标准**：这行改错或删掉，运行时会不会没人发现。会 → 真缺口；不会 → 已覆盖（12 行内块注释点名了该行标识符或所在分支的不变式）；不具备可注位置（注入脚本字符串内、参数/签名行）→ 结构行，不计入可注分母。

**60 条判定表**：

| # | 行 | 块 | 该行代码 | 最近注释 | 判定 |
| ---: | --- | --- | --- | --- | --- |
| 1 | `:702` | `listGuestWebContentsIds` | `const id = safeNumber(() => tab.guest?.id);` | 距 5 行 | 已覆盖 |
| 2 | `:1310` | `updateViewportFromRenderer` | `throw new Error(`browser tab '${tabId}' is unavailab` | 距 3 行 | 已覆盖 |
| 3 | `:1382` | `reportResidency` | `if (!tab.claimable) this.selectTab(tab, false);` | 距 2 行 | 已覆盖 |
| 4 | `:1498` | `restoreTabs` | `this.restoredTabClaims.set(record.tabId, payload.win` | 距 3 行 | 已覆盖 |
| 5 | `:2727` | `startHiddenWindowCapturePresentation` | `if (!win) return undefined;` | 距 3 行 | 已覆盖 |
| 6 | `:2968` | `setRecordingPhase` | `entry.phase = phase;` | 距 6 行 | 已覆盖 |
| 7 | `:2989` | `setRecordingTerminal` | `if (error) entry.error = error;` | 距 10 行 | 已覆盖 |
| 8 | `:3020` | `abortRecordings` | `if (entry.status !== "running" \|\| !predicate(entry` | 距 6 行 | 已覆盖 |
| 9 | `:3097` | `runRecording` | `entry.controller.abort(` | 距 2 行 | 已覆盖 |
| 10 | `:3205` | `restoreRecordingViewport` | `await this.setTabViewport(tab, previous);` | 距 7 行 | 已覆盖 |
| 11 | `:3224` | `executeRecordingActions` | `for (const action of actions) {` | 距 8 行 | 已覆盖 |
| 12 | `:3497` | `executeRecordingBrowserCommand` | `const result = await executeBrowserCommandOnView(vie` | 距 5 行 | 已覆盖 |
| 13 | `:3511` | `resolveRecordingSelectorPoint` | `const result = await executeIabPlaywrightLocator(` | 距 6 行 | 已覆盖 |
| 14 | `:3539` | `resolveRecordingSelectorScrollTarget` | `const result = await executeIabPlaywrightLocator(` | 距 6 行 | 已覆盖 |
| 15 | `:3616` | `installRecordingCursorOverlay` | `document.documentElement.appendChild(cursor);` | 距 8 行 | 结构行 |
| 16 | `:3631` | `installRecordingCursorOverlay` | `window.addEventListener("mouseup", up, true);` | 12 行内无注释 | 结构行 |
| 17 | `:3662` | `animateRecordingScroll` | `const steps = Math.max(1, Math.min(60, Math.round(du` | 距 8 行 | 已覆盖 |
| 18 | `:3701` | `resolveTab` | `const active = activeId ? this.tabs.get(activeId) : ` | 距 2 行 | 已覆盖 |
| 19 | `:3736` | `createTab` | `return existing;` | 距 9 行 | 已覆盖 |
| 20 | `:3860` | `waitForGuestRecovery` | `const flight = this.guestRecoveryFlights.get(tab.tab` | 距 6 行 | 已覆盖 |
| 21 | `:3887` | `runGuestAttachFlight` | `if (guest && !safeBool(() => guest.isDestroyed(), tr` | 距 6 行 | 已覆盖 |
| 22 | `:3952` | `claimTab` | `tab.claimable = false;` | 距 4 行 | 已覆盖 |
| 23 | `:3985` | `selectTab` | `if (!notifyRenderer) return;` | 距 2 行 | 已覆盖 |
| 24 | `:4018` | `releaseToUser` | `if (this.defaultTabByScope.get(claimedScope) === tab` | 距 10 行 | **真缺口** |
| 25 | `:4041` | `finalizeTabs` | `if (status === "handoff") tab.lifecycle = status;` | 距 4 行 | 已覆盖 |
| 26 | `:4066` | `effectiveActiveTabId` | `if (activeTab && activeTab.lifecycle !== "closed") r` | 距 5 行 | 已覆盖 |
| 27 | `:4119` | `readTabViewport` | `const value = await tab.guest.executeJavaScript(` | 距 9 行 | 已覆盖 |
| 28 | `:4170` | `withMeta` | `? sanitizeBrowserMetaUrl(` | 距 2 行 | 已覆盖 |
| 29 | `:4198` | `cancelledOrUnavailable` | `tab: ManagedTab,` | 距 5 行 | 结构行 |
| 30 | `:4299` | `endTurn` | `if (!sameScope(tab.owner, context)) continue;` | 距 2 行 | 已覆盖 |
| 31 | `:4323` | `releaseGuestCdpAfterIdle` | `if (!settled) {` | 距 2 行 | 已覆盖 |
| 32 | `:4341` | `releaseGuestCdpAfterIdle` | `guest.debugger.detach();` | 距 10 行 | 已覆盖 |
| 33 | `:4384` | `closeSession` | `request.controller.abort(new DOMException("session c` | 距 5 行 | 已覆盖 |
| 34 | `:4447` | `closeWindow` | `this.detachAndCloseGuest(tab);` | 距 10 行 | 已覆盖 |
| 35 | `:4590` | `setupCdpCrashGuard` | `guest.debugger.detach();` | 距 3 行 | 已覆盖 |
| 36 | `:4636` | `setupDialogTracking` | `const dialog: BrowserDialog = {` | 距 7 行 | 已覆盖 |
| 37 | `:4676` | `setTabViewport` | `const guest = tab.guest;` | 距 4 行 | 已覆盖 |
| 38 | `:4695` | `resetTabViewport` | `const guest = tab.guest;` | 距 6 行 | 已覆盖 |
| 39 | `:4718` | `applyBackgroundViewportFallback` | `await this.enqueueViewportMutation(tab, async () => ` | 距 2 行 | 已覆盖 |
| 40 | `:4777` | `restoreNaturalViewportAfterBackground` | `const value = await guest.executeJavaScript(` | 距 11 行 | 已覆盖 |
| 41 | `:4819` | `enqueueViewportMutation` | `tab.viewportMutation = current;` | 距 8 行 | 已覆盖 |
| 42 | `:4901` | `waitForDownload` | `const queued = this.queuedDownloads.get(tabId);` | 距 6 行 | 已覆盖 |
| 43 | `:4912` | `waitForDownload` | `waiter.onAbort = () => this.finishDownloadWaiter(tab` | 距 9 行 | 已覆盖 |
| 44 | `:4929` | `finishDownloadWaiter` | `waiter.signal.removeEventListener("abort", waiter.on` | 距 7 行 | 已覆盖 |
| 45 | `:4965` | `ensureGuestCdpAttached` | `if (tab.guestCdpRestoreFlight === flight) tab.guestC` | 距 4 行 | 已覆盖 |
| 46 | `:5074` | `sendGuestCdpCommandRaw` | `const result = await guest.debugger.sendCommand(meth` | 距 10 行 | 已覆盖 |
| 47 | `:5104` | `sendGuestCdpCommand` | `assertCurrentGuest?: () => void,` | 距 7 行 | 结构行 |
| 48 | `:5128` | `toControlledView` | `sendCdpCommand: ControlledView["cdp"]["send"],` | 距 6 行 | 结构行 |
| 49 | `:5199` | `registerTabResidency` | `? "live-visible"` | 距 5 行 | 已覆盖 |
| 50 | `:5241` | `closeTabForLimit` | `return true;` | 距 5 行 | 已覆盖 |
| 51 | `:5256` | `restoreSuspendedGuest` | `let flight = this.restoreFlights.get(tab.tabId);` | 距 6 行 | 已覆盖 |
| 52 | `:5515` | `restoreReboundGuest` | `if (lifecycleAfterRestore !== "closed" && tab.guest ` | 距 3 行 | 已覆盖 |
| 53 | `:5535` | `persistRecoverySnapshot` | `const entries = guest.navigationHistory.getAllEntrie` | 距 6 行 | 已覆盖 |
| 54 | `:5559` | `persistShell` | `const residency = this.residencyCoordinator.get(tab.` | 距 4 行 | 已覆盖 |
| 55 | `:5598` | `requireRendererOwnedTab` | `payload:` | 12 行内无注释 | 结构行 |
| 56 | `:5788` | `requestGuestRebind` | `this.log?.(`[browser-use] request guest rebind tabId` | 距 3 行 | 已覆盖 |
| 57 | `:5919` | `beginGuestTeardown` | `if (existing) return existing;` | 距 7 行 | 已覆盖 |
| 58 | `:6327` | `waitForGuest` | `this.removeWaiter(tabId, waiter);` | 距 15 行（回读确认） | 已覆盖 |
| 59 | `:6344` | `removeWaiter` | `if (!list) return;` | 距 5 行 | 已覆盖 |
| 60 | `:6370` | `resolveWaiters` | `clearTimeout(waiter.timer);` | 距 3 行 | 已覆盖 |

**结果**：真缺口 **1 / 60 = 1.7%**（≤5%），已覆盖 53，结构行 6。

- 唯一真缺口 `:4018`（`releaseToUser` 删 `defaultTabByScope`）：该函数的块注释只说明「改归属、不清 viewport」，没有点名两个索引删除；`:4015` 删 `activeTabByScope` 是同型、未进样本。删掉后默认索引指向已释放的 tab，读路径由 `effectiveActiveTabId` 兜底，因此运行时不易发现。
- 结构行 6 条：`:3616`、`:3631` 在 `installRecordingCursorOverlay` 的注入脚本字符串内（与 A2 的 25 个同列，按 §4.20 口径不可注）；`:4198`、`:5104`、`:5128`、`:5598` 是参数/签名行。

**结论（第一轮，不是最终定格）**：剩余 624 个逻辑单元的真缺口率点估计 1.7%，低于 5%。第一轮只能支撑「继续抽一轮」：1/60 的 95% 上界约 7.9%（对 624 个单元约合 49 例），区间过宽。补完 `:4018` / `:4015` 并完成第二轮后的最终定格见 §9。

### 8.1 分母口径（2026-11-10 指定权威）

两套数并存，必须分工，不能混用：

- **权威分母：`_region-split` 的 708（补注释前 710）**。覆盖率 **61.4% 与后续任何「逻辑区 X%」都以它为准**；口径由 TS AST 决定，import / interface 字段 / 类型别名 / 对象字面量属性之外算逻辑区。
- **抽样口径：`_blocks2` 的 622**。它按类成员块聚合逐行单元，并把 **86 个对象字面量属性**（`isPropertyAssignment`）判为声明区；这 86 个按片 1 的六条判据属「可写可不写」，**不进可注分母、不进缺口率分子**。
- 换算：708 = 622 + 86。**覆盖率只能除以 1835（region-split 逻辑区总数），缺口率只能除以 622（blocks2 可注单元）**；同时引用时必须写明「708 合计、其中 622 可注、86 按规范豁免」。禁止拿 708 当缺口率分母，也禁止拿 622 报覆盖率。
- 86 个的构成：全部是对象字面量属性行，典型是各类 return 信封（`ok/error` 形状）与 `DownloadRecord` 之类字段初始化；改错通常会被类型检查或紧邻的块注释拦住，因此按判据豁免。

## 9. 第二轮抽样与定格（2026-11-10）

**前置修复**：第一轮唯一真缺口 `:4015` / `:4018` 已补注释（`cce264eb`，新增 2 行），逻辑区 1125 → **1127 / 1835 = 61.4%**；六件套全 0、第七件 0 对、`waterLines=0`、`added=2024`。

**第二轮抽样框**：补注释后剩余 **622** 个可注逻辑单元；剔除第一轮已抽的 59 条（`:4018` 已覆盖退出），按块规模重算配比，块内等距取 60 条。前 8 个块：

| 块 | 剩余逻辑单元 | 分到样本 |
| --- | ---: | ---: |
| `installRecordingCursorOverlay` | 23 | 3 |
| `setRecordingTerminal` | 13 | 1 |
| `resolveTab` | 13 | 1 |
| `releaseGuestCdpAfterIdle` | 13 | 1 |
| `applyBackgroundViewportFallback` | 13 | 1 |
| `restoreNaturalViewportAfterBackground` | 13 | 1 |
| `waitForDownload` | 13 | 1 |
| `readTabViewport` | 12 | 1 |
| 其余 100 个块 | 450 | 50 |

**判定标准**不变：删掉或改错，运行时会不会没人发现。会 → 真缺口；不会 → 已覆盖（12 行内块注释点名了该行标识符或所在分支的不变式）；注入脚本字符串内 / 参数签名行 → 结构行，不进可注分母。

**60 条判定表**：

| # | 行 | 块 | 该行代码 | 最近注释 | 判定 |
| ---: | --- | --- | --- | --- | --- |
| 1 | `:701` | `listGuestWebContentsIds` | `if (tab.lifecycle === "closed" \|\| !tab.guest) cont` | 距 4 行 | 已覆盖 |
| 2 | `:1315` | `updateViewportFromRenderer` | `assertViewportOverride(viewport);` | 距 2 行 | 已覆盖 |
| 3 | `:1340` | `getTabOwnerByWebContentsId` | `if (tab.guest?.id === webContentsId && tab.lifecycle` | 距 5 行 | 已覆盖 |
| 4 | `:1387` | `reportResidency` | `tab.active = false;` | 距 3 行 | 已覆盖 |
| 5 | `:1500` | `restoreTabs` | `let tab = this.tabs.get(record.tabId);` | 距 5 行 | 已覆盖 |
| 6 | `:2726` | `startHiddenWindowCapturePresentation` | `const win = this.resolveOwnerWindow(context.windowId` | 距 2 行 | 已覆盖 |
| 7 | `:2926` | `createRecordingEntry` | `const now = this.recordingNow();` | 距 5 行 | 已覆盖 |
| 8 | `:2969` | `setRecordingPhase` | `entry.progress = phase === "capturing" ? 0.1 : 0.9;` | 距 7 行 | 已覆盖 |
| 9 | `:2988` | `setRecordingTerminal` | `entry.updatedAt = this.recordingNow();` | 距 9 行 | 已覆盖 |
| 10 | `:3019` | `abortRecordings` | `for (const entry of this.recordings.values()) {` | 距 5 行 | 已覆盖 |
| 11 | `:3099` | `runRecording` | `? lease.invalidated.reason` | 距 4 行 | 已覆盖 |
| 12 | `:3206` | `restoreRecordingViewport` | `this.onViewportChanged?.(previous, tab.owner, tab.ta` | 距 8 行 | 已覆盖 |
| 13 | `:3225` | `executeRecordingActions` | `if (signal.aborted) throw abortError();` | 距 9 行 | 已覆盖 |
| 14 | `:3498` | `executeRecordingBrowserCommand` | `if (!result.ok)` | 距 6 行 | 已覆盖 |
| 15 | `:3524` | `resolveRecordingSelectorPoint` | `if (result.kind !== "done" \|\| !isBrowserPointValue` | 距 14 行（回读确认） | 已覆盖 |
| 16 | `:3552` | `resolveRecordingSelectorScrollTarget` | `if (result.kind !== "done" \|\| !isBrowserPointValue` | 距 19 行（回读确认） | 已覆盖 |
| 17 | `:3613` | `installRecordingCursorOverlay` | `const cursor = document.createElement("div");` | 距 5 行 | 结构行 |
| 18 | `:3623` | `installRecordingCursorOverlay` | `cursor.style.transform = "translate(-50%,-50%) scale` | 12 行内无注释 | 结构行 |
| 19 | `:3634` | `installRecordingCursorOverlay` | `window.removeEventListener("mousedown", down, true);` | 12 行内无注释 | 结构行 |
| 20 | `:3660` | `animateRecordingScroll` | `signal: AbortSignal,` | 距 6 行 | 结构行 |
| 21 | `:3697` | `resolveTab` | `const key = scopeKey(context);` | 距 7 行 | 已覆盖 |
| 22 | `:3735` | `createTab` | `if (existing && existing.lifecycle !== "closed" && s` | 距 8 行 | 已覆盖 |
| 23 | `:3858` | `waitForGuestRecovery` | `signal: AbortSignal,` | 距 4 行 | 结构行 |
| 24 | `:3886` | `runGuestAttachFlight` | `const guest = await this.waitForGuest(tab.tabId);` | 距 5 行 | 已覆盖 |
| 25 | `:3958` | `claimTab` | `this.log?.(` | 距 2 行 | 已覆盖 |
| 26 | `:3975` | `selectTab` | `candidate.active = candidate.tabId === tab.tabId;` | 距 3 行 | 已覆盖 |
| 27 | `:4021` | `releaseToUser` | `this.defaultTabByScope.delete(claimedScope);` | 距 2 行 | 已覆盖 |
| 28 | `:4042` | `finalizeTabs` | `const status = keep.get(tab.tabId);` | 距 3 行 | 已覆盖 |
| 29 | `:4067` | `effectiveActiveTabId` | `const activeTab = activeId ? this.tabs.get(activeId)` | 距 4 行 | 已覆盖 |
| 30 | `:4087` | `summary` | `return {` | 距 5 行 | 已覆盖 |
| 31 | `:4124` | `readTabViewport` | `if (isBrowserViewportSize(value)) {` | 距 12 行 | 已覆盖 |
| 32 | `:4148` | `userTabInfo` | `tab.cachedTitle = safeStr(() => tab.guest!.getTitle(` | 距 4 行 | 已覆盖 |
| 33 | `:4175` | `withMeta` | `: undefined;` | 距 5 行 | 已覆盖 |
| 34 | `:4202` | `cancelledOrUnavailable` | `if (running.controller.signal.aborted) {` | 距 7 行 | 已覆盖 |
| 35 | `:4229` | `unavailableTabResult` | `startedAt: number,` | 距 4 行 | 结构行 |
| 36 | `:4294` | `endTurn` | `request.controller.abort(new DOMException("turn ende` | 距 14 行（回读确认） | 已覆盖 |
| 37 | `:4337` | `releaseGuestCdpAfterIdle` | `if (safeBool(() => guest.isDestroyed(), true)) retur` | 距 4 行 | 已覆盖 |
| 38 | `:4389` | `closeSession` | `for (const tab of this.tabs.values()) {` | 距 8 行 | 已覆盖 |
| 39 | `:4448` | `closeWindow` | `if (tab.owner.windowId !== windowId) continue;` | 距 9 行 | 已覆盖 |
| 40 | `:4591` | `setupCdpCrashGuard` | `if (!guest.debugger.isAttached()) return;` | 距 2 行 | 已覆盖 |
| 41 | `:4633` | `setupDialogTracking` | `const data = (params ?? {}) as {` | 距 2 行 | 已覆盖 |
| 42 | `:4677` | `setTabViewport` | `if (!tab.guest) return;` | 距 3 行 | 已覆盖 |
| 43 | `:4696` | `resetTabViewport` | `if (!tab.guest) return;` | 距 5 行 | 已覆盖 |
| 44 | `:4716` | `applyBackgroundViewportFallback` | `tab.backgroundViewportFallback = fallback;` | 距 10 行 | 已覆盖 |
| 45 | `:4778` | `restoreNaturalViewportAfterBackground` | `if (tab.backgroundViewportFallback !== fallback \|\|` | 距 10 行 | 已覆盖 |
| 46 | `:4818` | `enqueueViewportMutation` | `tab.insideViewportMutation = false;` | 距 5 行 | 已覆盖 |
| 47 | `:4910` | `waitForDownload` | `const waiter = {} as DownloadWaiter;` | 距 5 行 | 已覆盖 |
| 48 | `:4935` | `finishDownloadWaiter` | `if (waiters) {` | 距 2 行 | 已覆盖 |
| 49 | `:5074` | `sendGuestCdpCommandRaw` | `tab.pendingCdpCommands += 1;` | 距 8 行 | 已覆盖 |
| 50 | `:5108` | `sendGuestCdpCommand` | `assertCurrentGuest?.();` | 距 9 行 | 已覆盖 |
| 51 | `:5129` | `toControlledView` | `assertCurrentGuest: () => void,` | 距 5 行 | 结构行 |
| 52 | `:5202` | `registerTabResidency` | `: "live-background",` | 距 6 行 | 已覆盖 |
| 53 | `:5259` | `restoreSuspendedGuest` | `if (!flight) {` | 距 7 行 | 已覆盖 |
| 54 | `:5518` | `restoreReboundGuest` | `this.warn(`browser tab guest rebind restore failed t` | 距 4 行 | 已覆盖 |
| 55 | `:5538` | `persistRecoverySnapshot` | `if (entries.length === 0) return;` | 距 7 行 | 已覆盖 |
| 56 | `:5605` | `requireRendererOwnedTab` | `const tab = this.tabs.get(payload.tabId);` | 无注释，改错会立刻抛错 | 已覆盖 |
| 57 | `:5922` | `beginGuestTeardown` | `const flight = this.runGuestTeardown(tab, guest, rea` | 距 8 行 | 已覆盖 |
| 58 | `:6328` | `waitForGuest` | `waiter.onAbort = () => {` | 距 15 行（回读确认） | 已覆盖 |
| 59 | `:6345` | `removeWaiter` | `const list = this.waiters.get(tabId);` | 距 4 行 | 已覆盖 |
| 60 | `:6371` | `resolveWaiters` | `for (const waiter of list) {` | 距 2 行 | 已覆盖 |

**第二轮结果**：真缺口 **0 / 60**、已覆盖 53、结构行 7。结构行里 `:3613` / `:3623` / `:3634` 在 `installRecordingCursorOverlay` 的注入脚本字符串内，`:3660` / `:3858` / `:4229` / `:5129` 是参数签名行。

**两轮合计**：120 条分层抽样，真缺口 **1 例（`:4018`，已闭合）**、结构行 13、已覆盖 106；累计率 **1 / 120 = 0.8%**，95% 上界约 **4.3%**。

**停止判定**：预登记规则是「两轮合计 ≤3/120 定格」；实测 1 ≤ 3，因此本文件按 **61.4% 定格**。结论的准确表述是：**120 条分层抽样、累计 1 例（已闭合），上界约 4.3%**——这是「按 120 条样本无法再证出 >3 例真缺口」，不是「文件做完了」。

> 上界口径校正（2026-11-10，DEEP-SPEC v2.2 §5.3）：按单侧 95% Clopper–Pearson 精确法，1/120 的上界为 **3.89%**；正文 4.3% 为早期近似值。阈值（5%）与定格结论不变。
