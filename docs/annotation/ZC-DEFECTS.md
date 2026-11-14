# ZC-DEFECTS：边读边发现的代码缺陷

> 性质：**只记录，不修代码**。本清单由注释线在逐函数阅读时产出，修复需单独评审。
> 收录门槛：必须同时具备「可复现的触发条件」「具体代码路径」「可描述的后果」三者。
> 不收录：风格问题、性能优化建议、单元测试缺失、纯推测的竞态。
> 行号基准：2026-11-09 工作树（P1 / P2 注释批次完成后），代码未改动。

## 总表

> 口径：级别只用「高 / 中 / 低」三档，与 `DEFECTS-MASTER.md` 一致；不再引入其它分档写法（历史正文里的「A/B/C 档」是触发面分类，不替代级别）。
> **完整性提示**：本表长期只覆盖 D-01…D-06、D-9…D-16，缺 D-7-*、D-8-*、D-31（这些只挂在下方统一索引与条目正文）。因此**任何只按本表做的历史核对都可能是假阴性**——查重、计数、跨批寻址都必须以「统一索引 + 条目正文」为准，或以总表为准。
> **寻址口径（2026-11-10）**：本册与 `DEFECTS-MASTER.md` 之间一律按 **ID** 寻址（如 `D-16-1`），不再传位置号。位置号会随新增条目重排——`D-16-1` 转达时为总表第 69 位，落表后实为第 73 位；同理本册行序也会漂。两边引用只写 ID，位置号仅作阅读参考，冲突时以文件当前内容 + ID 为准。

| ID | 级别 | 位置 | 一句话后果 | 状态 |
| --- | --- | --- | --- | --- |
| D-01 | 高 | `feedback/feedbackLocalTicketStore.ts:113-118` | 覆盖写中途被杀，整份票据被读成空集合，永久丢失 | 待定 |
| D-02 | 中 | `session/offPeakTaskRepo.ts:793-794`、`807`、`976-1001` | 崩溃后留下 `queued + claim_running=1`，在 stale 窗口内既不可跑也不可认领 | 待定 |
| D-03 | 高 | `output-style/outputStyleService.ts:91-94`、`177-188` | `settings.json` 损坏时被「修复」成只剩 `outputStyle`，hooks/permissions 永久丢失（仓库内零调用点，但 web-remote 通道无主体校验） | 待定 |
| D-04 | 中 | `packages/desktop/src/scheduler/index.ts:370-377`；`session/automationRepo.ts:1659-1665` | 两段写之间崩溃后同一 `runId` 可被派发两次，先结束一轮的 outcome 被清空 | 待定 |
| D-05 | 中 | `bots/providers/webhookProvider.ts:234-250` | webhook `fetch` 无超时，对端挂起时 Bot 串行队列永久阻塞 | 待定 |
| D-06 | 中 | `bots/providers/weixinProvider.ts:959-966` | 附件下载无超时、无大小上限，整包进内存 | 待定 |
| D-07 | 低 | `project/autoArchiveScheduler.ts:67-86`、`133-139` | `dispose` 后仍在跑的扫描会继续归档并广播；注释声称的复查点不存在 | 待定 |
| D-9-1 | 低 | `desktop/src/main/browserView/browserGuestManager.ts:4764-4769` | `hasRunningRequestForTab` 注释称过滤 dispatched/aborted，实现只按 tabId，取消后仍阻止 detach | 待定 |
| D-9-2 | 低 | `desktop/src/main/browserView/browserGuestManager.ts:2851-2875` | 注释称返回 null 跳过动画，实际 `throw` 中止整段录制 | 待定 |
| D-9-3 | 低 | `desktop/src/main/browserView/browserGuestManager.ts:2377`、`2384`、`3749` | 2377 说关闭后保留计数，2384/3749 是直接 delete，两处注释互相矛盾 | 待定 |
| D-9-4 | 功能未开启 | `main/browserView/browserGuestManager.ts`（`restoreTabs`/`whenRecoveryIdle`/`persistShell`）+ `browserTabRecoveryStore.ts` 全类 | 生产未注入 recoveryStore（产品语义「完整退出即清空」），整条恢复链路恒为空操作；不是漏接线 | 见条目「开启条件」 |
| D-9-5 | 低 | `desktop/src/main/browserView/browserGuestManager.ts:5117-5132`（`runGuestTeardown`）、`:5198-5213`（`waitForGuestCdpIdle`）、INV-05 定义 `:16-17` | CDP idle 超时后仍继续 detach 并返回 teardown 成功，主动放弃 INV-05 的严格保证（有意降级） | 仅在 pending 命令含写操作时成为真问题 |
| D-9-6 | 低 | `desktop/src/main/browserView/browserGuestManager.ts:4944-4952`（`isTabCaptureActive`）、`:2434-2504`（`settleScreenshotCapture`）、`:2209-2226`（`clearTrackedScreenshot`） | 已放弃但仍在 pending 的 CDP capture 不计入 `captureActive`，tab 可能在 capture 未结束时被 LRU 回收 | 待定 |
| D-9-7 | 低 | `desktop/src/main/browserView/browserGuestManager.ts:3169-3205`（`installRecordingCursorOverlay`）、调用点 `:2797`、动作分发 `:2892-3065` | 光标 overlay 只在录制开始注入一次：导航后丢失不重注入；注入失败无 catch，会把整段录制判 `failed`（注释称「只 warn」） | 待定 |
| D-9-8 | 低 | `desktop/src/main/browserView/browserGuestManager.ts:2688-2702`（`abortRecordings` 注释）、`:1840-1857`、`browserVideoRecorder.ts:92-97` | 注释称「由 runRecording 写回 cancelled 并保存部分 artifact」，实际状态在 `abortRecordings` 同步写定、半成品被主动删除 | 待定 |
| D-9-9 | 低 | `desktop/src/main/browserView/browserGuestManager.ts:3282-3285`（`resolveTab` 的 legacy `createTab`）、`:3301-3302`（`createTab` 不清墓碑）、`:897-900`（`attachGuest` 的 closed 分支） | legacy 上下文用 `sessionId` 作 tabId，关闭后重建复用同一 id，被自己的 `closedTabIds` 墓碑永久拒绝 attach | 待定 |
| D-9-10 | 低 | `desktop/src/main/browserView/browserGuestManager.ts:3535-3541`（`releaseToUser`）、`:3642-3650`（`readTabViewport` 自愈）、`:3828-3832`、`:3915-3922` | 注释称释放时清后台 viewport，实现只改归属；复位依赖 INV-22 的惰性自愈，未触发的窗口内页面停在后台尺寸 | 待定 |
| D-9-11 | 低 | `desktop/src/main/browserView/browserGuestManager.ts:3967-3974`（`closeSessionTabs`）、`:4009-4030`（`closeTabDurably`） | 注释称用 `Promise.allSettled`，实现逐条 `await`；一次 `removeTabRecovery` 抛错会让后续 tab 全部留在 registry | 待定 |
| D-9-12 | 低 | `desktop/src/main/browserView/browserGuestManager.ts:3998-4003`（`closeWindow`） | 只清 `naturalViewportByWindow`，未清 `active/default` 索引与 `sessionNames`/`visibilityByScope`；windowId 复用时新窗口继承上一轮可见性 | 待定 |
| D-9-13 | 低 | `desktop/src/main/browserView/browserGuestManager.ts:5440-5447`（`collectMemoryDiagnostics`） | 注释称统计 tab/guest/waiter/recording 四类数量，实现只返回 `tabs`/`closedTabIds` 两项；三类泄漏在诊断采样里不可见 | 待定 |
| D-10-1 | 低 | `desktop/src/main/webRemoteControlManager.ts:1057-1063` | 手机上报的 `activeWorkspaceKey` 未校验是否仍在 `workspaces` 中 | 待定 |
| D-10-2 | 低 | `desktop/src/main/webRemoteControlManager.ts:2169-2170`、`500-502` | `stop()` 无条件占用本进程唯一自动恢复名额 | 待定 |
| D-11-1 | 低 | `desktop/src/main/exportLogs.ts:1449-1464`、`1476-1490` | `showItemInFolder` 与导出同处一个 try，自身抛错会删掉已成功的 zip 或把成功导出报成失败 | 待定 |
| D-11-2 | 低 | `desktop/src/main/exportLogs.ts:1191-1196` → `1333` | `rollout` 递归收集无体积上限，staging 再复制一份，磁盘峰值接近翻倍 | 待定 |
| D-12-1 | 低 | `desktop/src/main/desktopDeepLinkUrl.ts:227-245`、`260-266` | `searchParams.has(...)` 把空值参数判为齐全，提前返回丢弃后续完整候选 | 待定 |
| D-13-1 | 低 | `desktop/src/main/desktopZCodeDataSizeTelemetry.ts:418-421` | `isZCodeBusy()` 在 try 之外，抛错后调度链停摆到重启 | 待定 |
| D-13-2 | 低 | `desktop/src/main/desktopZCodeDataSizeTelemetry.ts:489-495`、`516-517`、`306-316` | 旧实例回滚覆盖新实例预占，限流锚点回退 | 待定 |
| D-13-3 | 低 | `desktop/src/main/desktopZCodeDataSizeTelemetry.ts:280-288` | `persistSuccess` 写盘失败只告警，成功时间未落盘 | 待定 |
| D-14-1 | 低 | `desktop/src/main/networkTelemetryAggregator.ts:287-288` | `durations` 未做有限性校验，`NaN` 污染整桶 `mean/p95/peak` | 待定 |
| D-15-1 | 高 | `services/output-style/outputStyleService.ts:275-288`、`300-314`、`323-330` | `addStyle`/`updateStyle`/`deleteStyle` 不校验 `name`/`id`，`../` 可越出 `output-styles` 覆盖或删除任意 `.md` | 待定 |
| D-15-2 | 高 | `packages/server/src/http.ts:184`、`420-428`；`entry-http.ts:17-20`、`39` | server 模式把全部服务暴露给 `/ws`，token 可选；不配 token 时任意可达客户端获得终端/文件/凭据面 | 待定 |
| D-16-1 | 中 | `main/browserView/browserGuestManager.ts:864-891`（根因）+ `detach`/`hasGuest`/`getTabOwner`/`closeWindow`（潜伏落点）+ `restoreTabs`（作用域参数自报） | 能力凭据只含调用方自报的标识、不绑调用方身份；`attachGuest` 可用任意 webContentsId 共享他人 guest 的 CDP，`restoreTabs` 可取回其它 workspace 的 shell | 待定 |
| D-31 | 低 | `main/about.ts:315-334`；入口 `desktopApplicationMenu.ts:179`、`:340`、`desktopTray.ts:154` | 关于窗口无单例、无在途互斥，快速重复触发会叠出多个窗口 | 待定 |

## 统一索引（42 条 + 1 条功能未开启记录，按「能被谁触发」分档）

> 分档口径：
> **A 外部输入可触发** —— 任何能给到 IPC 消息、环境变量、启动参数或网络对端的人/进程都能踩到，含安全级。
> **B 内部状态导致** —— 需要崩溃、重启、并发时序这类运行态条件，外部无法直接触发。
> **C 仅影响可观测性** —— 只污染指标、日志、展示串，不改变业务状态与权限。
> 修复优先级按 A > B > C；同档内按级别。D-7-* 详情见 `ZC-legacy-cleanup-queue.md` §12.5，D-8-* 见 §13.5，D-9-* 见 §14.5，D-10-* 见 §15.5。
> **共性根因**：`packages/rpc/src` 全目录检索 `authorize|principal|permission|role` 零命中——通道层没有授权概念，只有「整条通道是否暴露」的白名单。D-15-1 与 D-15-2 都是这一层的直接后果，不是某个方法漏写了一处校验。

### A. 外部输入可触发（11 条）

> `A·潜伏`：路径属外部输入，但当前零调用方 / 零入口，接入后方可触发；严重度不因此下调。

