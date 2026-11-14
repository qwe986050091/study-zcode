# ZC-DEEP：packages/desktop/src/main/index.ts

> 状态：**已完成**（b1–b15，1,355 单元全覆盖，五道门禁全零）
> 文件规模：原始 3,182 行 + 已插入 1,032 行 = 当前 4,214 行 / **1,355 可注单元** / 起始 323 covered（23.8%）/ 收口 100.0%
> 风险档：A（不可逆证据优先组）
> 口径：`deep-quality.mjs --metric-version v3`；批次目录 `_annot_baseline/IDX-deep-b01/`

## 1. 批次清单

§2.7 成为不变量后（`_ssh-insert.mjs` 单锚点单行 + `commentAbove` 一条注释计一个单元），`Δuncovered = −插入行数` 是**构造保证**，不再是测量；Δ 列恒真，已从表中删除。

**b1–b15 期间 §2.7 不变量未被破坏，无一批回滚。** 任何一批出现不等，该批作废、查锚点、不得提交。

| 批次 | 区域（原行号） | 插入行数 | 落盘后 UNCOVERED | 提交 |
| --- | --- | ---: | ---: | --- |
| b1 | 3089–3182 退出/窗口清理 | 29 | 1,003 | `78c1e2f9` |
| b2 | 2800–2964 IPC 注册表、语言广播 | 79 | 924 | `3a9c4fac` |
| b3 | 2600–2797 启动配置、托盘、更新 | 67 | 857 | `c00a33dc` |
| b4 | 2965–3088 补漏（b1/b2 之间的空档） | 52 | 805 | `3d84a485` |
| b5 | 2400–2599 open-url、单实例锁、启动配置读入 | 76 | 729 | `8de73f62` |
| b6 | 2200–2399 更新状态窗口、createWindowInstance 注入 | 83 | 646 | `7c5ae36e` |
| b7 | 2000–2199 更新状态窗口创建、布局与显隐 | 92 | 554 | `63cea69d` |
| b8 | 1800–1999 退出确认、桌面命令入口、快捷键录制态、菜单重建 | 79 | 475 | `976a19a4` |
| b9 | 1600–1799 E2E 强制退出、命令超时包装、Windows 更新前清理 | 70 | 405 | `f522d213` |
| b10 | 1400–1599 设置即时同步、自动更新偏好、退出屏障准备 | 47 | 358 | `8fa6027d` |
| b11 | 1200–1399 远控管理器装配、强制升级拦截、主窗口协调器 | 87 | 271 | `b15269f5` |
| b12 | 1000–1199 遥测上下文、窗口焦点事件、远程会话与灰度 rollout 装配 | 64 | 207 | `5c2452e6` |
| b13 | 800–999 退出标志、窗口映射表、cron 转发、更新窗口常量、遥测核心装配 | 57 | 150 | `2e6fc09b` |
| b14 | 600–799 browser 命令包装、内存诊断注册、运行时环境准备 | 60 | 90 | `4afb642f` |
| b15 | 336–599 启动装配层逐条（§2.9 逐条模式首批） | 90 | 0 | `65d659a1` |

**合计插入 1,032 行**（= 新增覆盖单元 1,032 个，见 §2）。

**空档事故记录（b4 由来）**：b1 从 3089 起、b2 到 2964 止，中间 2965–3088 被跳过。倒序只保证行号不失效，不保证区间连续——这是 §2.7 之外的第二类漏法。b4 专门回补，52 单元。后续批次必须**先取当批的最高未覆盖行号**再定边界，不能凭上一批的区间接续。
**提交说明误写**：b1、b2 的 commit message 写了「覆盖 1055/1355」「覆盖 1234/1355」，真实为 352、431——插入行数被当成覆盖数。按 DEEP-SPEC §2.8，不追改历史，记在此处。b3 起已改为「文件 + 批次 + 区域 + 插行数」。

## 2. 单元最终归属分布（收口时必填，此处为进行中快照）

| 归属 | 数量 | 占比 | 说明 |
| --- | ---: | ---: | --- |
| 已写注释（新增） | 1,032 | 76.2% | b1–b15 共插入 1,032 行，与新增覆盖单元数相等 |
| 起始已是上游注释 | 323 | 23.8% | orig 快照内已有，按 §2.6 只新增不改写 |
| 豁免 | 0 | 0% | 结构不可注的 91 条属「非单元行」（import 47 / structural 11 / continuation 33），不计入单元分母 |
| 未覆盖 | 0 | 0% | `UNCOVERED units=0` |
| **合计** | 1,355 | 100% | `mappedStrict=1355`，覆盖率 100.0% |

豁免类别取自工具 `MAP reasons`：`import`（47）、`structural`（11）、`continuation`（33）——这些是**结构性不可注**，不是「不想写」。收口时按类别逐条列出，不接受一个总数。

## 3. 文件内分段表

主进程入口，后来的人查「某个 IPC 通道在哪注册」会先来这里。行号为插入完成后的当前值（3,182 + 1,032 = 4,214 行）。