| ID | 级别 | 位置 | 一句话 | 谁能触发 | 修复成本估计 |
| --- | --- | --- | --- | --- | --- |
| D-15-2 | 高 | `packages/server/src/http.ts:184`、`420-428`；`entry-http.ts:17-20` | server 模式一次 `exposeOnChannelServer` 暴露全部服务，未配 token 时整条鉴权中间件不注册 | 仅显式启动 server 的部署（桌面端不自动拉起）：任何能访问 `3030` 的网络对端（`host` 未配置时实测监听 `0.0.0.0`/`::`）；配 token 时任何持有该串的一方 | 约 30–60 行 / 需定服务面白名单或默认强制 token / 无迁移 |
| D-15-1 | 高 | `services/output-style/outputStyleService.ts:275-288`、`300-314`、`323-330` | `name`/`id` 未做路径校验，`../` 逃出 `output-styles`，可覆盖或删除任意 `.md`（含 `~/.claude/CLAUDE.md`） | 已配对 web-remote 客户端或 server `/ws` 客户端直接调 `addStyle`/`updateStyle`/`deleteStyle` | 约 10 行 / 不改接口 / 无迁移（已覆盖的文件不可恢复） |
| D-16-1 | 中 | `main/browserView/browserGuestManager.ts:864-891` + `restoreTabs` | 能力凭据只含调用方自报的标识、不绑调用方身份：`attachGuest` 可共享他人 guest 的 CDP，`restoreTabs` 可取回其它 workspace 的 shell；`detach`/`hasGuest`/`getTabOwner`/`closeWindow` 是同类潜伏落点 | 任一能调用 `BrowserViewAttachGuest` / `BrowserViewRestoreTabs` 的 renderer（自报 tabId + 自增 webContentsId，可枚举） | 约 15–20 行 / 加统一 `assertGuestBelongsTo` + 校验 sender 的 workspace / 无迁移 |
| D-7-1 | 高 | `main/autoUpdater.ts:1937-1957` + `main/desktopMainIpcPlatform.ts:485-491` | 更新说明的 ack 只校验 `version`，不校验发送方 | 任意 renderer（拿到版本号即可清全局 pending，弹窗变孤儿） | 约 15 行 / 不改接口 / 无迁移 |
| D-03 | 高 | `services/output-style/outputStyleService.ts:91-94`、`177-188` | 配置损坏后被回写成只剩 `outputStyle`，`hooks`/`permissions` 永久丢失（**已确认整文件覆盖**） | 已配对设备上的第三方/篡改客户端：`output-style` 在 web-remote allowlist 内，通道层无主体校验；前置是 `settings.json` 已损坏 | 约 8 行 / 不改接口 / 无迁移（已丢配置不可恢复） |
| D-05 | 中 | `services/bots/providers/webhookProvider.ts:234-250` | webhook `fetch` 无超时，Bot 串行队列永久阻塞 | 对端完成连接后不返回响应 | 约 5 行 / 不改接口 / 无迁移 |
| D-06 | 中 | `services/bots/providers/weixinProvider.ts:959-966` | 附件下载无超时、无大小上限，整包进内存 | 对端挂起或返回超大附件 | 约 20 行 / 不改接口 / 无迁移 |
| D-7-3 | 中 | `main/autoUpdater.ts:976-990` → `1039-1044` | 更新源 URL 无协议/主机白名单，直连 `setFeedURL` | 能改环境变量/启动参数的一方 | 约 8 行 / 不改接口 / 无迁移 |
| D-9-2 | 低 | `main/browserView/browserGuestManager.ts:2851-2875` | 注释称返回 null 跳过动画，实际 `throw` 中止整段录制（非安全级） | 任何经 IPC 下发录制脚本的一方（选择器匹配不到可见元素即可触发） | 约 5 行 / 需确认调用方错误语义 / 无迁移 |
| D-10-1 | 低 | `main/webRemoteControlManager.ts:1057-1063` | 手机上报的 `activeWorkspaceKey` 未校验是否仍在 `workspaces` 中 | 已配对的手机上报后，桌面移除该项目或工作区列表变化 | 约 5 行 / 不改接口 / 无迁移 |
| D-12-1 | 低 | `main/desktopDeepLinkUrl.ts:227-245`、`260-266` | `searchParams.has(...)` 把 `?state=` 空值判为齐全，提前返回丢弃后续完整候选 | 外部程序或浏览器构造含空值参数的深链，且 argv 中另有完整回调 | 约 10 行 / 不改接口 / 无迁移 |

### B. 内部状态导致（23 条）

| ID | 级别 | 位置 | 一句话 | 触发条件 | 修复成本估计 |
| --- | --- | --- | --- | --- | --- |
| D-01 | 高 | `services/feedback/feedbackLocalTicketStore.ts:113-118` | 覆盖写中途被杀，整份票据被读成空集合 | 写盘被 kill / 断电 / 磁盘满 | 约 20 行 / 不改接口 / 需一次性恢复策略（无备份则不可恢复） |
| D-02 | 中 | `services/session/offPeakTaskRepo.ts:793-794`、`807`、`976-1001` | 崩溃留下 `queued + claim_running=1`，stale 窗口内不可跑不可认领 | 提交事务后、`markRunning` 前崩溃 | 约 6 行 / 不改接口 / 无迁移 |
| D-04 | 中 | `desktop/src/scheduler/index.ts:370-377`；`services/session/automationRepo.ts:1659-1665` | 两段写之间崩溃导致同一 `runId` 派发两次 | 第一次写后崩溃且 turn 仍存活 | 约 20–30 行 / 可能改 repo 接口 / 无迁移 |
| D-07 | 低 | `services/project/autoArchiveScheduler.ts:67-86`、`133-139` | `dispose` 后仍在跑的扫描继续归档并广播 | 释放发生在扫描中段 | 约 3 行 / 不改接口 / 无迁移 |
| D-7-2 | 中 | `main/autoUpdater.ts:1934-1936`、`1955-1956`、`1196-1204` | ack 集合只在内存，清盘失败后重启会重新投递 | 清 pending 落盘抛错 + 重启 | 约 20 行 / 新增持久化位置 / 无迁移 |
| D-7-4 | 低 | `main/autoUpdater.ts:2588`、`1210-1213` | `manualCheckWebContentsId` 单槽，后一次检查覆盖前一次 | 两个窗口先后点「检查更新」 | 约 5 行 / 不改接口 / 无迁移 |
| D-7-5 | 待确认 | `main/autoUpdater.ts:2382-2390` | 强更监听器单槽覆盖，旧回调用身份判断清不掉 | 同时存在两个强更入口（需确认装配侧是否串行） | 约 5 行 / 需确认装配 / 无迁移 |
| D-8-4 | 低 | `main/desktopStabilityTelemetry.ts:1173-1177` | 首屏后 3.2s 定时器未 `unref()`、未存句柄 | 窗口在延迟内关闭 | 约 3 行 / 不改接口 / 无迁移 |
| D-9-1 | 低 | `main/browserView/browserGuestManager.ts:4764-4769` | 注释称只统计 dispatched 且未 abort，实现只按 tabId，取消后未 finally 的请求仍阻止 detach | 取消命令后、finally 执行前触发 teardown/refreshRuntimeProtection | 约 3 行 / 不改接口 / 无迁移 |
| D-9-4 | 功能未开启 | `main/browserView/browserGuestManager.ts`（`restoreTabs`/`whenRecoveryIdle`/`persistShell`）+ `browserTabRecoveryStore.ts` 全类 | 生产未注入 recoveryStore，整条恢复链路恒为空操作；判定为有意未启用，不计缺陷级别 | 任何用到恢复链路的调用方（`whenRecoveryIdle` 恒立即 resolve） | 见条目「开启条件」四件 |
| D-10-2 | 低 | `main/webRemoteControlManager.ts:2169-2170`、`500-502` | `stop()` 无条件置 `startupRestoreClaimed`，手动停止消耗唯一恢复名额 | 窗口 A 手动启停后，新窗口 B 再调用 `restorePreviouslyEnabled` | 约 3 行 / 不改接口 / 无迁移 |
| D-11-1 | 低 | `main/exportLogs.ts:1449-1464`、`1476-1490` | `showItemInFolder` 抛错被当成导出失败：zip 被删、目录成功仍报失败 | 依赖注入的 `showItemInFolder` 抛错，或 `import("electron")` 失败 | 约 6 行 / 不改接口 / 无迁移 |
| D-11-2 | 低 | `main/exportLogs.ts:1191-1196` → `1333` | `rollout` 无体积上限，staging 让磁盘峰值接近翻倍 | **可预期触发**：长期使用的机器上 `~/.zcode/cli/rollout` 累计到 GB 级，无需异常条件 | 约 10–20 行 / 需定上限策略 / 无迁移 |
| D-13-1 | 低 | `main/desktopZCodeDataSizeTelemetry.ts:418-421` | `isZCodeBusy()` 在 try 之外，抛错变成未处理拒绝且不再排下一次调度 | 宿主注入的忙碌探测抛错（其依赖的会话状态读取失败） | 约 5 行 / 不改接口 / 无迁移 |
| D-13-2 | 低 | `main/desktopZCodeDataSizeTelemetry.ts:489-495`、`516-517`、`306-316` | `stop()` 不等待在途采集，旧实例回滚覆盖新实例预占 | 重新注册发生在旧实例「已预占、未上报」的窗口内 | 约 15 行 / 需给 `stop()` 加等待或加世代号 / 无迁移 |
| D-31 | 低 | `main/about.ts:315-334`；入口 `desktopApplicationMenu.ts:179`、`:340`、`desktopTray.ts:154` | 关于窗口无单例、无在途互斥，快速重复触发会叠出多个窗口 | 两次 `showAboutDialog` 在首个窗口构造完成前先后进入（`:298` 的 `await import` 让连点都能通过） | 约 5 行 / 不改接口 / 无迁移 |
| D-9-5 | 低 | `main/browserView/browserGuestManager.ts:5117-5132`、`:5198-5213`；INV-05 `:16-17` | **有意降级**：CDP idle 超时后仍 detach 并返回 teardown 成功，主动放弃 INV-05 的严格保证 | 一条已下发命令永不 settle（renderer 卡死）；若该命令含写操作，调用方会把「未结算」当成「已静止」 | 不建议改代码；INV-05 保持原文作为水位，本条目只登记取舍 |
| D-9-6 | 低 | `main/browserView/browserGuestManager.ts:4944-4952`、`:2434-2504`、`:2209-2226` | `isTabCaptureActive` 只读 tracker/录制/`isBeingCaptured`，漏掉 `abandonedScreenshotCaptures`，已放弃的 CDP capture 不保护 tab | 截图被 abort/hidden-deadline 先结算，底层 `Page.captureScreenshot` 仍 pending；此时 tab 数达到上限触发 LRU 回收 | 约 3 行 / 不改接口 / 无迁移 |
| D-9-7 | 低 | `main/browserView/browserGuestManager.ts:3169-3205`、`:2797`、`:2892-3065` | 光标 overlay 只注入一次，导航后不重注入；注入失败无 catch，整段录制被中止（注释称「只 warn」） | 录制含跳转动作（overlay 随旧 document 销毁），或起始页禁止脚本注入 | 约 6 行 / 不改接口 / 无迁移 |
| D-9-8 | 低 | `main/browserView/browserGuestManager.ts:2688-2702`、`:1840-1857`；`browserVideoRecorder.ts:92-97` | `abortRecordings` 注释给的两条理由都不成立：状态由自身同步写定，半成品被主动删除 | 维护者按注释预期读取取消后的 `status`/`artifact` | 约 4 行注释 / 不改接口 / 无迁移 |
| D-9-9 | 低 | `main/browserView/browserGuestManager.ts:3282-3285`、`:3301-3302`、`:897-900` | legacy 用 `sessionId` 作 tabId，关闭后重建复用同一 id，被自己的墓碑永久拒绝 attach | 旧 renderer（string 上下文）关闭 tab 后任一带/不带 tabId 的命令触发隐式 `createTab` | 约 5 行 / 需决定墓碑是否按 legacy scope 清理 / 无迁移 |
| D-9-10 | 低 | `main/browserView/browserGuestManager.ts:3535-3541`、`:3642-3650` | `releaseToUser` 注释称清后台 viewport，实现只改归属，复位依赖 `readTabViewport` 在 `tab.active` 时的自愈 | turn 结束/session 关闭时 tab 不在前台，且之后未再触发 selectTab / reportResidency / viewport 读取 | 约 4 行 / 不改接口 / 无迁移 |
| D-9-11 | 低 | `main/browserView/browserGuestManager.ts:3967-3974`、`:4009-4030` | `closeSessionTabs` 注释称 `allSettled`，实现逐条 await；一次持久化删除抛错中断后续关闭 | recoveryStore 未注入时不会抛；注入后磁盘/权限错误即可命中 | 约 3 行（改 `Promise.allSettled` 并保留 tombstone 顺序）/ 不改接口 / 无迁移 |
| D-9-12 | 低 | `main/browserView/browserGuestManager.ts:3998-4003` | `closeWindow` 漏清 scope 级索引与可见性/名字缓存，windowId 复用时新窗口继承上一轮状态 | 关闭窗口后 Electron 复用同一 windowId，且 workspace/session 相同 | 约 6 行 / 不改接口 / 无迁移 |