| 行号（当前） | 段 | 内容 |
| --- | --- | --- |
| 1–336 | 模块导入 | 约 60 个 import：electron、服务层、autoUpdater、tray、browserGuest、remoteSession、webRemoteControl |
| 337–418 | 协议与启动路径 | `registerLocalMediaPreviewScheme`、`remote-debugging-port` 固定 9229、`app.setName` / `setPath`、`process.title`、`unhandledRejection`、`iconPath` 四象限 |
| 419–497 | 模块级状态 | `currentApplicationLocale` / `closeToTrayOnWindows` / `desktopTrayReady`、`closeToTrayCapabilityMonitor`、`reconcileKeepAwakeBlocker`、`embeddedBrowserDialogController`、**IPC：EmbeddedBrowserJavaScriptDialog** |
| 498–708 | 内置浏览器 | `browserScreenshotSurfaceCoordinator`、`BrowserGuestManager`（owner 定向投递）、截图缩放、residency 回调 |
| 709–833 | browser 命令执行 | `runBrowserCommandOnView`：参数收窄、`workspaceKey` 优先级、操作指示补发、对话框抑制 |
| 834–889 | 窗口与诊断状态 | `currentDesktopZoomLevel` / `currentDesktopWindowSize`、`preloadPath` / `settingsFile`、退出策略、`BroadcastHub` / `TaskRealtimeBus`、内存诊断注册 |
| 890–977 | 运行时环境 | `createRuntimeProcessEnvPreparation` / `takeRuntimeProcessEnvPreparation`：同步 fallback + 异步登录 shell |
| 978–1068 | 窗口与 Host 映射 | 三个退出标志、`windowWorkspaceMap` / `windowUnreadCountMap` / `windowHostProcessMap`、`cuaPipFocusRouter`、cron 转发与唤醒、`disposingHostProcessTimers` |
| 1069–1100 | 远控与服务单例 | `webRemoteControlManagerRef`、`updateStatusWindow` 与三档高度常量、`mainSettingService` / 两个 `createCredentialService` / `appLaunchGate` / `appLaunchCoordinator` |
| 1101–1205 | 端点与灰度 | `resolveCurrentZCodeEndpointOrigin`、`desktopContextPromptRollout`、`awaitFirstHostSpawnDecision`、`appTelemetryCore` / `appTelemetryRuntime` |
| 1206–1244 | 遥测交互态 | `reportRemoteUsageEventForRenderer`、`syncAppTelemetryInteractiveState` |
| 1245–1271 | 窗口焦点事件 | `browser-window-focus` / `browser-window-blur` / `browser-window-created` |
| 1272–1394 | 远控装配 | `remoteSessionManager`、`webRemoteControlSharedHostAttachments`、`deviceMid`、`readHelpConfig`、`electronClientConfigsFetcher`、`rendererActionTraceRollout`、**IPC：ReportLocalTtftBatch** |
| 1395–1729 | deep link 与启动请求 | `extractOpenWorkspacePathFromDeepLinkUrl`、`startupOpenWorkspaceRequest` 一次性消费、`focusForceUpdateGateWindow`、`resolveExternalWorkspaceConfirmationCopy` |
| 1730–1844 | 退出标记与设置同步 | `markForceQuit` / `markExplicitQuit` / `syncCloseToTrayOnWindows` / `syncImmediateAppSettings`、自动更新偏好读写 |
| 1845–1989 | **退出屏障** | `prepareAppQuit`：in-flight 共享、固化 shutdown policy、停采样 → 停调度器 → flush 遥测 → 回收 Host |
| 1990–2031 | 放行退出 | `exitPreparedApp`：E2E 覆盖率 flush 与分平台强制退出 |
| 2032–2309 | agent 进程 | `getRunningAgentSessionCount`、`delay`、`execWithTimeout`、`forceTerminateWindowsAgentProcesses`、Windows 资源锁诊断、`prepareWindowsProcessesForUpdateInstall` |
| 2310–2451 | 退出确认 | `shouldConfirmAppQuit`、`dialogOptions` 与 `showMessageBoxSync` |
| 2452–2516 | 命令与快捷键 | `handleZCodeEndpointChanged`、`setShortcutRecordingActive` 与 owner 复位 |
| 2517–2932 | 菜单与更新窗 | `rebuildMenu`、`getApplicationWindowsExcludingCuaIndicator`、`resolveFocusedDesktopZoomLevel`、更新状态窗口创建/布局/关闭策略 |
| 2933–3160 | 主窗口 | `createWindowInstance`：Host 注入、窗口事件、关闭裁决 |
| 3161–3268 | 外部入口 | `app.on("open-url")`、`app.on("second-instance")` |
| 3269–4130 | **启动主链路 + IPC 注册** | `app.whenReady`：单实例锁 → 数据库门 → 平台集成 → 网络/权限 → 自动更新 → 平台/远控/追踪/堆采样 IPC → 遥测 → 强制升级 gate → 首窗 |
| 4131–4144 | 窗口全部关闭 | `window-all-closed`：按平台与托盘能力决定是否 quit |
| 4145–4210 | 退出前 | `before-quit`：首次 `preventDefault`，等 `prepareAppQuit` |
| 4211–4214 | 激活 | `activate`：Dock 点击重建主窗口 |