### C. 仅影响可观测性（9 条）

| ID | 级别 | 位置 | 一句话 | 污染面 | 修复成本估计 |
| --- | --- | --- | --- | --- | --- |
| D-8-1 | 中 | `main/desktopStabilityTelemetry.ts:1086-1090` → `1020` | ANR/freeze 的 `duration_ms` 由事件到达时刻起算，不是真实卡顿起点 | 看板时长系统性偏小 | 约 5 行 / 可能需事件带上起点 / 无迁移 |
| D-8-2 | 中 | `main/desktopStabilityTelemetry.ts:980-986` | 无窗口且无焦点窗时回退 `"main"`，与 INV-19 冲突 | webview/已销毁窗口崩溃算进主窗 crash 率 | 1 行 / 不改接口 / 无迁移 |
| D-8-3 | 中 | `main/desktopStabilityTelemetry.ts:1254` | crash 上报成功日志用 `logger.error` | console collector 多计一条伪 JS 异常 | 1 行 / 不改接口 / 无迁移 |
| D-8-5 | 低 | `main/desktopStabilityTelemetry.ts:289-305` | 脱敏令牌 `ZCODE_REDACTED_PATH_<n>_TOKEN` 可预测 | 同形文本被还原成别的路径，污染展示串与指纹 | 约 8 行 / 不改接口 / 无迁移（旧日志令牌不可逆） |
| D-8-6 | 低 | `main/desktopStabilityTelemetry.ts:679-681` | 去重集合 1024 容量 FIFO 淘汰不区分活跃实例 | 超长会话可能重复上报 | 约 5 行 / 不改接口 / 无迁移 |
| D-9-3 | 低 | `main/browserView/browserGuestManager.ts:2377`、`2384`、`3749` | 两处注释对「关闭 tab 后计数是否保留」表述相反 | 后续维护者误以为关闭路径仍保留计数 | 约 2 行注释 / 不改接口 / 无迁移 |
| D-13-3 | 低 | `main/desktopZCodeDataSizeTelemetry.ts:280-288` | `persistSuccess` 写盘失败只 `warn`，成功时间未落盘 | 上报成功但成功时间落盘失败：重启后锚点退回预占时间（仅偏移若干秒） | 约 5 行 / 不改接口 / 无迁移 |
| D-14-1 | 低 | `main/networkTelemetryAggregator.ts:287-288` | `durations` 直接 push，`NaN`/`Infinity` 让整桶 `mean`/`p95`/`peak` 变 `NaN` | Host 批量观测中任一条 `durationMs` 非有限值（上游计算缺陷或反序列化异常） | 约 3 行 / 不改接口 / 无迁移 |
| D-9-13 | 低 | `main/browserView/browserGuestManager.ts:5440-5447` | 注释称统计 tab/guest/waiter/recording 四类数量，实现只回 `tabs`/`closedTabIds` | 资源管理器与测试断言看不到 guest/waiter/recording 三类泄漏 | 约 4 行（补三个计数）/ 不改接口 / 无迁移 |

---

## D-01 反馈票据非原子覆盖写

- **位置**：`packages/services/src/feedback/feedbackLocalTicketStore.ts:113-118`（写入）、`:99-108`（读取降级）。
- **触发条件**：`upsert` 执行 `writeFile(this.filePath, ...)` 时进程被 kill、断电或磁盘写满。`writeFile` 先截断目标文件再写入。
- **后果**：磁盘上留下空文件或半截 JSON。下次 `read` 的 `JSON.parse` 抛错，`:101-108` 的 `catch` 把解析失败与 `ENOENT` 一起返回 `{ tickets: [] }`，所有设备的所有票据一次性消失，且没有任何文件可恢复。
- **判断依据**：
  - `:113-118` 的 `write` 只有 `mkdir` + `writeFile`，没有临时文件、没有 `rename`、没有备份。
  - `:104-107` 两个分支都 `return { tickets: [] }`，损坏与「文件不存在」不可区分。
  - 写入侧是整体覆盖（`upsert` 先 `read` 再写全量），所以损坏无法靠增量追加自愈。

## D-02 off-peak 认领后的崩溃中间态

- **位置**：`packages/services/src/session/offPeakTaskRepo.ts:790-794`（`COMMIT`）、`:806-807`（`markRunning`）、`:976-1001`（`recoverInterrupted`）。
- **触发条件**：`claimDue` 提交事务后、调用方执行 `markRunning` 之前，进程被杀或重启。
- **后果**：盘上保留 `status='queued'` 且 `claim_running=1` 的行。`recoverInterrupted` 的第一个 UPDATE 只匹配 `status='running'`（`:988-994`），不碰该行；第二个 UPDATE（`:995-1000`）虽然会清 `claim_running`，但条件是 `claimed_at <= now - OFF_PEAK_CLAIM_STALE_MS`。崩溃后立刻重启时 `claimed_at` 是新的，条件不成立，于是该任务在完整 stale 窗口内既不会被 `markRunning` 推进，也不会被 `claimDue` 重新选中。
- **精确表述**：不是「完全不处理」，而是「没有启动时立即处理，只靠时间窗口兜底」。窗口长度即 `OFF_PEAK_CLAIM_STALE_MS`。
- **判断依据**：`:793` 的 `COMMIT` 与 `:807` 的 `markRunning` 分属两个调用方事务；`:984` 注释写明只把 `running` 回队；`:998` 的 stale 条件决定清理时机。

## D-03 outputStyle 读损坏后回写覆盖用户配置

- **位置**：`packages/services/src/output-style/outputStyleService.ts:91-94`（读失败归一为 `null`）、`:177-188`（合并后整文件回写）。
- **分级：A·高**：代码缺陷成立——「读失败归一为空值 + 整文件覆盖写回」按 DEEP-SPEC §10 的组合判据记最高严重度。仓库内确实没有 `setActiveStyle` 调用点（官方 UI 未接入），但**「零调用点」不等于「远端不可达」**：`output-style` 在 web-remote allowlist 内（`windowHostAttachmentRpcPolicy.ts:79`），且通道层没有任何主体校验，已配对客户端可直接发该 RPC。触发面从「用户误操作」更正为「已配对设备上的第三方/篡改客户端」。
- **触发条件**：两个条件同时成立——①已配对客户端（手机 web-remote，或持 server token 的 `/ws` 客户端）主动调用 `setActiveStyle`；②`settings.json` 已损坏（手工编辑出错、上一次非原子写被截断）。缺②时写回只覆盖 `outputStyle` 单键，`hooks`/`permissions` 保留，不会丢数据。
- **后果**：`readJsonFile` 在 `catch` 里返回 `null`，`:177` 的 `|| {}` 把现有配置当成空对象，`:180-184` 只写入 `outputStyle`，`:188` 整文件覆盖。用户原有的 `hooks`、`permissions` 等键永久丢失；后续读取只能回退默认值。
- **判断依据**：`:85-87` 的 `ENOENT` 分支与 `:91-94` 的解析异常分支返回同一个 `null`，调用方无法区分「首次启动」与「文件损坏」。`writeJsonFile` 又是整文件替换，没有合并前校验。
- **仓库内零调用点（2026-11-09，已按函数名、服务名、通道名三路检索，范围含 `apps/*`、`packages/*` 与 `.tsx`/`.vue`/模板）**：
  - 函数名：`setActiveStyle` 全仓命中仅 `outputStyleService.ts:162`（定义）、`:357`（返回对象）、`outputStyle.ts:34`（接口），无调用点。
  - 服务名：`"outputStyleService"` 仅 `remoteWorkspaceRpcContract.ts:53` 与 `remoteWorkspaceServiceCollection.ts:145`（均为注册/契约映射），无调用点。
  - 通道名：`ServiceChannels.OutputStyle = "output-style"`（`packages/shared/src/channels.ts:174`）只出现于 `outputStyle.ts:43`（描述符）、`windowHostAttachmentRpcPolicy.ts:79`（web-remote 白名单）与上述注册链；全仓无 `getChannel("output-style")` 这类字符串直调。
  - 客户端实现：web 侧 `packages/web/src/main.tsx:1237-1240` 的空实现只补 `listStyles` 与 `getUserStylesDirectory`，未实现 `setActiveStyle`；测试 `homeOnlyWebRemoteControlServices.test.ts:78` 只调 `listStyles`。
  - 排除项：`apps/zcode-cli` 内的 `output-style` / `outputStyle` 命中均为 CLI 提示词配置（`*-output-style-*` 测试名、插件资产目录名、`turnOutputStyle`），不是本服务的通道调用。
  - 结论：仓库内零调用点；**这不构成「远端不可达」证据**，可达性见下一条。
- **远端可达性核查（2026-11-09，A·高的判定依据）**：
  - 白名单语义是「允许该通道发布给 web-remote attachment」，不是「仅本窗口 Host 可调」：`windowHostAttachmentRpcPolicy.ts:31-35` 明确写「手机（web-remote-replayable）可用的 channel 白名单」，`:79` 含 `ServiceChannels.OutputStyle`，`:146-150` 按策略调用 `exposeOnChannelServer`。
  - 过滤粒度是通道级：`collection.ts:50-59` 注册时按 `channelName` 过滤，注册后整条通道连同全部方法可用；本通道没有按方法收窄的包装（`host/index.ts:3153-3165` 只包装 conversationShare），也没有 OutputStyle 的 override。
  - 分发层无授权钩子：`channelServer.ts:165-175` 直接 `channels.get(channelName)` → `channel.call(ctx, name, arg, token)`，无 principal / role / capability 判断；全 `packages/rpc/src` 检索 `authorize|principal|permission|role` 零命中。
  - 服务未声明权限等级：`descriptors.ts:8-16` 描述符只有 `channelName`；`outputStyle.ts:42-44` 的 `IOutputStyleService` 没有权限元数据，`setActiveStyle` 与 `listStyles` 同级暴露。
  - 中继不过滤：Main 对手机帧是纯管道、「不解析帧内容」（`webRemoteControlManager.ts:1337-1341`、`:1369-1371`），不按 channel 拦截；clientMode 由 Main 固定为 `web-remote-replayable`（`desktopRemoteSessions.ts:1885`、`:1944`、`:1982`），手机无法自提升为 desktop-continuous。
  - server 模式更宽：`/ws` 固定 web-remote（`packages/server/src/http.ts:448-465`），但同文件 `:184` 把全部服务 `exposeOnChannelServer`，只对 `ProviderProvisioningTarget` 做了拒绝覆盖（`:171-180`）；token 是可选的路径级校验（`:416-437`）。
  - 结论：**无主体校验，任何已配对客户端可调**。调用方在手机端/第三方客户端，不在仓库里，因此 grep 抓不到——「零调用点」只说明没有官方入口。
- **最小修复方案（只写方案，未落盘、未改任何代码行）**：保留 `readJsonFile` 供读路径继续降级，只给 `setActiveStyle` 换一个严格读取函数，让解析失败在写回前中止。

```diff
+// 写前严格读：ENOENT 才当「无配置」；解析失败直接抛错，由 setActiveStyle 中止写回
+async function readJsonFileForWrite<T>(filePath: string): Promise<T | null> {
+  if (!existsSync(filePath)) return null;
+  return JSON.parse(await readFile(filePath, "utf-8")) as T;
+}
 ...
-const existingSettings = (await readJsonFile<ClaudeSettingsConfig>(settingsPath)) || {};
+const existingSettings = (await readJsonFileForWrite<ClaudeSettingsConfig>(settingsPath)) ?? {};
```

  - **行为变化**：修复后，`settings.json` 损坏时不再用 `{}` 覆盖，`setActiveStyle` 会失败并把解析错误抛给调用方（沿用现有 IPC / 服务错误通道）；原文件保持原样，可手工修复。读路径（`getActiveStyle` / `listStyles`）仍按原逻辑降级为默认值，列表不会因此打不开。
  - **兼容性影响**：修复后，已配对客户端在配置损坏时调用会收到报错而不是静默清空；这是把「不可见的永久丢失」换成「可见的一次失败」。官方 UI 不调用该方法，普通用户无感知。建议在抛错前一次性备份为 `settings.json.bak`（见下），备份失败不阻断报错，只记日志。
  - **可选备份（1 行）**：在 `readJsonFileForWrite` 的 `catch` 里 `await copyFile(filePath, \`${filePath}.bak\`).catch(() => {});` 后 `throw error;`，需要从 `node:fs/promises` 引入 `copyFile`。
  - **成本与接口**：约 8 行；`readJsonFile` 签名不变，新增函数只在文件内部使用，不改对外接口；无数据迁移。