**IPC 通道索引**（注册点 → 通道）：

| 注册位置 | 形式 | 通道 / 内容 |
| --- | --- | --- |
| 484 | `ipcMain.on` | `PlatformChannels.EmbeddedBrowserJavaScriptDialog`（同步 `sendSync` 语义，禁止 await） |
| 1355 | `ipcMain.on` | `PlatformChannels.ReportLocalTtftBatch` |
| 3623 | `registerPlatformIpcHandlers` | 平台域：`attachBrowserGuest` / `updateBrowserGuestViewport` / `reportBrowserScreenshotSurfaceReady` / `browserViewResidencyHandlers` / 托盘 / 窗口能力 |
| 3825 | `registerRendererActionTraceIpc` | renderer 行为追踪（返回 dispose） |
| 3836 | `registerRemoteIpcHandlers` | 远程会话与 web remote control |
| 3973 | `registerRendererHeapSampleIpc` | renderer 堆采样请求 |

main → renderer 出站通道（只发不收）：`BrowserViewCloseTab`、`BrowserViewReady`、`BrowserViewVisibility`、`BrowserViewViewportChanged`、`BrowserViewSuspend`、`BrowserViewRestore`、`BrowserViewOperation`、`SettingsChanged`、`ApplicationLocaleChanged`。

## 4. 门禁记录（每批跑，全零才提交）

`zc-gate`（W/L/B/POEM）、`zc-verify`（deletedNonZero / nonCommentAdded / starSlash / syntaxErrorFiles）、`deep-boilerplate --diff`、`check-upstream-comments`（missing 必须为 0）。

b1–b4 复核结果：`waterLines 0`、`deletedNonZero 0`、`nonCommentAdded 0`、`starSlash 0`、`syntaxErrorFiles 0`、`dups 0`、`upstream missing 0`。
b4 首轮 10 处 W（短注释缺 ASCII 标识符），已逐个补标识符后清零——说明「对象字面量逐字段注释」是本文件最容易触发 W 的写法，后续批次先自检。

**b6 起 W 门禁已前移到插入器**：`_ssh-insert.mjs` 落盘前逐行校验注释含 `>=3` 字符 ASCII 标识符，任一不满足就打印锚点并 `exit 1`，一行不写。b6 首次运行即被拦下 17 行（比事后返工便宜：返工 17 行 vs 拦截 0 行）。b6 另有 1 处 L（第 2215 行 `无信息列举`），改为单分隔符后清零。

b7 首次运行再次被前移门禁拦下 23 行（BrowserWindow 构造参数区的逐字段短注释，如「宽度固定」「白底避免闪黑」），文件零改动；补齐 `WINDOW_WIDTH` / `backgroundColor` / `transparent` / `titleBarStyle` 等标识符后一次通过。b7 另有 1 处 L（第 2215 行），改为冒号单句后清零。

b8–b15 前移门禁累计再拦 8 行（b8 2、b10 1、b11 1、b12 2、b13 2），全部零落盘返工。b15 为 §2.9 逐条模式首批：90 个单元一次列全、逐条给锚点，插入 90 行、剩余归零。

**收口终态（b15 后）**：`UNCOVERED units=0`、`coverage 100.0%`、`branch 100.0%`、`field 100.0%`、`substance 98.2%`、`explain 99.9%`、`filler 0.0%`、`weak 0.1%`（≈2 行，均属上游注释，按 §2.6 不改写）；`MAP mappedStrict=1355 / mappedBlock=1667 / unmapped=91`（import 47、structural 11、continuation 33）；`zc-gate waterLines 0`、`zc-verify deletedNonZero 0 / nonCommentAdded 0 / starSlash 0 / syntaxErrorFiles 0`、`deep-boilerplate dups 0 / dupLines 0`、`check-upstream-comments missing 0`。

**收口原始输出（DEEP-SPEC §2.10，直接粘贴，不转述）**

```text
$ node _annot_baseline/deep-quality.mjs d:\code\ZCode --files packages/desktop/src/main/index.ts --metric-version v3 --field-mode ast --quiet --json ... --uncovered ...
UNCOVERED units=0 out=d:\code\_annot_baseline\IDX-deep-b01\_uncovered.txt
SUMMARY metric=v3 files=1 units=1355 coverage=100.0% branch=100.0% field=100.0% comments=1758 substance=98.2% explain=99.9% filler=0.0% weak=0.1%
MAP comments=1758 mappedStrict=1355 mappedBlock=1667 unmapped=91 reasons=import:47,structural:11,continuation:33,gap:0,eof:0,other:0
```

```text
$ git log --oneline -1 65d659a1
65d659a1 注释(desktop): index.ts b15 — 启动装配层逐条补完（+90 行）
$ git cat-file -t 65d659a1
commit
```

**遗留项**：本批次只做语法 fail-closed 校验（TS 解析诊断 `syntaxErr=0`），未执行 `tsc --noEmit` 与单元测试；不得据此宣称「构建通过」。