- **调用方核查（2026-11-09，决定方案是否成立）**：
  - 注册：`packages/services/src/node.ts:3438` `.register(IOutputStyleService, createOutputStyleService())`；`packages/services/src/collection.ts:56-59` 用 `ProxyChannel.fromService` 统一暴露。
  - 传输：`packages/rpc/src/channelServer.ts:174-178` 把同步抛出转成 rejected Promise，同文件 `:16`（INV-16）把 `Error` 转成可结构化信封；`packages/rpc/src/channelClient.ts:155`、`:161` 在 `PromiseError` / `PromiseErrorObj` 分支 `reject` 调用方 Promise。
  - renderer：仓库内**没有 `setActiveStyle` 的调用点**——全仓 grep 只命中定义、RPC 访问器 `packages/client/src/remoteServiceAccess.ts:378` 与 web 的空实现 `packages/web/src/main.tsx:1237`；`packages/web/test/homeOnlyWebRemoteControlServices.test.ts:78` 只调用 `listStyles`。
  - 结论：当前不存在「调用方 catch 吞掉」的既有风险，方案改成抛错后错误会沿 RPC reject 原样到达调用方。仓库内没有本地触发入口，但远端通道无主体校验，触发面是「已配对设备上的第三方/篡改客户端」，因此定级为 **A·高**。
- **`.bak` 放置（写在 `readJsonFileForWrite` 的 `catch` 内、`throw` 之前）**：
  - 备份成功 → 仍 `throw error` 中止写回，原始损坏文件保持原样。
  - 备份失败 → 吞掉备份异常（`copyFile(...).catch(() => {})`）后 `throw error`，同样中止写回；**绝不出现「备份没成但仍继续写」**。
  - 两条路径都在 `writeFile` 之前返回，因此原始文件不会被覆盖。`existsSync` + `readFile` 的 TOCTOU 在配置写入单写者前提下无害，按结论不处理。
  - `.bak` 已存在时 `copyFile` 默认覆盖；由于源文件从未被写入，重复失败只会得到内容相同的新备份。

## D-04 调度 run 台账与 automation 推进之间的崩溃窗口

- **位置**：`packages/desktop/src/scheduler/index.ts:370-377`（两次独立 `await`）；`packages/services/src/session/automationRepo.ts:1659-1665`（同 `runId` 冲突分支重置状态）。
- **触发条件**：`markRunDispatch` 成功后、`markDispatched` 执行前 scheduler 进程崩溃或重启，而该轮 agent turn 在独立 host 进程中仍存活。
- **后果**：
  1. automation 行保持 `running=1`、`next_run_at` 未推进；
  2. 超过 `CLAIM_STALE_MS` 后被重新认领，`resolveScheduledAt` 仍取旧的 `next_run_at`，`buildRunId` 生成同一个 `runId`（`scheduler/index.ts:119-120、174-180`）；
  3. `upsertRunClaimed` 的 `ON CONFLICT(run_id)` 分支把该行重置为 `claimed`、清空 `outcome/error`（`automationRepo.ts:1659-1665`），随后再次派发。
  4. 若第一轮 turn 仍在跑，同一 `runId` 被并发执行两次；先结束的一轮写回的 outcome 会被第二轮的认领清空，历史只剩最后一次。
- **判断依据**：`:370-377` 两次写之间没有事务；`runId` 由 `automationId + scheduledAt` 决定，而 `scheduledAt` 在 `markDispatched` 未执行时保持不变；`:1659-1665` 的冲突分支明确重置 `dispatch_status` 并清 `outcome`。
- **边界**：若崩溃同时杀死了 turn（整个应用退出），则不构成重复执行，只是同一轮重跑；缺陷只在 turn 存活于独立进程时成立。

## D-05 webhook 重试没有总超时

- **位置**：`packages/services/src/bots/providers/webhookProvider.ts:234-250`（重试循环）、`:240`（`fetch`）。
- **触发条件**：对端完成 TCP 连接后不返回响应，或响应体长期不结束。
- **后果**：`fetch(url, init)` 没有 `signal`、没有 `AbortSignal.timeout`，三个轮次的 `await` 都可能永久挂起。调用方 `send` / `test` 因此永不返回；该 Bot 的串行队列被一条消息占死，后续消息全部排队。
- **判断依据**：`:240` 只传了 `url` 与 `init`，`init` 中未设置 `signal`；`:234` 的循环按「尝试次数」退避，但没有总时长上界。`:251-256` 的收尾逻辑只有在 `fetch` 真正 settle 后才会执行。

## D-06 微信附件下载没有超时与大小上限

- **位置**：`packages/services/src/bots/providers/weixinProvider.ts:959-966`。
- **触发条件**：CDN 建立连接后不返回、返回超大附件，或返回的 `Content-Length` 远超预期。
- **后果**：`:959` 的 `fetch` 没有超时；`:965` 的 `response.arrayBuffer()` 把整包读进内存后再解密。大附件会把进程内存推到与附件同量级，挂起的请求会让本轮轮询一直不返回，后续消息无法处理。
- **判断依据**：`:959` 未传 `signal`；`:965` 在 `decryptWeixinCdnMedia` 之前完整缓冲；`:953` 只校验 URL 与密钥存在，没有体积约束。文件头的 INV-04 注释也承认识别不到大小上限。

## D-07 autoArchiveScheduler 释放后仍会归档与广播

- **位置**：`packages/services/src/project/autoArchiveScheduler.ts:67-86`（`runOnce`）、`:133-139`（`dispose`）。
- **触发条件**：`dispose` 发生在 `runOnce` 通过 `:71` 的 `disposed` 检查之后、`:73` 的 `archiveInactive` 或 `:83` 的 `afterChange` 尚未完成时。
- **后果**：已被释放的调度器仍会执行一次归档写库，并在 `:83` 调用 `afterChange` 广播。订阅方若已在释放流程中拆掉监听，会收到一次释放后的回调；若未拆，会看到一次本不应发生的项目列表刷新。
- **判断依据**：`disposed` 只在 `:71`（`await readPolicy` 之后）与 `:89`（`scan` 入口）检查；`:73` 与 `:83` 之间没有再次检查。`:136` 的注释说「进行中的扫描在下一处 await 后会看到 true」，但 `runOnce` 在 `archiveInactive` 之后的下一处 `await` 是 `afterChange`，并不检查 `disposed`——注释描述的行为在代码里不存在。

---

## D-9-1 hasRunningRequestForTab 的过滤条件不存在

- **位置**：`packages/desktop/src/main/browserView/browserGuestManager.ts:4764-4769`。
- **触发条件**：一条命令被 abort 取消后、其 `finally` 清理 `runningRequests` 之前，触发 `refreshRuntimeProtection` 或 teardown（空闲 detach、guest 换代）。
- **后果**：`hasRunningRequestForTab` 返回 `true`，teardown 被推迟到该请求 finally 落定；注释承诺的「已取消但未 finally 的请求不应阻止 detach」没有生效。
- **判断依据**：注释写「只统计 dispatched 且未 abort 的请求」，实现是 `[...this.runningRequests.values()].some((request) => request.tabId === tabId)`，既不读 `request.dispatched` 也不读 `request.controller.signal.aborted`。

## D-9-2 resolveRecordingSelectorPoint 失败即中止整段录制

- **位置**：`packages/desktop/src/main/browserView/browserGuestManager.ts:2851-2875`（注释与函数），调用点 `:2728`。
- **触发条件**：录制脚本的 hover/click 选择器匹配不到可见元素，`resolveRecordingSelectorPoint` 抛错。
- **后果**：整段录制当场失败，而不是仅跳过光标动画；`point.x` 无 null 分支，也不会走到「降级」。
- **判断依据**：签名是 `Promise<{ x: number; y: number }>`，失败路径 `throw new Error("recording selector ... has no visible point")`；调用点直接取 `point.x`。原注释「返回 null，让调用方跳过动画」与实现相反，已在本批按实际行为改写并挂编号。
- **补充落点（片 8）**：`resolveRecordingSelectorScrollTarget`（`:3110-3118`）同一形态——注释写「取不到时回退到窗口滚动，不能抛错」，实现直接 `throw` 中止整段录制。已在该处挂 D-9-2 编号，不另立新 ID。

## D-9-3 关闭 tab 后计数是否保留，两处注释相反

- **位置**：`packages/desktop/src/main/browserView/browserGuestManager.ts:2377`（本批已改写）、`:2384`、`closeTab` 内的 `abandonedScreenshotCaptures.delete`（原 `:3749`）。
- **触发条件**：阅读关闭路径的维护者按 2377 的原句理解行为。
- **后果**：会误以为关闭后仍保留计数、靠 capture 落定回收；实际是 `closeTab` 直接 delete，旧 capture 迟到结算时 `release` 读到 `undefined` 直接返回。
- **判断依据**：`:2384` 明说「tab 关闭时也会直接 delete（不等落定）」；`closeTab` 内确有 `abandonedScreenshotCaptures.delete(tab.tabId)`。tabId 为 `iab-tab:<uuid>`，不存在复用，原句「避免新 tab 复用 id 时被旧计数污染」也不成立。

## D-9-4 标签恢复子系统在生产中不生效（功能未开启）

**性质：有意未启用，不是漏接线。** 但整条「崩溃/退出后恢复标签」链路在真实进程中恒为空操作，属于会被人误读为「已经在跑」的静默未启用，单独记录并写清开启条件。

- **位置**：`packages/desktop/src/main/browserView/browserGuestManager.ts`（`restoreTabs` / `whenRecoveryIdle` / `persistShell` / `persistRecoverySnapshot`）、`browserView/browserTabRecoveryStore.ts`（整个类）、`main/index.ts:554-560`（装配）、`desktopBrowserViewIpc.ts:297-320`（IPC 线缆）、`preload/index.ts:921-924`（暴露）。
- **判定为「有意未启用」的证据**：
  1. `index.ts:554-560` 两处显式注释：「residency 选项不注入 recoveryStore：Browser shell 不跨进程恢复，'完整退出即清空'是产品语义，恢复会与新 webview 重复 attach」。这不是沉默缺省，是写下来的产品决策。
  2. 没有任何开关或 feature flag：`enableBrowserTabRecovery` / `tabRecovery` / `restoreShells` 在 `packages/**` 内 0 命中，不存在「打开就生效」的配置。
  3. UI 从不调用：`packages/ui` 内 `browserViewRestoreTabs` 0 命中；只有 `preload` 与 `client/globals.d.ts` 暴露了方法，没有调用方。
  4. INV 条款只约束进程内：`browserGuestManager` 的 INV-17/19/20 讲的是 suspend/restore/residency generation，没有一条声称「重启后恢复标签」。
  5. 单测用注入替身：`packages/desktop/test/browserGuestManager.test.ts` 有 10 处 `const recoveryStore = { ... }` 手工注入，测试通过只证明「注入后可用」，不证明生产可达。
- **反证（说明它曾按可用功能设计）**：`browserTabRecoveryStore.ts` 的 INV-03 写「windowBindingId 落盘必须恒为 null，进程重启后不认领旧窗口」，INV-09 写会话隔离，都是跨进程恢复才需要的约束；说明实现完成后被产品决策关闭，不是未完成品。
- **影响范围（含一处更正）**：跨进程部分全空——`listShells` 恒返回空、`restoreTabs` 恒返回 `[]`、`persistShell` / `persistRecoverySnapshot` 在首行判空处直接 `return`、`whenRecoveryIdle` 恒立即 resolve。**但「整个标签恢复子系统不生效」的说法是错的，此处更正**：`restoreGuestState` 在无 store 时 `getPageState` 得到 `undefined`，会跳过 pageState 校验并走到 `loadURL(cachedUrl)`，因此**进程内 suspend/resume 的 URL 恢复仍然可用**；真正缺失的只有跨进程落盘与多步历史（`navigationHistory.restore`）。用户可见表现是「关掉应用再打开，IAB 标签全没了」，而不是「应用内切走再切回也恢复不出来」。后续读者不得按「整个子系统都坏了」理解本条。
- **既有次级缺陷**：`whenRecoveryIdle` 的旧注释承诺「用 allSettled 等待所有恢复 flight」，即使将来注入 store 也不成立——`whenIdle` 只 `await this.mutationQueue`，不覆盖 `restoreSuspendedGuest` / `rebindGuest`。已按实际行为改写，并挂本条编号。
- **开启条件（四件齐备才算接线完成）**：① 在 `index.ts` 的 residency 选项注入一个真实的 `new BrowserTabRecoveryStore(path)`（并决定落盘路径与清理策略）；② 反转产品语义——「完整退出即清空」必须正式作废，否则恢复出的 shell 与自动重建的 webview 会重复 attach；③ renderer 启动时调用 `browserViewRestoreTabs` 并按返回的 shell 建标签（当前 0 调用方）；④ `whenRecoveryIdle` 改为同时等待 guest 恢复 flight，否则关闭流程的「无在途恢复」断言仍然不成立。
- **注释处理**：`restoreTabs` 入口、`persistShell` 入口、`BrowserTabRecoveryStore` 类头三处已各加一条整行 `[可达性]` 注释，写明「生产未注入、本函数恒空、以下分支不可达」；这不是注水，而是防止读者把不可达分支当成在跑的逻辑。

## D-9-5 CDP idle 超时后仍返回 teardown 成功（有意降级 INV-05）

**性质：有意降级，不是表述冲突，也不是新引入的行为缺陷。** INV-05 是意图契约，**原文一个字不改，继续被 gate 计为水位**。本条目登记的是实现主动放弃该契约严格保证的那个位置，以及放弃的边界。

- **位置**：`packages/desktop/src/main/browserView/browserGuestManager.ts:5117-5132`（`runGuestTeardown` 的超时分支）、`:5198-5213`（`waitForGuestCdpIdle`）、INV-05 定义 `:16-17`。
- **触发条件**：一条已下发的 CDP 命令永不 settle（renderer 卡死、`debugger.sendCommand` 的 Promise 不返回），且 `waitForGuestCdpIdle` 在 `DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS` 内没有等到 `pendingCdpCommands` 归零。
- **实际行为**：超时只 `warn`，随后照常走 `guest.debugger.detach()`；detach 确认成功时函数返回 `true`，调用方据此认为 teardown 成功并允许卸载 webview。
- **放弃的是什么**：INV-05 要求的「`pendingCdpCommands` 归零前不得宣称 teardown 成功」。返回 `true` 在此刻只证明 native CDP 已 detach，**不证明那些未结算的命令已经完成**。
- **换来的是什么**：`closeTab` 与 `attachGuest` 的替换路径不会因为一条永不返回的命令永久挂起，renderer 能卸载 webview、tab 能回收、waiter 能结算。若死守 INV-05 判负，泄漏的是整个 tab 生命周期，比这条保证更严重。
- **什么条件下变成真问题**：未结算的命令里含写操作（DOM 修改、表单提交、导航、输入注入）时，调用方会把「未结算」当成「页面已静止」，可能在新旧 guest 之间丢失或重复一次写入；纯读命令或查询不构成此风险，最坏只是丢掉一次观测结果。
- **判断依据**：`:5119-5123` 的 warn 分支之后没有任何 `return`；`:5163-5170` 在 detach 成功后无条件 `return true`；`:5096-5097` 的既有注释写明「等待 CDP 空闲有超时：底层命令可能永远不返回，不能让 closeTab 永久挂起」。
- **处理口径（不改代码、不改条款）**：INV-05 保持原文并继续作为水位；本条目只登记「这里主动降级」。不得用「改写条款去迎合实现」的方式消掉水位——那等于用注释给偏差发合格证。真正要修时，方向是让超时路径把「已尽力 detach」与「命令已结算」拆成两个返回值，而不是放宽 INV-05。

## D-9-6 已放弃的 CDP capture 不计入 captureActive

- **位置**：`packages/desktop/src/main/browserView/browserGuestManager.ts:4944-4952`（`isTabCaptureActive`）、`:4922-4933`（`refreshRuntimeProtection` 上报 `captureActive`）、`:2434-2504`（`settleScreenshotCapture` 在 abort/deadline 先胜时调 `abandonBackendCapture`）、`:2209-2226`（`clearTrackedScreenshot` 按 identity 移除 tracker）。
- **触发条件**：截图命令的 `settleScreenshotCapture` 先被 abort 或 hidden-window deadline 结算，底层 `Page.captureScreenshot` 仍在 Chromium 内 pending；`abandonBackendCapture` 已把该 tab 的 `abandonedScreenshotCaptures` 加 1，随后 `execution.then(clearTrackedScreenshot)` 把 `inFlightScreenshots` 里的 tracker 删掉。
- **实际行为**：`isTabCaptureActive` 只看 `inFlightScreenshots`、运行中的录制与 `guest.isBeingCaptured()`。标准截图走 CDP `Page.captureScreenshot`（`browserCommandPageHandlers.ts:329`），不是 `webContents.capturePage()`，`isBeingCaptured()` 对这条路径不成立；`abandonedScreenshotCaptures` 本身从未被任何保护判定读取。
- **后果**：`refreshRuntimeProtection` 上报 `captureActive:false`，`isBrowserTabResidencyProtected`（`browserTabResidencyPolicy.ts:38-54`）因此不再保护该 tab。tab 数达到上限时，一个仍有 1–3 条 pending capture 的 guest 可能被选为 LRU 受害者并 suspend/detach，pending 的 CDP 命令随即在销毁的 webContents 上失败，与 `:4942-4944` 注释「截图活跃包括已放弃但底层未结算」的承诺相反。
- **判断依据**：`isTabCaptureActive` 的 `return` 表达式只有三项，无 `abandonedScreenshotCaptures`；`abandonBackendCapture` 只写计数、不参与保护判定；最接近的 `isBeingCaptured()` 只覆盖归一化路径里的 `guest.capturePage()`，不覆盖 CDP 主路径。
- **处理口径（不改代码）**：修法是在 `isTabCaptureActive` 补 `(this.abandonedScreenshotCaptures.get(tab.tabId) ?? 0) > 0`，或抽一个「该 tab 是否有未结算 capture」的统一判定供上报与回收共用；本条目只登记，不改。

## D-9-7 光标 overlay 注入失败会中止录制，导航后不再重注入

- **位置**：`packages/desktop/src/main/browserView/browserGuestManager.ts:3169-3205`（`installRecordingCursorOverlay`）、调用点 `:2797`（`runRecording` 开头唯一一次）、动作分发 `:2892-3065`（全部分支无重新注入）。
- **触发条件**：① `options.showCursor !== false` 的录制里发生页面导航（`click` 命中链接等），旧 document 连同 overlay 一起销毁；② 起始页上下文不允许注入脚本（CSP、`about:blank` 过渡态），`guest.executeJavaScript` reject。
- **实际行为**：overlay 只在录制开始时注入一次；`executeRecordingActions` 的每个动作之前都没有补注入。`installRecordingCursorOverlay` 直接 `await guest.executeJavaScript(...)`，函数体内没有 try/catch。
- **后果**：① 导航后视频后半段没有光标动画，用户看到「鼠标消失」；② 注入抛错时整段录制落成 `failed`，而不是注释承诺的「只 warn，没有光标动画仍可完成录制」。
- **判断依据**：上方注释写「导航会丢 overlay，所以每次动作前都要确保它存在。注入失败只 warn」；`runRecording` 只在 `:2797` 调用一次，`executeRecordingAction` 全部分支无调用；相邻的 `removeRecordingCursorOverlay`（`:3208-3213`）显式 `.catch(() => undefined)`，注入侧没有对应处理。
- **处理口径（不改代码）**：修法是两条——在每次动作前（或监听导航完成）重注入，并给注入加 `.catch(warn)`；本批只登记，注释按意图原文保留并挂本条编号。

## D-9-8 abortRecordings 上方给出的两条取消理由都不成立

- **位置**：`packages/desktop/src/main/browserView/browserGuestManager.ts:2688-2702`（`abortRecordings` 注释与实现）、`:1840-1857`（`runRecording` 的 catch）、`:2829`（成功后写 `completed`）、`browserVideoRecorder.ts:92-97`（半成品删除）。
- **触发条件**：阅读取消路径的维护者按注释理解行为，或据此推断「取消后仍能拿到部分视频」。
- **实际行为**：`abortRecordings` 先 `controller.abort(...)`，再**同步** `setRecordingTerminal(entry, "cancelled")`；`runRecording` 之后的 catch 看到 `entry.status !== "running"` 直接 return。`recordBrowserVideo` 在 `completed === false` 时执行 `recorder.cancel()` 与 `rm(outputPath)`，半成品被主动删除。
- **后果**：注释说的两件事都不会发生——状态在本函数写定，部分 artifact 从不保存。按注释预期去读取消后的 `artifact` 会永远拿到空值。
- **判断依据**：`:2691` 的顺序注释与 `:1841` 的 `if (entry.status !== "running") return;` 共同证明状态不会由 `runRecording` 写回；`browserVideoRecorder.ts:92-97` 的注释写明「残留的 EBML 头看起来像视频但不可播放；必须同时关闭 recorder 并删除半成品」。
- **处理口径（不改代码）**：「不能直接删 entry」这半句仍成立（entry 要留着给 `recordingStatus` 查 TTL 内的终态），但原注释给的理由是错的；本批不改原文，只在此登记并在 `:2692-2693` 代码侧指路。

## D-9-9 legacy 关闭 tab 后重建会撞上自己的墓碑，该 scope 永久无法 attach

- **位置**：`packages/desktop/src/main/browserView/browserGuestManager.ts:3282-3285`（`resolveTab` 用 `context.sessionId` 作 preferredTabId）、`:3296-3302`（`createTab` 复用该 id 且不清理墓碑）、`:897-900`（`attachGuest` 对 `closedTabIds` 一律 fail closed）、`:3981`（`closeTab` 写墓碑）。
- **触发条件**：旧 renderer / string 上下文（`context.legacy === true`）隐式创建 tab → 用户关闭该 tab（`closedTabIds.add(sessionId)`）→ 任一无 tabId 的命令再次进入 `resolveTab`。
- **实际行为**：`resolveTab` 在 scope 内已无存活 tab 时调用 `createTab(context, context.sessionId, true)`，新 tab 的 tabId 正是墓碑记录的 sessionId；`createTab` 不 `closedTabIds.delete`，`attachGuest` 命中墓碑直接返回 `{ok:false, reason:"closed"}`，该分支注释明确「只拒绝、不清理」。
- **后果**：该 legacy scope 之后每次命令都在 attach 阶段失败，表现为 `backend_unavailable` 或持续空白 pane，直到进程重启或 `disposeAll` 清空墓碑（`:5465`）。
- **判断依据**：`:897` 的判定与 `:1344` / `:3981` 的写入共同构成「只增不清」；`createTab` 的复用条件是 `existing && lifecycle !== "closed"`，已关闭条目不满足，于是覆盖 `tabs` 条目但不动墓碑。
- **处理口径（不改代码）**：修法二选一——legacy 隐式创建不再复用 sessionId（改 UUID），或在 `createTab` 的新建路径显式 `closedTabIds.delete(tabId)` 并说明为何不破坏 INV-16；本批只登记。当前生产 renderer 是否仍走 string 上下文未确认，因此定为低。

## D-9-10 releaseToUser 注释承诺的 viewport 复位没有实现

- **位置**：`packages/desktop/src/main/browserView/browserGuestManager.ts:3535-3541`（`releaseToUser`）、`:3642-3650`（`readTabViewport` 的 `tab.active` 自愈）、`:3828-3832`（endTurn）、`:3915-3922`（closeSession）。
- **触发条件**：agent 在后台会话里给 tab 设了 `backgroundViewportFallback`，turn 结束或 session 关闭时该 tab 不在前台。
- **实际行为**：`releaseToUser` 只改 `owner`/`origin`/`claimable`/`lifecycle` 并清两个索引，不触碰 `backgroundViewportFallback`；两个调用方也不补。复位依赖 INV-22 的惰性路径：`readTabViewport` 在 `tab.active` 为真时调 `maybeRestoreBackgroundViewport`，或 `selectTab` / `reportResidency` 再次发生。
- **后果**：在「释放后既没有切前台、也没有再读 viewport」的窗口里，页面继续以 800×600 的 fallback 尺寸渲染，用户看到的窗口尺寸与页面布局不一致。
- **判断依据**：函数体内没有 `backgroundViewportFallback = undefined`、`resetTabViewport` 或 `restoreNaturalViewportAfterBackground` 调用；对比 `:4186-4190` 的 `resetTabViewport` 明确同时清 override 与 fallback。
- **处理口径（不改代码）**：修法是在 `releaseToUser` 末尾加 `this.maybeRestoreBackgroundViewport(tab)`（幂等且有串行队列）；本批只登记，注释原文保留并挂编号。

## D-9-11 closeSessionTabs 声称 allSettled，实际一条失败就中断后续关闭

- **位置**：`packages/desktop/src/main/browserView/browserGuestManager.ts:3967-3974`（`closeSessionTabs`）、`:4009-4030`（`closeTabDurably`）。
- **触发条件**：注入 `recoveryStore` 后，某次 `recoveryStore.remove` 因磁盘/权限/序列化错误 reject；或 `closeTabDurably` 内 `removeTabRecovery` 抛错。
- **实际行为**：循环是 `for (const tab of owned) await this.closeTabDurably(tab);`，没有 try/catch，也没有 `Promise.allSettled`；一旦某条 reject，循环终止，剩余 tab 既不在 registry 移除，也不释放 guest。
- **后果**：`closeSession({closeTabs:true})` 只关掉一部分 tab，其余 tab 的 guest 继续占用 renderer 配额，且对调用方表现为一个已 reject 的 promise（调用方通常只记日志）。
- **判断依据**：上方注释原文「用 Promise.allSettled：单个持久化删除失败不能让其它 tab 留在 registry 里」；`closeTabDurably` 的第一个 await 就是 `removeTabRecovery`，其注释也承认「存储失败只 warn」，但那条 catch 在 `removeTabRecovery` 内部，只在 `closeTabDurably` 的调用链上部分覆盖。
- **处理口径（不改代码）**：修法是改成 `await Promise.allSettled(owned.map((tab) => this.closeTabDurably(tab)))`，与注释一致；本批只登记。

## D-9-12 closeWindow 漏清 scope 级索引与可见性缓存

- **位置**：`packages/desktop/src/main/browserView/browserGuestManager.ts:3998-4003`（`closeWindow` 尾部）。
- **触发条件**：窗口关闭后 Electron 复用同一 `windowId`，且新窗口的 workspace/session 与上一轮相同（例如同一对话重新打开）。
- **实际行为**：`closeWindow` 清了 `naturalViewportByWindow`，也逐 tab 清了 residency/screenshot/tabs，但 `activeTabByScope`、`defaultTabByScope`、`sessionNames`、`visibilityByScope` 都按 `scopeKey` 保存，函数里没有对应 delete。
- **后果**：同 key 的新窗口第一次查询会读到上一轮的 active/default（多数被 lifecycle 校验收敛为「无 tab」，不会误发命令）与 `sessionNames`/`visibilityByScope`；后者会让面板在未上报可见性时直接显示上一轮的可见状态。
- **判断依据**：函数体末尾只有一处 delete；对比 `closeSession`（`:3937-3955`）逐项删了四个 scope 级 Map，并在注释里写明「若将来增加 session 级缓存，必须同步在此清理，避免同类泄漏」。
- **处理口径（不改代码）**：修法是按 `scopeKey` 删四个 Map（或抽 `clearScope(scopeKey)` 供 closeSession/closeWindow 共用）；因为窗口复用不常见且主要后果是可见性偏差，记为低 / B 档。

## D-9-13 collectMemoryDiagnostics 只回两类计数，与注释声称的四类不符

- **位置**：`packages/desktop/src/main/browserView/browserGuestManager.ts:5440-5447`（注释 `:5441-5442`，返回字面量 `:5446`）。
- **触发条件**：任何诊断采样路径调用 `collectMemoryDiagnostics`（资源管理器轮询、内存快照、单测断言）。
- **实际行为**：注释称「统计 tab/guest/waiter/recording 数量」，实现只返回 `{ tabs, closedTabIds }`；`guest`（有 guest 的 tab 数）、`waiter`（download waiter 数）、`recording`（在飞录制数）三项都不存在。
- **后果**：三类资源泄漏在诊断采样与看板里完全不可见，只能靠日志逐条排查；不改变业务状态，故列为 C 档（仅影响可观测性）。
- **判断依据**：函数体只有一个两项字面量，返回后未再合并其它 Map 的 size；同文件的 `guestRecoveryFlights`/`downloadWaiters`/`recordings` 都是现成的可计数集合。
- **处理口径（不改代码）**：补三个 `size` 即可（约 4 行），或把注释改成只描述两项；本批保留注释原文为水位，D-9-13 在代码处已加指路。

## D-10-1 手机上报的 activeWorkspaceKey 未校验存在性

- **位置**：`packages/desktop/src/main/webRemoteControlManager.ts:1057-1063`（`buildWorkspaceListResult`）。
- **触发条件**：手机通过 `mobileTaskView` 上报 `activeWorkspaceKey` 后，桌面端移除该项目、切换工作区同步列表，或 bridge 重连到不同的工作区集合。
- **后果**：返回的手机列表 `activeWorkspaceKey` 指向 `workspaces` 中不存在的 key，手机点开落到空目标；该悬空 key 还会计入列表签名，导致「签名不变时不推送」的逻辑持续把一个无法打开的选中项当成当前状态。
- **判断依据**：`activeWorkspaceKey` 的取值链是 `runtime.mobileViewState?.activeWorkspaceKey ?? initialViewState?... ?? resolveWebRemoteControlWorkspaceKey(...)`，没有任何 `workspaces.some(...)` 或等价校验。注释已在 `return` 上方标注该事实（D-10-1，待修）。

## D-10-2 stop() 无条件占用自动恢复名额

- **位置**：`packages/desktop/src/main/webRemoteControlManager.ts:2169-2170`（`stop`），`:500-502`（`startupRestoreClaimed` 语义），`:2254+`（`restorePreviouslyEnabled`）。
- **触发条件**：窗口 A 手动启动远控后再手动停止（未发生自动恢复），随后创建新窗口 B 并调用 `restorePreviouslyEnabled`。
- **后果**：`startupRestoreClaimed` 被置 `true` 且本进程内不再复位到「未认领」，窗口 B 的自动恢复直接返回 `false`；设置里仍为启用状态，但本次进程内不再恢复。
- **判断依据**：`stop()` 在 `lifecycleRevision += 1` 后无条件执行 `startupRestoreClaimed = true`，注释只解释代际自增，没有说明该赋值会消耗唯一名额；`restorePreviouslyEnabled` 的入口检查依赖同一标志。注释已在赋值后标注（D-10-2，待修）。

---

## D-11-1 showItemInFolder 抛错被当成导出失败

- **位置**：`packages/desktop/src/main/exportLogs.ts:1449-1464`（zip 分支的 `try`/`catch`）、`:1476-1490`（目录分支的 `try` 与最外层 `catch`）、注释在 `:1409`。
- **触发条件**：zip 写盘成功、`showItemInFolder(zipPath)` 调用抛错（依赖注入实现抛错，或 `import("electron")` 失败）；目录分支同理。
- **后果**：
  1. zip 分支：进入 `catch (zipError)`，执行 `rm(zipPath)`，已生成的有效 zip 被删除，转做目录导出；日志把原因记成「zip 导出失败」，掩盖真实错误。
  2. 目录分支：目录已经写成功，`showItemInFolder` 抛错落到最外层 `catch`，对外返回 `success:false`，调用方看到失败但磁盘上有完整目录。
- **判断依据**：`showItemInFolder` 与 `writeZip` / `writeLogArchiveDirectory` 共用同一个 `try`，catch 的语义是「导出失败」而非「展示失败」；`:1409` 的契约只描述了调用顺序，没有区分两种失败的归属。注释已挂 D-11-1。
- **修复方向（不在注释线）**：把 `showItemInFolder` 移出导出 `try`，或单独 `catch` 后只记日志，不影响 `success` 与产物。

## D-11-2 rollout 递归收集无体积上限

- **位置**：`packages/desktop/src/main/exportLogs.ts:1191-1196`（收集 `~/.zcode/cli/rollout`）、`:1333`（staging 复制）。
- **触发条件**：**可预期触发**——长期使用的机器上 `~/.zcode/cli/rollout` 累计到 GB 级；无需崩溃或异常输入。
- **后果**：`createLogArchiveArtifacts` 先完整收集，`writeLogArchiveZip` 再把整份 artifacts 复制到 staging 后压缩，导出期间磁盘峰值接近「源 + staging」两份；空间不足时 zip 失败，回退目录导出还要再复制一份，两次都可能因 ENOSPC 失败，用户拿不到任何日志。
- **判断依据**：`collectLogArchiveFilesFromDirectory(join(zcodeCliDir, "rollout"), ...)` 是递归收集，没有单文件大小或总量上限；`writeLogArchiveZip` 的实现是先 `writeLogArchiveDirectory(stagingDir)` 再 `collectLogArchiveFiles(stagingDir)`，复制是既定步骤（INV-16 要求先落 staging）。注释已在 `:1186` 挂 D-11-2。

---

## D-12-1 深链完整性用「存在」而非「有值」判定

- **位置**：`packages/desktop/src/main/desktopDeepLinkUrl.ts:227-245`（`isCompleteDeepLinkUrl` 的 `searchParams.has(...)`）、`:260-266`（`extractDeepLinkUrlFromArgs` 命中完整候选即返回）；注释在 `:219`。
- **触发条件**：外部程序或浏览器先传入 `zcode://oauth/callback?state=`（空值）作为候选，且同一次唤起里另有完整回调（argv 多个 URL，或 `buildArgCandidates` 拼接出的候选排在后面）；`?path=`、`?provider=&channel=&status=` 同理。
- **后果**：空值参数被当作「齐全」，该候选被判完整并立即 `return`，后面真正的完整候选被丢弃。OAuth 侧拿到空 `state` 校验失败，用户表现为点了「打开 ZCode」没有反应；工作区打开则拿到空 `path`，`extractWorkspaceOpenPath` 返回 `null`，同样静默失败。
- **判断依据**：`isCompleteDeepLinkUrl` 对四类回调分别用 `searchParams.has("state" / "path" / "provider" ...)` 判存在，空字符串 `?state=` 与有值 `?state=x` 在 `has` 下不可区分；`extractDeepLinkUrlFromArgs` 在 `:262` 的 `isCompleteDeepLinkUrl` 为真时直接返回，不再评估后续候选。
- **修复时注意（只记录，不在本线扩大）**：`expandDecodedDeepLinkCandidates` 的同类问题是「判存在 vs 判有值」，修 D-12-1 时一并核对是否共用同一套判据；本条不扩成独立缺陷。

---

## D-13-1 忙碌探测抛错让调度链停摆

- **位置**：`packages/desktop/src/main/desktopZCodeDataSizeTelemetry.ts:418-421`（`evaluateDueCollection` 入口的 `isZCodeBusy()`）；缺陷注释在 `:417`。
- **触发条件**：宿主注入的 `isZCodeBusy` 抛错（其内部读取会话状态失败）。`schedule` 以 `void callback()` 调用异步函数，拒绝无人接收。
- **后果**：`evaluateDueCollection` 的 Promise 变成未处理拒绝；同函数里的 `schedule(timing.idlePollMs)` 不会执行，调度链停摆到进程重启。INV-11 要求「任何空闲或忙碌探测抛错按不可采集处理」，但只覆盖了 `isPreferredIdleWindow` 与 `collectionEligibilityLost` 的 catch。
- **判断依据**：`:418` 的调用在 try 之外（内层 try 从 `collectAndReport` 的 `:339` 才开始）；`schedule` 在 `:246` 用 `void callback()` 丢弃拒绝。

## D-13-2 新旧实例共享状态文件的回滚覆盖

- **位置**：`:489-495`（`stop()` 同步返回，不等待在途采集）、`:516-517`（重新注册先停旧实例再建新实例）、`:306-316`（旧实例的 `rollbackReportReservation` 写同一个 `stateFile`）。
- **触发条件**：重新注册（窗口重建、工作区切换）恰好发生在旧实例「`reserveReport` 已落盘、`report` 尚未完成」的窗口内；旧实例被中止后在 `:352`、`:356`、`:363` 走回滚。
- **后果**：旧实例回滚写入 `previousState`，若新实例已经写入自己的预占，旧写入会把新预占覆盖掉，`rateLimitAnchor` 回退到更早的时间；进程随后重启时可能重发同一天样本，消耗上报配额。
- **判断依据**：`stop()` 没有返回 Promise，无法等待在途；`rollbackReportReservation` 没有「仅当状态仍等于本次预占才回滚」的条件，也没有实例世代号。

## D-13-3 成功时间落盘失败只降级告警

- **位置**：`:280-288`（`persistSuccess` 的 `catch` 只 `warn`，不重试也不抛出）。
- **触发条件**：`dependencies.writeState` 抛错（磁盘满、权限变化、目标文件被占用）。
- **后果**：成功时间未落盘，内存 `persistedState` 停在预占态；本次进程内不会重发，重启后限流锚点取 `reportReservedAt`，到期时刻比真实成功时间早若干秒。由于预占已在发送前落盘，这条不会导致重发，属 INV-05 允许的降级；记录为可观测性缺口（日志能看出，看板看不出成功态未持久化）。
- **判断依据**：`:282-287` 的 `nextState` 只在 `await writeState` 成功后才赋给 `persistedState`；`:367` 的 `persistSuccess` 返回后仍照常排 24 小时。

---

## D-14-1 `durations` 未做有限性校验

- **位置**：`packages/desktop/src/main/networkTelemetryAggregator.ts:287-288`（缺陷注释 + `bucket.durations.push`），对照 `:284` 的注释。
- **触发条件**：`ingestHostNetworkObservations` 把 Host 批量观测原样透传给 `recordNetworkObservation`；任一条 `durationMs` 为 `NaN` / `Infinity` / `null`（上游计算缺陷、反序列化异常或非有限值透传）。
- **后果**：非有限值进入 `bucket.durations`；`computeAggregateStats` 的求和变 `NaN`，该接口整桶 `mean` / `p95` / `peak` 一并失真。阶段耗时有 `pushIfPositive` 过滤，总时长没有。
- **判断依据**：`:288` 无条件 push；`:284` 的「异常输入由各字段自身过滤」对 `durations` 不成立——`pushIfPositive` 只用于 `stageTimings`。`:287` 的缺陷注释已写明这一点，避免读者把它当成全局保证。
- **分档**：只污染指标，不改变业务状态，归 C 档。

---

## D-15-1 output-style 写删方法路径逃逸

- **位置**：`packages/services/src/output-style/outputStyleService.ts:275-288`（`addStyle` 拼文件名与写入）、`:300-314`（`updateStyle`）、`:323-330`（`deleteStyle`）。
- **触发条件**：RPC 客户端（已配对 web-remote，或 server `/ws` 客户端）调用 `addStyle` / `updateStyle` / `deleteStyle`，并在 `config.name` 或 `id` 中放入 `../`（POSIX）或 `..\`（Windows）。不需要仓库内有调用点——参数直接来自远端。
- **后果**：`join(stylesDir, filename)` 会把 `..` 折叠到上层目录，写入/删除落到 `~/.claude/output-styles` 之外：
  - `addStyle { name: "../CLAUDE" }` → 写入 `../claude.md`（`:275` 会先转小写）：Windows/macOS 的大小写不敏感文件系统上覆盖 `~/.claude/CLAUDE.md`，Linux 上落到不同名的 `claude.md`。`../../..` 可继续上溯到用户目录或项目目录下的任意 `*.md`。写入内容 = 固定两行头（`name:`/`description:`）+ 调用方完全控制的 `config.content`。
  - `updateStyle { id: "custom-../../CLAUDE" }` → 同一路径可重复覆盖，且不要求文件已存在（`:312-314` 反而会重建被删文件）。
  - `deleteStyle { id: "custom-../../CLAUDE" }` → `rm(..., { force: true })` 删除任意可命中的 `*.md`。
  - `CLAUDE.md` / `AGENTS.md` 是 Agent 启动时读取的指令文件，覆盖它们等于远端提示词注入，可间接影响后续工具调用。
- **判断依据**：
  - `addStyle` 的文件名只做 `toLowerCase().replace(/\s+/g, "-")`（`:275`），没有剥离 `..`、`/`、`\`、盘符或 UNC；`updateStyle` / `deleteStyle` 只剥离可选的 `custom-` 前缀（`:300`、`:323`），其余原样进入文件名。
  - 三处都直接用 `join`（`:277`、`:304`、`:326`），没有 `resolve` + 根目录前缀校验；本文件也没有 server 侧 `isInsideDirectory` 那类工具。
  - 实测（Windows）：`path.join("C:\\Users\\u\\.claude\\output-styles", "..\\..\\evil.md")` → `C:\Users\u\evil.md`；POSIX 的 `../../evil.md` 同理。
  - 边界：文件名恒以 `.md` 结尾，不能覆盖 `.json` / `.sh` / `authorized_keys`；UNC 与盘符绝对路径经 `join` 只会在 base 下拼出异常段，不重置根，因此主要向量是 `..` 与分隔符。`addStyle` 用 `/` 产生子目录时若父目录不存在会 ENOENT，不构成逃逸。
- **最小修复方案（未落盘，2026-11-09，约 12 行）**：

```ts
// 顶部新增
import { resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

function assertSafeStyleId(id: string): string {
  if (!id || id === "." || id === ".." || id.includes("..") || /[/\\\0:]/.test(id)) {
    throw new Error("invalid output style id");
  }
  return id;
}

function resolveStyleFile(stylesDir: string, id: string): string {
  const root = resolve(stylesDir);
  const file = resolve(root, `${assertSafeStyleId(id)}.md`);
  if (!file.startsWith(root + sep)) throw new Error("invalid output style id");
  return file;
}
```

  - `addStyle`：`const baseId = assertSafeStyleId(config.name.toLowerCase().replace(/\s+/g, "-"));`，再用 `resolveStyleFile(stylesDir, baseId)` 替换现有 `join(stylesDir, filename)`。
  - `updateStyle` / `deleteStyle`：`const baseId = assertSafeStyleId(id.startsWith("custom-") ? id.slice(7) : id);`，同样替换 `join`。
  - `deleteStyle` 在 `rm` 前补真实路径复核：`await realpath(filePath)` 后再次 `startsWith(resolve(stylesDir) + sep)`；`ENOENT` 视为可 `force` 删除，其他错误原样抛出。用 `realpath` 而非 `stat`，否则目录内的符号链接仍可指向根外。
  - 行为变化：含 `/`、`\`、`..`、`:` 的 id/名称被拒绝（现有正常 id 均不含这些字符，无需迁移）；写入路径若目标是既有符号链接，建议同时 `lstat` 拒绝（本地预置链接才会命中，非远端直接可达）。
- **分档**：A 档（远端 RPC 参数直达），级别高。

---

## D-15-2 server 模式整面服务暴露且默认无鉴权

- **位置**：`packages/server/src/http.ts:184`（`services.exposeOnChannelServer(server, overrides)` 无过滤）、`:420-428`（token 可选，未配置时整条中间件不注册）、`:171-180`（唯一拒绝覆盖）、`:448-465`（`/ws` 固定 `web-remote-replayable`）；`packages/server/src/entry-http.ts:17-20`（默认端口 3030、host 可选、token 可选）、`:28`（provisioning 开关取决于 token）、`:39`（仅 token 存在时传 `authToken`）；`packages/services/src/node.ts:3074-3502`（`createLocalServices` 注册全集）。
- **部署形态**：`packages/server` 的独立 HTTP 入口 `dist/entry-http.js`，**显式启动**才存在（`pnpm dev`、`node dist/entry-http.js`、Docker 镜像、ZCode Lite / 自建 server）。桌面端不会自动拉起它——**装了桌面端不等于有这个洞**；受影响的只有显式部署 server 的场景。
- **监听实测（2026-11-09，Node v26.7.0）**：不传 hostname 时 `server.address()` = `{"address":"::","family":"IPv6"}`，同进程 `netstat -ano` 同时出现 `TCP 0.0.0.0:31337 LISTENING` 与 `TCP [::]:31337 LISTENING`——**确认是双栈全网卡，不是从文档推的**。`@hono/node-server/dist/index.js:690` 亦为 `server.listen(port, options.hostname)`，`hostname` 透传 `undefined`。因此默认部署在「同网段可达」之外，端口映射到公网时即为「公网可达」。
- **Docker / 部署文档（2026-11-09）**：本仓库没有 web-app 的 `Dockerfile` 或 compose，`docs/web-app-docker-image.md` 只是镜像规格说明（`:41` 「runtime 阶段只暴露一个端口，默认 3030」、`:55-67` 只给 `pnpm docker:run:web-app` 与 `http://localhost:3030/`），全程**未提 `ZCODE_SERVER_AUTH_TOKEN`**；`:20` 只写镜像内跑 `@zcode/server entry-http`。`ZCODE_SERVER_AUTH_TOKEN` 在 `docs/remote/provider-provisioning.md:274` 仅作为「开放受信 Desktop Host」的开关出现。结论：**仓库内没有 `-p 3030:3030` 的官方引导，但也没有任何 token 引导**；不能断言官方让用户部署成无鉴权，也不能说官方提示过鉴权。
- **谁能连**：`ZCODE_SERVER_AUTH_TOKEN` 未配置时 `if (authToken)` 为假，鉴权中间件整条不注册（`http.ts:420-428`，文件内 INV-02 自述这一行为）。`host` 未配置时 `serve({ hostname: undefined })`，`@hono/node-server` 落到 `server.listen(port, undefined)`，Node 默认绑定所有网卡（`::`），因此**同网段或端口映射暴露到公网的任何人都能建立 `/ws`**。配置 token 后只做等值比较（Authorization / query / Cookie，`:303-322`），没有账号、角色或设备概念；token 泄漏即等于整面服务失守。
- **暴露面**：`createServerHostServices` → `createLocalServices` 注册的全部频道，经 `:184` 一次性暴露给 `/ws`。**唯一的拒绝覆盖**是 `IProviderProvisioningTargetService`（`:171-180`，仅当该服务已注册时），而 `entry-http.ts:28` 又把 `providerProvisioningTargetEnabled` 设为 `Boolean(authToken)`——未配 token 时该服务根本不存在，这条拒绝在「默认无鉴权」场景下等于空操作。`IZCodeAgentService` 在 `:162-164` 被 connectionScope 包装，是作用域限定，不是拒绝。
- **写 / 凭据相关频道与方法**（`/ws` 客户端均可直接调用）：
  - `Terminal`：`create`（起 PTY shell）、`write`（执行任意命令）、`dispose`——等价远端命令执行。
  - `File`：`readTextFile` / `readFileRange` / `readBinaryPreview` / `readMediaPreview` / `readdir` / `stat` / `resolvePath` 接收任意路径、无根目录限制（只有大小上限，`fileService.ts` INV-01），可读 `~/.ssh/id_rsa`、`~/.claude/*`、`/etc/passwd`；`writeWorkspaceFileSearchIgnore` 可写 `.zcodeignore`。
  - `Credential`：`load`（读凭据明文，如 `zcodejwttoken`）、`save`、`delete`。
  - `OAuth`：`startOAuth`、`startOAuthWithPolling`、`logout`、`logoutAll`、`restoreSession`。
  - `Setting`：`update`（任意 `AppSettings` 字段）、`updateDataBaseDir`（搬移数据目录）。
  - `ProviderSettings`：`createPersonalProvider`、`savePersonalProviderOverlay`、`deletePersonalProvider`、`addPersonalModel`、`deletePersonalModel`、`savePersonalModelDraft`——可改 provider endpoint 与模型配置。
  - `Hooks`：`saveHooks`（写 hooks 配置）、`grantWorkspaceHookTrust`（预信任任意 hook bundle，后续执行 hook 命令）。
  - `Memory`：`saveMemory`、`clearMemory`。
  - `Skills`：`setEnabled`、`copyToCommon`、`removeFromCommon`、`deleteSkill`。
  - `Plugins`：`installPlugin`、`uninstallPlugin`、`setPluginEnabled`、`addMarketplace`、`updateMarketplace`、`removeMarketplace`。
  - `PluginSync`：`importPluginsArchive`、`importMarketplaceSourceArchive`（导入任意插件包）。
  - `SkillSync`：`importSkillsArchive`；`McpSync`：`saveMcpToUserDirectory`、`importMcpServers`（可写入并拉起任意 MCP 命令）。
  - `Bots`：`saveConfig`、`saveBot`、`deleteBot`、`removeBotSecret`、`beginFeishuRegistration`。
  - `OutputStyle`：`setActiveStyle`、`addStyle`、`updateStyle`、`deleteStyle`（D-03 / D-15-1 的通道入口）。
  - `SourceServerWorkspace`：`resolveWorkspace`、`retryWorkspaceMigration`、`abandonFailedWorkspace`（搬移/清理目录）。
  - `PromptAttachmentTransfer`：`stage`、`adopt`、`cancel`、`cleanup`（按入参路径暂存文件）。
- **后果**：默认部署（未配 token）下，任何可达 `3030` 的一方获得远端命令执行、任意文件读、凭据读写、插件/hook/MCP 安装能力；这不是单条服务的缺陷，而是「服务面默认可见」的架构问题，D-03、D-15-1 都只是这个面上的点。
- **判断依据**：`:184` 无任何过滤；`packages/rpc/src/channelServer.ts:165-175` 分发前无授权钩子，全目录 `authorize|principal|permission|role` 零命中；`entry-http.ts:17-20` 三个环境变量全部可选；`:420-428` 是唯一的鉴权开关。
- **最小修复方案（未落盘，2026-11-09）**：
  1. **默认绑定回环**：`http.ts` 的 `serve({ hostname: options.host })` 改为 `hostname: options.host ?? "127.0.0.1"`（一行）。`entry-http.ts:18` 保留 env 覆盖。收益最大，且让「忘记配 host」从危险默认变成安全默认。
  2. **无 token 的处理二选一**：
     - **A（推荐）**：`entry-http.ts` 在读到空 token 时直接 `throw`，不再静默跳过鉴权中间件。最安全，但本机浏览器也必须带 token；需 UI 支持 `?token=` 或 Cookie。
     - **B（让步）**：无 token 时强制 `host = "127.0.0.1"` 并 warn。保留零配置本地体验，但 loopback 不等于安全：任意网页都能连 `ws://127.0.0.1:3030/ws`（WebSocket 不受 CORS 限制），白名单里只要还有 File/Credential 就仍可被本机恶意页面利用。选 B 必须同时做第 3 步。
  3. **服务面白名单**：不新造列表，直接复用 `WEB_REMOTE_REPLAYABLE_ALLOWED_CHANNELS`（`windowHostAttachmentRpcPolicy.ts:34-85`）。该集合已排除 `Terminal` 与 `ProviderProvisioningTarget`，注释 `:31-33` 与 `:103-105` 明确它是 fail-closed、经审阅的手机可用面，足以支撑 web 客户端主要功能。落地方式：把常量提升到 `packages/shared`（或 `packages/services`），server 侧改成 `services.exposeOnChannelServer(server, overrides, { allowedChannels })`。`Terminal` / `ProviderProvisioningTarget` 永远默认关闭；`File` / `Credential` / `OAuth` 等登录与文件浏览必需项保留，但仅在「已配 token」时开放；额外的高危项通过 `ZCODE_SERVER_ALLOW_CHANNELS=Terminal,...` 显式开启并打 warn。
  4. **行为变化与破坏性**：① 默认绑定回环后，所有依赖「不配 host 就能跨机访问」的部署会连不上，Docker 必须 `-p 127.0.0.1:3030:3030` 或显式 `ZCODE_SERVER_HOST=0.0.0.0`；② 选 A 时，现有未配 token 的部署**启动失败**，需要在启动脚本补 token 并让 web 客户端携带；③ 选 B 时跨机访问失效、本机功能保留，但仍建议配 token；④ 白名单上线后，若 Lite 的 web UI 需要终端面板，必须显式 opt-in，文件浏览与登录不受影响。
- **分档**：A 档（网络对端直接可达），级别高；修复应先于单点缺陷。

---

## D-31 关于窗口无单例，重复触发会叠窗

- **位置**：`packages/desktop/src/main/about.ts:315-334`（`showAboutDialog` 内的 `new BrowserWindow`）。
- **入口**：`desktopApplicationMenu.ts:179`、`:340`、`desktopTray.ts:154` 都经 `desktopCommandHandlers.ts:747-748` 调 `showAboutDialog`。
- **触发条件**：两次调用在首个窗口构造完成前先后进入。`:298` 的 `await import("electron")` 让快速连点都能穿过；代码里没有单例变量，也没有在途标记。`modal` 只阻塞父窗口，不阻塞托盘与 macOS 全局菜单。
- **后果**：叠出多个关于窗口，每个都独立监听 `ready-to-show` 与 `closed`，用户必须逐个关闭。
- **判断依据**：INV-01 要求「不存在并发创建」，实现没有提供互斥。这不是需要补限定的措辞问题，而是实现偏离契约。
- **与 INV-01 的关系**：按「条款正确、实现偏离」处理——INV-01 原文一个字不改，只在构造处标注实际行为并挂本编号；`zc-gate` 继续把 `about.ts:1` 计为水位，作为缺陷的可见标记。
- **分档**：B 档（依赖快速重复触发这一运行态时序，非单次外部输入，非安全）。

---

## D-16-1 能力凭据只用 id、不绑调用方身份（根因 + 落点）

- **总表编号**：`DEFECTS-MASTER.md` 主表第 **73** 位（`| 73 | ZCode | D-16-1 |`）。用户 2026-11-10 转达时为第 69 位，总表在多条落表后已重排，**以文件当前编号为准**；两边寻址按 ID `D-16-1` 而不是按行号。
- **根因**：`browserGuestManager` 的部分公开能力把「拿到 id」当作「有权操作」，入参里没有调用方身份，也没有反查该对象是否属于调用方。这与 `packages/rpc/src` 的「通道层没有授权层」同族：校验的是对象存在性，不是调用者与被调对象的关系。
- **为什么 id 不能当凭据**：`webContents.id` 是进程内自增整数，同一窗口连续开 webview 时单调增长，遍历或在已知值附近试探的成本都很低；`tabId` 虽为 UUID，但会出现在 renderer 的 tab 列表与日志里，不是秘密。
- **可达落点**：

| 落点 | 入参 | 校验现状 | 后果 |
| --- | --- | --- | --- |
| `attachGuest`（`:864`、`:885-891`、`:1101-1115`） | `webContentsId` | 只判 `getType()=="webview"` | 把别的窗口/会话的 guest 挂到自己 tab，共享其 CDP：可读页面、注入脚本、导航；任一方 detach 会打断另一方 |
| `restoreTabs`（`browserGuestManager` 的 `listShells` 调用） | `workspaceKey` / `sessionId` / `remoteSessionId` | IPC 只把 `windowId` 覆盖成 `win.id`，三个作用域字段原样取 payload，只过 `nonEmptyStringSchema`（`desktopBrowserViewIpc.ts:309-320`） | 任一 renderer 可请求其它工作区的 shell，把其 URL/title 恢复进当前窗口并回传；跨工作区信息泄露，且这些 tabId 被本窗口 registry 占住 |

- **潜伏落点（当前零调用方，接入即同类）**：

| 方法 | 入参 | 现状 | 接入后的后果 |
| --- | --- | --- | --- |
| `detach(key)` | `tabId` | 直接 `detachGuest`，无 owner 比对 | 任一 renderer 可强制断开别人 tab 的 CDP |
| `hasGuest(key)` | `tabId` | 只回布尔 | 可枚举哪些 tab 有活 guest，为其它落点提供目标 |
| `getTabOwner(tabId)` | `tabId` | 直接返回 owner | 泄露任意 tab 的 workspaceKey/sessionId/remoteSessionId |
| `closeWindow(windowId)` | `windowId` | 无调用方比对 | 关闭任意窗口的 tab 集合（当前仅 `win.id` 内部调用） |

- **已核排除（同一线索下确认安全）**：
  - `execute` / `claimTab` / `requireRendererOwnedTab`：走 `sameScope` 或 `windowId + workspaceKey + sessionId` 比对，id 只是查找键。
  - `toControlledView`：闭包捕获 guest 对象并逐调用断言 generation，id 复用无法改道。
  - `detachGuestBeforeReplacement`：同时校验 `windowId` 与 `guest.id === tab.guest.id`。
  - `acknowledgeSuspend` / `attachGuest` 的 `windowId`：IPC 层统一覆盖为 `win.id`（`desktopBrowserViewIpc.ts:172`、`:237`、`:260`、`:279`、`:291`、`:319`），不可伪造。
- **修复方向（一处根因，不是四处补丁）**：给 manager 加一个统一入口 `assertGuestBelongsTo(guestId, senderWindowId)`：`guest.hostWebContents?.id === senderWindowId` 且该 guest 未被其它 tab 占用；`detach`/`hasGuest`/`getTabOwner` 在对外开放前必须走 `requireRendererOwnedTab`。约 15–20 行，接口不改。
- **分档**：A 档（renderer 经 IPC 直接触发）。未配远程通道时利用者仍是本地 renderer，故定中而非高；若将来 `detach`/`getTabOwner` 暴露到 IPC，严重度上调。

---

## 核对后排除（同批候选，但代码路径证明不是缺陷）

| 候选 | 核对结论 | 依据 |
| --- | --- | --- |
| `setting/settingsWriteQueue.ts` 超时后旧写继续落盘 | 不是缺陷。超时递增 generation，`runUpdate` 在 rename 前通过 `shouldCommit` 复查，作废后不会提交。 | `expireCurrentWrite` 递增代数；`beforeRename` 抛出即放弃临时文件。 |
| `project-storage/default-workspace/migration.ts` 两条 UPDATE 依赖外层事务 | 不是缺陷。迁移 runner 用 `BEGIN IMMEDIATE ... COMMIT` 包住 `apply` 回调，中间态不会自动提交落盘。 | `packages/shared/src/sqlite-migrations/runner.ts` 的事务边界。 |
| `gitCheckpointStore` 先写 temp 再 rename | 不是缺陷。目标文件在 rename 前始终是上一份完整元数据，崩溃只会留下可回收的 temp。 | `writeManifestAtomic` 的顺序；`save` 先 `mkdir`。 |
| `subagentMarkdown` frontmatter 回写 | 本文件没有 `writeFile`，持久化不在该模块，未发现同批写入缺陷。 | 全文件无文件写入调用。 |

## 与注释线的关系

- 本清单中的 D-01、D-02、D-03、D-07 已在对应函数的注释里写明触发条件与后果，注释只做说明，不改变行为。
- D-7-* 与 D-8-* 的注释已在 desktop 两个文件里落地：`autoUpdater.ts` 写清 ack 的信任边界（D-7-1/D-7-2）与
  `setFeedURL` 无白名单（D-7-3），`desktopStabilityTelemetry.ts` 写清 `duration_ms` 的起算点（D-8-1）
  与回退 `main` 与 INV-19 的冲突（D-8-2）。
- **注释不给缺陷洗白**：D-8-2 的写法是保留 INV-19 原文不动，在回退分支上方标注「与 INV-19 冲突、待修」，
  没有把回退 `main` 写成「设计如此」；D-8-1 写成「由事件到达时刻起算」，没有写成「从卡顿开始计时」。
- D-04 的现有注释（`automationRepo.ts:1724`）写的是「不会重复派发」，与 D-04 的触发条件冲突；该行属于本线新增注释，修复缺陷时应同步改写，而不是再追加一句更正。
- D-9-1 ~ D-9-3 同样按「写实际行为 + 挂编号」处理：`2377` 改成「closeTab 直接 delete」，并在同一句点名与 `2384`、`closeTab` 的 delete 一致（D-9-3）；
  `2851` 改成「直接抛错、整段录制中止」，并说明这是签名非空 + 调用点直接取 `point.x` 的结果（D-9-2）；
  `hasRunningRequestForTab` 的注释与本批无关，保持原样，等代码线修 D-9-1 时一起改。
- D-10-1 / D-10-2 同样只写事实并挂编号：`buildWorkspaceListResult` 的注释写明「key 直接来自手机上报、未在 workspaces 中校验」，`stop()` 的注释写明「手动停止也消耗唯一名额」；两处都没有「正常情况下不会发生」的兜底措辞。
- D-15-1 / D-15-2 按本轮指令**只入清单，未加注释、未改代码**；两者的共同根因（`packages/rpc/src` 无授权概念）也不在本注释线批次内。D-15-2 的修复会改变 `packages/server` 的默认部署语义，必须单独评审。
- D-31 按「条款正确、实现偏离」处理：`about.ts:1` 的 INV-01 原文未改，只在 `:314` 窗口构造处写明「无单例、无在途互斥，三个入口可叠出多个关于窗口」。gate 继续把 `:1` 计为水位，这是缺陷的可见标记，不是待清理的注水。
- D-11-1 / D-11-2 只写事实并挂编号：`showItemInFolder` 的契约行写明「与导出同处一个 try，自身抛错会被当作导出失败处理」；`rollout` 收集处写明「递归收集且无体积上限，staging 让磁盘峰值接近翻倍」。D-11-2 在索引里标为「可预期触发」，不写成理论风险。
- 修复任一条目都会改变代码 token，必须单独开批次，不能混入注释线的 `zc-verify` 基线。
