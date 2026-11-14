# ZC 注释范围分档表（2026-11-10）

> 口径：全文件覆盖率 = `covered / units`（`deep-quality.mjs --metric-version v3`）。**不是** b228 的逻辑区口径；逻辑区权威分母与抽样分母的分工见 `ZC-DEEP-b228.md` §8.1。
> 分档按**风险**，不按未覆盖数。判据列直接引用 §1 的规则编号，规则全部可检索（路径正则 / 源码 API / 文件名 token），不靠语感。
> 扫描范围：`packages/desktop/src/main` 235 + `packages/services`、`packages/rpc`、`packages/server` 537 + `packages/ui` 1958 = **2730 文件 / 320,585 单元**。范围外的包见 §7。

## 1. 判档规则（可检索）

按下列顺序命中即停；命中第一条即定档，后续规则不再看。

### 一档：安全相关 / 跨进程边界

| 规则 | 检索条件 | 判据 |
| --- | --- | --- |
| R1.1 | 路径匹配 `packages/desktop/src/main/(browserView|pluginSandbox|mcpUserDirectory|web-remote-relay|embedded-browser-permission-contract)/` | guest 生命周期、沙箱、权限契约；main↔guest 跨进程 |
| R1.2 | 路径匹配 `packages/rpc/` | main↔renderer 的 RPC 传输、序列化与通道 |
| R1.3 | 路径匹配 `packages/server/` | 网络入口、SSH/Docker/WSL 远程执行、部署与鉴权 |
| R1.4 | 路径名含 `oauth|auth|permission|credential|cookie|secure|security|sandbox|keychain|safeStorage` | 鉴权/凭据/沙箱域 |
| R1.5 | 源码含 `ipcMain.handle/on`、`ipcRenderer.invoke/send`、`contextBridge.exposeInMainWorld` | IPC 注册点/调用点，跨进程入口 |
| R1.6 | 源码含 `setPermissionRequestHandler`、`setWindowOpenHandler`、`will-attach-webview` | 权限与 webview 安全属性 |
| R1.7 | 源码含 `new BrowserView`、`new WebContentsView`、`session.fromPartition` | guest 视图 / session 划分 |
| R1.8 | 源码含 `protocol.handle`、`registerSchemesAsPrivileged`、`protocol.intercept*` | 自定义协议注册点 |
| R1.9 | 源码含 `safeStorage.encryptString/decryptString/isEncryptionAvailable`、`keytar.*` | 凭据存储 API（明文/加密读写） |
| R1.10 | 源码含 `MessageChannelMain`、`MessagePortMain` | main↔utility 消息通道 |
| R1.11 | 源码含 `from 'child_process'`/`require('child_process')`，或 `execFile`/`spawnSync`/`execSync` 调用 | OS 命令执行边界（注入面） |
| R1.12 | 源码含 `isPathInside`、`resolveUserPath`、`assertWithin*`、`pathTraversal` | 路径穿越校验 |

> 例外：`packages/ui/` 下的 `sandbox/auth/permission` 命名多为展示组件，不触发 R1.4；若其中真有安全 API，仍会被 R1.5–R1.12 捕获。安全实现应在 main/services，不在渲染层。

### 二档：有状态的核心逻辑

| 规则 | 检索条件 | 判据 |
| --- | --- | --- |
| R2.1 | 文件名或源码含 `session|queue|scheduler|lock|mutex|semaphore|retry|backoff|persist|repository|database|sqlite|transaction|cache|recovery|migration|snapshot|store|storage|updater|download|checkpoint|journal|lease|heartbeat|reconnect` | 会话/锁/队列/重试/持久化/恢复 |
| R2.2 | 以上都不命中 | 普通生产逻辑，**保守默认二档**（不许因为"看不出风险"降到三档） |

### 三档：纯呈现与格式

| 规则 | 检索条件 | 判据 |
| --- | --- | --- |
| R3.1 | `packages/ui/` 下 `.tsx` | React 组件，纯渲染 |
| R3.2 | `packages/ui/` 下 `.ts`，文件名含呈现词（`pane|layout|view|style|theme|icon|format|label|text|scroll|zoom|...`） | 纯呈现辅助（渲染/格式化/几何计算） |
| R3.3 | 路径含 `i18n|locales|translations|messages|copy|theme|styles|colors|icons|assets|fonts|constants` | 文案、常量、样式资源 |

> UI 下既不含状态词、也不含呈现词的 `.ts`（如 telemetry supervisor、connection flow）**不降到三档**，按 R2.2 保守归二档。三档只放"能一眼看出是呈现"的文件，避免用"目录在 ui 下"当免责理由。

> 三档不是"不做"：函数级块注释必须回答**目的 / 谁调用 / 失败或异常路径**。一个函数写完三行仍说不出这三点，就以 `文件:函数名` 记入批次文档的「无注释价值函数」清单——这是允许的结论，但必须被点名，不能默默跳过。

## 2. 分档合计

| 档 | 文件 | 单元 | 已覆盖 | 未覆盖 | 现在覆盖率 | 处理标准 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 一档（安全/跨进程） | 194 | 28,344 | 5,170 | 23,174 | 18.2% | 按 §5.3 取小者收尾：R≤120 全读、R>120 抽 60 至连续 60 条无缺口 |
| 二档（有状态核心） | 1,474 | 148,841 | 26,339 | 122,502 | 17.7% | 逻辑区 40% 上下 + 全文件级块注释；残余一次 60 条抽样交代 |
| 三档（纯呈现/格式） | 1,062 | 143,400 | 15,520 | 127,880 | 10.8% | 函数级块注释（目的/调用方/失败路径），不逐行 |
| **合计** | **2,730** | **320,585** | **47,029** | **273,556** | **14.7%** | — |

> 二档、三档的"未覆盖"只用于排工作量，不用于决定是否做。**按风险定档，按档定写法。**

> **截点说明**：上表是扫描截点值。截点之后已完成十八个一档文件——`credentialService.ts`（81/81）、`oauthService.ts`（659/659，+875/−0）、`autoUpdater.ts`（1,168/1,168，+1,078/−0）、`ssh-backend.ts`（351/351，+423/−0）、`zaiProviderAdapter.ts`（226/226，+273/−0，改写批）、`protocol.ts`（153/153，+134/−0）、`bigmodelProviderAdapter.ts`（162/162，+180/−0）、`oauthCredentialRepo.ts`（229/229，+271/−0，6 批）、`oauthUnauthorizedRequest.ts`（77/77，+92/−0，2 批）、`sshAuth.ts`（58/58，+52/−0，5 批）、`create-backend.ts`（23/23，+23/−0）、`providerAdapter.ts`（19/19，+18/−0）、`oauth.ts`（16/16，+1/−0）、`index.ts`（1,355/1,355，+1,035/−0，15 批）、`desktopHostProcess.ts`（440/440，+381/−0，9 批）、`localMediaPreviewProtocol.ts`（100/100，+94/−0，1 批）、`resourceManagerNetwork.ts`（70/70，+65/−0）与 `desktopWebRemoteControlIpc.ts`（69/69，+63/−0），另有 `windowsAumidIcon.ts`（可注 23/23，+16/−0；另 38 单元在 `String.raw` 内不可注）。按当前状态，一档应为 **194 文件 / 28,344 单元 / 8,280 已覆盖 / 20,064 未覆盖 / 29.2%**，三档合计 **49,758 / 270,971 / 15.5%**；待做 **175 文件 / 21,761 单元 / 18,645 未覆盖**。逐行明细仍是截点值，重扫时一并刷新。

## 3. 一档（194 文件 / 未覆盖 23,174；其中 18 个已完成，待做 175 个）

按未覆盖降序。这是下一步的候选范围。`browserGuestManager.ts`（b228，2,621 单元）、`oauthService.ts`（659 单元）、`autoUpdater.ts`（1,168 单元）、`ssh-backend.ts`（351 单元）、`zaiProviderAdapter.ts`（226 单元）、`protocol.ts`（153 单元）、`bigmodelProviderAdapter.ts`（162 单元）、`oauthCredentialRepo.ts`（229 单元）、`oauthUnauthorizedRequest.ts`（77 单元）、`sshAuth.ts`（58 单元）、`create-backend.ts`（23 单元）、`providerAdapter.ts`（19 单元）、`oauth.ts`（16 单元）、`index.ts`（1,355 单元）、`desktopHostProcess.ts`（440 单元）、`localMediaPreviewProtocol.ts`（100 单元）、`resourceManagerNetwork.ts`（70 单元）、`desktopWebRemoteControlIpc.ts`（69 单元）、`windowsAumidIcon.ts`（61 单元，可注 23）与 `credentialService.ts`（校准批，81 单元）已完成，不在待做清单里；表中这几行仍是扫描截点值。

> 分母口径修正（v2.4）：import 的多行续行不再计单元，本表单元数已按修正后的脚本重算，与修正前的覆盖率**不可逐文件对比**。修正前的旧表只作历史记录。

| 文件 | 单元 | 未覆盖 | 现在覆盖率 | 建议档 | 判据 |
| --- | ---: | ---: | ---: | --- | --- |
| `packages/desktop/src/main/browserView/browserGuestManager.ts` | 2,621 | 1,419 | 45.9% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程）（已定格，v2.4 复核） |
| `packages/desktop/src/main/index.ts` | 1,355 | 1,032 | 23.8% | 一档 | R1.5/R1.7/R1.10/R1.11：源码命中跨进程/安全 API：ipcMain×2、session.fromPartition×2、MessageChannelMain/PortMain×2、execFile/spawnSync/execSync×1 |
| `packages/desktop/src/main/webRemoteControlManager.ts` | 1,240 | 970 | 21.8% | 一档 | R1.10：源码命中跨进程/安全 API：MessageChannelMain/PortMain×3 |
| `packages/desktop/src/main/autoUpdater.ts` | 1,168 | 958 | 18.0% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×5 |
| `packages/desktop/src/main/desktopRemoteSessions.ts` | 950 | 828 | 12.8% | 一档 | R1.10：源码命中跨进程/安全 API：MessageChannelMain/PortMain×7 |
| `packages/server/src/remote/remoteAssetCache.ts` | 956 | 741 | 22.5% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/browserView/browserPlaywrightLocatorExecutor.ts` | 747 | 658 | 11.9% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/services/src/oauth/oauthService.ts` | 659 | 522 | 20.8% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/server/src/remote/remoteAssetInstaller.ts` | 538 | 451 | 16.2% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/desktopHostProcess.ts` | 440 | 381 | 13.4% | 一档 | R1.10：源码命中跨进程/安全 API：MessageChannelMain/PortMain×4 |
| `packages/desktop/src/main/desktopCommandHandlers.ts` | 428 | 366 | 14.5% | 一档 | R1.7：源码命中跨进程/安全 API：session.fromPartition×2 |
| `packages/server/src/remote/wsl-backend.ts` | 359 | 328 | 8.6% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/desktopWindowChrome.ts` | 382 | 315 | 17.5% | 一档 | R1.6：源码命中跨进程/安全 API：setWindowOpenHandler×1 |
| `packages/server/src/remote/ssh-backend.ts` | 351 | 305 | 13.1% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/server/src/remote/deploy.ts` | 357 | 291 | 18.5% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/browserView/electronBrowserWebmRecorder.ts` | 308 | 282 | 8.4% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/browserView/browserScreenshotActivityController.ts` | 282 | 262 | 7.1% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/editors.ts` | 300 | 259 | 13.7% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×3 |
| `packages/desktop/src/main/desktopMainIpcRemote.ts` | 372 | 244 | 34.4% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×23 |
| `packages/desktop/src/main/desktopWindowLifecycle.ts` | 265 | 241 | 9.1% | 一档 | R1.10：源码命中跨进程/安全 API：MessageChannelMain/PortMain×2 |
| `packages/desktop/src/main/browserView/browserPlaywrightDomSnapshot.ts` | 261 | 236 | 9.6% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/source-server/transportAdapter.ts` | 264 | 228 | 13.6% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/desktopCuaPermissionIpc.ts` | 257 | 223 | 13.2% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×5 |
| `packages/server/src/remote/localTarGz.ts` | 234 | 213 | 9.0% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/server/src/http.ts` | 244 | 212 | 13.1% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/server/src/remote/zcodeAgentDevDeploy.ts` | 240 | 212 | 11.7% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/services/src/process/processResourceSampler.ts` | 269 | 206 | 23.4% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×2 |
| `packages/desktop/src/main/mcpUserDirectory/index.ts` | 217 | 200 | 7.8% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/browserView/browserScreenshotSurfaceCoordinator.ts` | 226 | 197 | 12.8% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/browserView/browserCommandInput.ts` | 213 | 192 | 9.9% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/openInEditor.ts` | 224 | 190 | 15.2% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×1 |
| `packages/services/src/oauth/providers/zaiProviderAdapter.ts` | 226 | 187 | 17.3% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/desktop/src/main/browserView/browserPlaywrightExecutor.ts` | 210 | 185 | 11.9% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/pluginSandbox/host.ts` | 207 | 182 | 12.1% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/remote/docker-backend.ts` | 194 | 180 | 7.2% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/browserView/browserCommandPageHandlers.ts` | 197 | 179 | 9.1% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/remote/connect.ts` | 207 | 176 | 15.0% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/browserView/browserVirtualClipboard.ts` | 190 | 169 | 11.1% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/desktopMainIpcPlatform.ts` | 214 | 169 | 21.0% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×41 |
| `packages/server/src/remote/remoteAssetDeployDecision.ts` | 177 | 167 | 5.6% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/embeddedBrowserPermissionPolicy.ts` | 192 | 164 | 14.6% | 一档 | R1.6：源码命中跨进程/安全 API：权限处理器×2 |
| `packages/rpc/src/channelServer.ts` | 172 | 164 | 4.7% | 一档 | R1.2：路径属 RPC 传输层（main↔renderer 协议） |
| `packages/rpc/src/protocol.ts` | 177 | 159 | 10.2% | 一档 | R1.2：路径属 RPC 传输层（main↔renderer 协议） |
| `packages/desktop/src/main/mcpUserDirectory/claude.ts` | 172 | 157 | 8.7% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/web-remote-relay/webRemoteControlTransport.ts` | 172 | 155 | 9.9% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/services/src/terminal/terminalProfileMacOs.ts` | 193 | 154 | 20.2% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×1 |
| `packages/desktop/src/main/browserView/browserTabRecoveryStore.ts` | 172 | 150 | 12.8% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/mcpUserDirectory/toml.ts` | 169 | 150 | 11.2% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/browserView/browserTabResidencyCoordinator.ts` | 159 | 144 | 9.4% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/browserView/browserCommandInteractionHandlers.ts` | 165 | 140 | 15.2% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/services/src/process/processTreeSnapshot.ts` | 175 | 140 | 20.0% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×2 |
| `packages/desktop/src/main/desktopBrowserViewIpc.ts` | 147 | 139 | 5.4% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×9 |
| `packages/desktop/src/main/pluginSandbox/protocol.ts` | 153 | 134 | 12.4% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/embeddedBrowserPermissionUiBridge.ts` | 146 | 133 | 8.9% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×1 |
| `packages/desktop/src/main/chromeProfileDiscovery.ts` | 149 | 130 | 12.8% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×1 |
| `packages/rpc/src/serialization.ts` | 140 | 128 | 8.6% | 一档 | R1.2：路径属 RPC 传输层（main↔renderer 协议） |
| `packages/services/src/oauth/providers/bigmodelProviderAdapter.ts` | 162 | 128 | 21.0% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/rpc/src/persistent-protocol.ts` | 147 | 122 | 17.0% | 一档 | R1.2：路径属 RPC 传输层（main↔renderer 协议） |
| `packages/desktop/src/main/desktopSaveFile.ts` | 129 | 120 | 7.0% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×1 |
| `packages/rpc/src/channelClient.ts` | 160 | 120 | 25.0% | 一档 | R1.2：路径属 RPC 传输层（main↔renderer 协议） |
| `packages/desktop/src/main/applicationIcons.ts` | 134 | 119 | 11.2% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×1 |
| `packages/desktop/src/main/mcpUserDirectory/legacy.ts` | 125 | 116 | 7.2% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/rpc/src/ipc.ts` | 133 | 116 | 12.8% | 一档 | R1.2：路径属 RPC 传输层（main↔renderer 协议） |
| `packages/server/src/remote/zcodeAgentDeploy.ts` | 133 | 116 | 12.8% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/services/src/runtime-tools/runtimeLoginShellEnvCapture.ts` | 144 | 115 | 20.1% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×1 |
| `packages/desktop/src/main/pluginSandbox/guestPolicy.ts` | 124 | 112 | 9.7% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/pluginSandbox/registry.ts` | 125 | 112 | 10.4% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/rpc/src/foundation.ts` | 122 | 110 | 9.8% | 一档 | R1.2：路径属 RPC 传输层（main↔renderer 协议） |
| `packages/services/src/oauth/repo/oauthCredentialRepo.ts` | 229 | 108 | 52.8% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/desktop/src/main/webRemoteControlSharedHostAttachments.ts` | 112 | 106 | 5.4% | 一档 | R1.10：源码命中跨进程/安全 API：MessageChannelMain/PortMain×8 |
| `packages/server/src/remote/remoteAssetLiveIdentity.ts` | 119 | 106 | 10.9% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/server/src/remote/remoteDeployLock.ts` | 109 | 98 | 10.1% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/browserView/browserScreenshotCapture.ts` | 109 | 97 | 11.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/chromeExecutableDiscovery.ts` | 119 | 97 | 18.5% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×1 |
| `packages/desktop/src/main/localMediaPreviewProtocol.ts` | 100 | 94 | 6.0% | 一档 | R1.8：源码命中跨进程/安全 API：protocol.handle/register×1 |
| `packages/desktop/src/main/desktopTraySupport.ts` | 105 | 91 | 13.3% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×1 |
| `packages/server/src/remote/remoteAssetCdn.ts` | 97 | 89 | 8.2% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/rendererActionTraceIpc.ts` | 92 | 87 | 5.4% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×2 |
| `packages/server/src/remote/docker-detect.ts` | 92 | 86 | 6.5% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/services/src/process/windowsProcessListAsync.ts` | 105 | 85 | 19.0% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×2 |
| `packages/server/src/remote/wsl-detect.ts` | 90 | 84 | 6.7% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/rpc/src/remote.ts` | 112 | 83 | 25.9% | 一档 | R1.2：路径属 RPC 传输层（main↔renderer 协议） |
| `packages/server/src/source-server/sourceServerTransportRuntime.ts` | 88 | 82 | 6.8% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/browserView/browserScreenshotSurfaceContracts.ts` | 83 | 78 | 6.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/remote/remoteAssetPreflight.ts` | 84 | 78 | 7.1% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/rpc/src/network-telemetry-middleware.ts` | 82 | 77 | 6.1% | 一档 | R1.2：路径属 RPC 传输层（main↔renderer 协议） |
| `packages/server/src/remote/handshake.ts` | 83 | 77 | 7.2% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/pluginSandbox/permissionGate.ts` | 82 | 75 | 8.5% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/pluginSandbox/permissions.ts` | 80 | 75 | 6.3% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/browserView/browserVirtualClipboardPageScript.ts` | 75 | 73 | 2.7% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/databaseStartupRelay.ts` | 80 | 73 | 8.8% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×1 |
| `packages/desktop/src/main/desktopMainIpcHelpers.ts` | 74 | 69 | 6.8% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×1 |
| `packages/desktop/src/main/resourceManagerNetwork.ts` | 70 | 65 | 7.1% | 一档 | R1.5/R1.7：源码命中跨进程/安全 API：ipcMain×2、session.fromPartition×2 |
| `packages/server/src/remote/wslProxy.ts` | 70 | 65 | 7.1% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/desktopWebRemoteControlIpc.ts` | 69 | 63 | 8.7% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×4 |
| `packages/desktop/src/main/browserView/browserCommandExecutor.ts` | 75 | 61 | 18.7% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/stdio-lifecycle.ts` | 65 | 61 | 6.2% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/services/src/oauth/oauthUnauthorizedRequest.ts` | 77 | 61 | 20.8% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/desktop/src/main/pluginSandbox/session.ts` | 69 | 60 | 13.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/entry-stdio.ts` | 71 | 60 | 15.5% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/browserView/browserTransparentWindowBootstrap.ts` | 62 | 58 | 6.5% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/fileApplications.ts` | 94 | 58 | 38.3% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×1 |
| `packages/rpc/src/proxy-channel.ts` | 75 | 58 | 22.7% | 一档 | R1.2：路径属 RPC 传输层（main↔renderer 协议） |
| `packages/server/src/source-server/sourceServerProbe.ts` | 66 | 58 | 12.1% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/browserView/browserVideoRecorder.ts` | 62 | 57 | 8.1% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/remote/sshUploadProgress.ts` | 56 | 55 | 1.8% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/browserView/browserScreenshotSurfaceCoordinatorWiring.ts` | 57 | 54 | 5.3% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/windowsAumidIcon.ts` | 61 | 54 | 11.5% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×1 |
| `packages/server/src/remote/deployShared.ts` | 59 | 54 | 8.5% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/rpc/src/logging-middleware.ts` | 58 | 53 | 8.6% | 一档 | R1.2：路径属 RPC 传输层（main↔renderer 协议） |
| `packages/server/src/remote/sshAuth.ts` | 58 | 52 | 10.3% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/server/src/stdio.ts` | 54 | 52 | 3.7% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/resourceManagerStorage.ts` | 51 | 49 | 3.9% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×5 |
| `packages/desktop/src/main/browserView/browserTabResidencyPolicy.ts` | 47 | 44 | 6.4% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/remote/runtimeToolDeploy.ts` | 42 | 42 | 0.0% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/rpc/src/channels.shared.ts` | 41 | 41 | 0.0% | 一档 | R1.2：路径属 RPC 传输层（main↔renderer 协议） |
| `packages/services/src/oauth/oauthProfileSchema.ts` | 74 | 41 | 44.6% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/desktop/src/main/desktopBrowserDataIpc.ts` | 39 | 38 | 2.6% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×6 |
| `packages/rpc/src/buffer.ts` | 44 | 36 | 18.2% | 一档 | R1.2：路径属 RPC 传输层（main↔renderer 协议） |
| `packages/services/src/credential/providers/credentialCipherProvider.ts` | 57 | 35 | 38.6% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/desktop/src/main/web-remote-relay/contract.ts` | 33 | 33 | 0.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/web-remote-relay/webRemoteControlV2Http.ts` | 35 | 33 | 5.7% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/browserView/playwrightInjectedScriptSource.ts` | 34 | 32 | 5.9% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/browserView/browserCommandState.ts` | 34 | 31 | 8.8% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/chromeCredentialManager.ts` | 36 | 31 | 13.9% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×1 |
| `packages/desktop/src/main/mcpUserDirectory/utils.ts` | 31 | 31 | 0.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/remote/serverBundleDeployCheck.ts` | 32 | 31 | 3.1% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/server/src/hostCapability.ts` | 31 | 29 | 6.5% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/pluginSandbox/contract.ts` | 41 | 28 | 31.7% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/webRemoteControlRendererReconnect.ts` | 28 | 28 | 0.0% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×1 |
| `packages/desktop/src/main/mcpUserDirectory/opencode.ts` | 33 | 27 | 18.2% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/browserView/browserScreenshotTransientRetry.ts` | 30 | 26 | 13.3% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/stdioServices.ts` | 26 | 25 | 3.8% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/server/src/remote/stdio-socket.ts` | 25 | 24 | 4.0% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/services/src/oauth/providers/bigmodelProviderConfig.ts` | 28 | 24 | 14.3% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/desktop/src/main/pluginSandbox/csp.ts` | 28 | 23 | 17.9% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/pluginSandbox/genUiVendor.ts` | 24 | 23 | 4.2% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/remote/create-backend.ts` | 23 | 23 | 0.0% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/server/src/remote/detectEnv.ts` | 24 | 23 | 4.2% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/mcpUserDirectory/types.ts` | 24 | 22 | 8.3% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/pluginSandbox/capture.ts` | 22 | 22 | 0.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/desktopLinuxXdg.ts` | 22 | 20 | 9.1% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×1 |
| `packages/desktop/src/main/pluginSandbox/contract.example.ts` | 22 | 20 | 9.1% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/entry-http.ts` | 20 | 20 | 0.0% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/server/src/remote/closeEvent.ts` | 21 | 20 | 4.8% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/server/src/remote/remoteConnectionProgressContext.ts` | 22 | 20 | 9.1% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/services/src/oauth/providers/zaiProviderConfig.ts` | 28 | 20 | 28.6% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/desktop/src/main/browserView/browserOperationIndicator.ts` | 20 | 18 | 10.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/remote/posixShell.ts` | 18 | 18 | 0.0% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/server/src/source-server/sourceServerReleaseDownload.ts` | 18 | 18 | 0.0% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/browserView/browserCommandTypes.ts` | 23 | 17 | 26.1% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/services/src/oauth/oauthProviderLogout.ts` | 22 | 17 | 22.7% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/desktop/src/main/browserView/browserCommandScripts.ts` | 26 | 16 | 38.5% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/remote/backend.ts` | 27 | 16 | 40.7% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/server/src/remote/zcodeAgentWrapperDeploy.ts` | 17 | 16 | 5.9% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/web-remote-relay/webRemoteControlDeviceStorage.ts` | 15 | 15 | 0.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/remote/index.ts` | 15 | 15 | 0.0% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/desktopPrintToPdf.ts` | 17 | 14 | 17.6% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×1 |
| `packages/desktop/src/main/processResourceRendererHeapSource.ts` | 20 | 14 | 30.0% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×1 |
| `packages/server/src/remote/zcodeAgentOfficialPluginAssets.ts` | 14 | 14 | 0.0% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/services/src/oauth/providers/index.ts` | 19 | 14 | 26.3% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/services/src/oauth/runtimeConfig.ts` | 17 | 14 | 17.6% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/desktop/src/main/browserView/browserRestoreBootstrapProtocol.ts` | 14 | 13 | 7.1% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/services/src/oauth/providers/configUtils.ts` | 19 | 13 | 31.6% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/desktop/src/main/desktopCommandIpc.ts` | 13 | 12 | 7.7% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×1 |
| `packages/services/src/oauth/providers/providerAdapter.ts` | 19 | 12 | 36.8% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/desktop/src/main/desktopCuaPipIpc.ts` | 11 | 11 | 0.0% | 一档 | R1.5：源码命中跨进程/安全 API：ipcMain×1 |
| `packages/rpc/src/index.ts` | 19 | 11 | 42.1% | 一档 | R1.2：路径属 RPC 传输层（main↔renderer 协议） |
| `packages/server/src/remote/zcodeAgentOfficialPluginPermissionRepair.ts` | 12 | 10 | 16.7% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/browserView/browserCloseTabNotification.ts` | 11 | 9 | 18.2% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/bundledZCodeBuiltinProviderConfig.ts` | 11 | 9 | 18.2% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/services/src/oauth/callbackAttribution.ts` | 11 | 9 | 18.2% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/desktop/src/main/browserView/browserCommandResult.ts` | 10 | 8 | 20.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/pluginSandbox/index.ts` | 8 | 8 | 0.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/rpc/src/delayedChannel.ts` | 8 | 8 | 0.0% | 一档 | R1.2：路径属 RPC 传输层（main↔renderer 协议） |
| `packages/server/src/stdioDeviceMid.ts` | 9 | 7 | 22.2% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/server/src/remote/zcodeAgentBundleWrapper.ts` | 7 | 6 | 14.3% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/desktop/src/main/browserView/browserPlaywrightTimeout.ts` | 5 | 4 | 20.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/embedded-browser-permission-contract/module.ts` | 5 | 4 | 20.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/pluginSandbox/module.ts` | 5 | 4 | 20.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/web-remote-relay/index.ts` | 4 | 4 | 0.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/web-remote-relay/module.ts` | 5 | 4 | 20.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/rpc/src/channels.ts` | 4 | 4 | 0.0% | 一档 | R1.2：路径属 RPC 传输层（main↔renderer 协议） |
| `packages/server/src/remote/remoteAssetNetwork.ts` | 5 | 4 | 20.0% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/services/src/credential/credential.ts` | 5 | 4 | 20.0% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/desktop/src/main/web-remote-relay/contract.example.ts` | 3 | 3 | 0.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/remote/remotePlatformSupport.ts` | 4 | 3 | 25.0% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/services/src/process/windowsTaskkillRunner.ts` | 4 | 3 | 25.0% | 一档 | R1.11：源码命中跨进程/安全 API：execFile/spawnSync/execSync×1 |
| `packages/desktop/src/main/embedded-browser-permission-contract/contract.example.ts` | 3 | 2 | 33.3% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/desktop/src/main/embedded-browser-permission-contract/contract.ts` | 2 | 1 | 50.0% | 一档 | R1.1：路径属 guest/沙箱/权限契约面（main↔guest 跨进程） |
| `packages/server/src/index.ts` | 1 | 1 | 0.0% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/server/src/source-server/index.ts` | 1 | 1 | 0.0% | 一档 | R1.3：路径属 server 网络入口（请求解析/SSH 远程执行/鉴权） |
| `packages/services/src/oauth/oauth.ts` | 16 | 1 | 93.8% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |
| `packages/services/src/credential/credentialService.ts` | 81 | 0 | 100.0% | 一档 | R1.4：路径名含鉴权/凭据/沙箱域 |

## 4. 二档（1,474 文件 / 未覆盖 122,502）

只列未覆盖前 60；全量见 `ZC-SCOPE-TIERS.tsv`。

| 文件 | 单元 | 未覆盖 | 现在覆盖率 | 建议档 | 判据 |
| --- | ---: | ---: | ---: | --- | --- |
| `packages/services/src/bots/botsService.ts` | 5,434 | 3,831 | 29.5% | 二档 | R2.1：有状态核心（命中 session/queue/Reconnect） |
| `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` | 3,156 | 2,542 | 19.5% | 二档 | R2.1：有状态核心（命中 session/queue/snapshot） |
| `packages/services/src/zcode-agent/zcodeAgentService.ts` | 3,365 | 2,399 | 28.7% | 二档 | R2.1：有状态核心（命中 queue/Session/session） |
| `packages/ui/src/lib/zcodeSessionProjection.ts` | 1,901 | 1,523 | 19.9% | 二档 | R2.1：UI 层有状态逻辑（文件名含 Session） |
| `packages/services/src/node.ts` | 1,543 | 1,234 | 20.0% | 二档 | R2.1：有状态核心（命中 Scheduler/sqlite/Session） |
| `packages/services/src/bots/providers/feishuProvider.ts` | 1,657 | 1,194 | 27.9% | 二档 | R2.1：有状态核心（命中 Updater/DOWNLOAD/Cache） |
| `packages/services/src/conversation-share/conversationShareService.ts` | 1,351 | 1,082 | 19.9% | 二档 | R2.1：有状态核心（命中 Session/session/Snapshot） |
| `packages/ui/src/root/useRemoteWorkspaceHistory.ts` | 1,179 | 1,026 | 13.0% | 二档 | R2.2：UI 非组件模块，未命中纯呈现特征，保守归二档 |
| `packages/ui/src/remote-connection-flow/index.ts` | 1,234 | 1,011 | 18.1% | 二档 | R2.2：UI 非组件模块，未命中纯呈现特征，保守归二档 |
| `packages/ui/src/v4/telemetry/conversationTelemetrySupervisor.ts` | 1,245 | 996 | 20.0% | 二档 | R2.2：UI 非组件模块，未命中纯呈现特征，保守归二档 |
| `packages/services/src/settings-sync/settingsSyncService.ts` | 1,396 | 973 | 30.3% | 二档 | R2.1：有状态核心（命中 Migration/Store） |
| `packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts` | 1,095 | 901 | 17.7% | 二档 | R2.1：有状态核心（命中 Session/session/snapshot） |
| `packages/ui/src/lib/messageTelemetry.ts` | 950 | 820 | 13.7% | 二档 | R2.2：UI 非组件模块，未命中纯呈现特征，保守归二档 |
| `packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts` | 954 | 796 | 16.6% | 二档 | R2.1：有状态核心（命中 Snapshot/Cache/session） |
| `packages/services/src/session/sourceServerWorkspaceAliasRepo.ts` | 1,198 | 778 | 35.1% | 二档 | R2.1：有状态核心（命中 Database/Migration/session） |
| `packages/ui/src/v4/conversationProjectionStore.ts` | 798 | 705 | 11.7% | 二档 | R2.1：UI 层有状态逻辑（文件名含 Store） |
| `packages/services/src/git/repo/gitCliRepo.ts` | 924 | 700 | 24.2% | 二档 | R2.1：有状态核心（命中 Repository/Snapshot/cache） |
| `packages/ui/src/lib/conversationTelemetryParityScenarioDefinitions.ts` | 721 | 645 | 10.5% | 二档 | R2.2：UI 非组件模块，未命中纯呈现特征，保守归二档 |
| `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts` | 793 | 644 | 18.8% | 二档 | R2.1：有状态核心（命中 Storage/Snapshot/storage） |
| `packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts` | 801 | 625 | 22.0% | 二档 | R2.1：有状态核心（命中 Snapshot/CACHE/snapshot） |
| `packages/desktop/src/main/desktopStabilityTelemetry.ts` | 650 | 575 | 11.5% | 二档 | R2.1：有状态核心（命中 sqlite/SQLITE/Sqlite） |
| `packages/desktop/src/main/exportLogs.ts` | 641 | 574 | 10.5% | 二档 | R2.1：有状态核心（命中 session/Snapshot/Cache） |
| `packages/desktop/src/main/taskRealtimeBus.ts` | 667 | 569 | 14.7% | 二档 | R2.1：有状态核心（命中 lease/Lease/Session） |
| `packages/services/src/session/automationRepo.ts` | 823 | 556 | 32.4% | 二档 | R2.1：有状态核心（命中 Storage/session/Database） |
| `packages/services/src/feedback/feedbackHttpClient.ts` | 671 | 554 | 17.4% | 二档 | R2.1：有状态核心（命中 Retry/download/database） |
| `packages/ui/src/store/taskQueryCacheStore.ts` | 590 | 529 | 10.3% | 二档 | R2.1：UI 层有状态逻辑（文件名含 Cache/Store） |
| `packages/services/src/plugin-sync/pluginSyncService.ts` | 665 | 526 | 20.9% | 二档 | R2.1：有状态核心（命中 storage） |
| `packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts` | 597 | 485 | 18.8% | 二档 | R2.1：有状态核心（命中 session/Session/queue） |
| `packages/ui/src/v4/composer/useComposerAttachments.ts` | 578 | 470 | 18.7% | 二档 | R2.2：UI 非组件模块，未命中纯呈现特征，保守归二档 |
| `packages/services/src/session/taskIndexRepo.ts` | 704 | 465 | 33.9% | 二档 | R2.1：有状态核心（命中 Repository/Storage/session） |
| `packages/ui/src/lib/conversationTelemetryLegacyParityE2E.ts` | 531 | 454 | 14.5% | 二档 | R2.2：UI 非组件模块，未命中纯呈现特征，保守归二档 |
| `packages/services/src/commands/commandsService.ts` | 549 | 449 | 18.2% | 二档 | R2.1：有状态核心（命中 storage/cache/Storage） |
| `packages/services/src/usage-stats/providers/bigmodelUsageMonitorMapper.ts` | 521 | 430 | 17.5% | 二档 | R2.1：有状态核心（命中 Snapshot/cache/Session） |
| `packages/ui/src/v4/workbenchGroupStore.ts` | 489 | 429 | 12.3% | 二档 | R2.1：UI 层有状态逻辑（文件名含 Store） |
| `packages/ui/src/v4/sessionsIndexStore.ts` | 479 | 422 | 11.9% | 二档 | R2.1：UI 层有状态逻辑（文件名含 session/Store） |
| `packages/ui/src/lib/remoteWorkspaceHistory.ts` | 483 | 413 | 14.5% | 二档 | R2.2：UI 非组件模块，未命中纯呈现特征，保守归二档 |
| `packages/services/src/subagents/subagentsService.ts` | 503 | 406 | 19.3% | 二档 | R2.1：有状态核心（命中 queue/Storage/Cache） |
| `packages/services/src/model-provider/legacyModelProviderSerialized.ts` | 529 | 405 | 23.4% | 二档 | R2.1：有状态核心（命中 store/Store） |
| `packages/desktop/src/main/forceUpdatePrompt.ts` | 466 | 403 | 13.5% | 二档 | R2.1：有状态核心（命中 Updater/download/retry） |
| `packages/ui/src/lib/webElementPickerScript.ts` | 410 | 392 | 4.4% | 二档 | R2.2：UI 非组件模块，未命中纯呈现特征，保守归二档 |
| `packages/ui/src/hooks/useCodingPlanQuotaResetUi.ts` | 443 | 388 | 12.4% | 二档 | R2.2：UI 非组件模块，未命中纯呈现特征，保守归二档 |
| `packages/services/src/zcode-agent/zcodeAgent.ts` | 499 | 374 | 25.1% | 二档 | R2.1：有状态核心（命中 Session/Snapshot/session） |
| `packages/services/src/mcp-sync/mcpSyncService.ts` | 456 | 373 | 18.2% | 二档 | R2.1：有状态核心（命中 Migration/migration） |
| `packages/services/src/skills/skillsService.ts` | 708 | 372 | 47.5% | 二档 | R2.1：有状态核心（命中 Queue/queue/lock） |
| `packages/desktop/src/main/chromeLocalStorageManager.ts` | 419 | 371 | 11.5% | 二档 | R2.1：有状态核心（命中 Storage/Session/Store） |
| `packages/services/src/model-provider/legacyZCodeConfigProviderReader.ts` | 612 | 368 | 39.9% | 二档 | R2.1：有状态核心（命中 lease/Store/Repository） |
| `packages/ui/src/store/zcodeSessionStoreWorkspaceSlice.ts` | 426 | 365 | 14.3% | 二档 | R2.1：UI 层有状态逻辑（文件名含 Session/Store） |
| `packages/services/src/session/offPeakMockGateway.ts` | 545 | 363 | 33.4% | 二档 | R2.1：有状态核心（命中 queue/Retry/lock） |
| `packages/services/src/system/sshConfigAlias.ts` | 430 | 358 | 16.7% | 二档 | R2.1：有状态核心（命中 lock/CACHE/Cache） |
| `packages/ui/src/v4/featureSuggestedPrompts.ts` | 396 | 358 | 9.6% | 二档 | R2.2：UI 非组件模块，未命中纯呈现特征，保守归二档 |
| `packages/services/src/git/repo/gitCliHelpers.ts` | 408 | 353 | 13.5% | 二档 | R2.1：有状态核心（命中 Repository/repository） |
| `packages/ui/src/store/mcpStore.ts` | 384 | 344 | 10.4% | 二档 | R2.1：UI 层有状态逻辑（文件名含 Store） |
| `packages/ui/src/store/tabStore.ts` | 408 | 342 | 16.2% | 二档 | R2.1：UI 层有状态逻辑（文件名含 Store） |
| `packages/services/src/session/zcodeTaskService.ts` | 434 | 337 | 22.4% | 二档 | R2.1：有状态核心（命中 Session/Snapshot/queue） |
| `packages/ui/src/feedback/feedbackSubmissionJob.ts` | 387 | 332 | 14.2% | 二档 | R2.2：UI 非组件模块，未命中纯呈现特征，保守归二档 |
| `packages/ui/src/lib/treemappingActivity.ts` | 347 | 328 | 5.5% | 二档 | R2.2：UI 非组件模块，未命中纯呈现特征，保守归二档 |
| `packages/ui/src/settings/model-provider-section/providerFamilyConnectionVisibility.ts` | 383 | 324 | 15.4% | 二档 | R2.2：UI 非组件模块，未命中纯呈现特征，保守归二档 |
| `packages/services/src/conversation-share/conversationShareArtifactDiscovery.ts` | 425 | 321 | 24.5% | 二档 | R2.1：有状态核心（命中 snapshot/Snapshot/Session） |
| `packages/ui/src/project-sidebar/grouped/view.ts` | 351 | 318 | 9.4% | 二档 | R2.2：UI 非组件模块，未命中纯呈现特征，保守归二档 |
| `packages/services/src/bots/providers/telegramProvider.ts` | 340 | 310 | 8.8% | 二档 | R2.1：有状态核心（命中 download/retry/DOWNLOAD） |

## 5. 三档（1,062 文件 / 未覆盖 127,880）

只列未覆盖前 40；全量见 `ZC-SCOPE-TIERS.tsv`。

| 文件 | 单元 | 未覆盖 | 现在覆盖率 | 建议档 | 判据 |
| --- | ---: | ---: | ---: | --- | --- |
| `packages/ui/src/v4/SessionPane.tsx` | 2,697 | 2,218 | 17.8% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/settings/AutomationEditView.tsx` | 1,908 | 1,668 | 12.6% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` | 1,551 | 1,279 | 17.5% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/v4/ConversationComposer.tsx` | 1,468 | 1,227 | 16.4% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/v4/ConversationRowView.tsx` | 1,441 | 1,222 | 15.2% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/lib/workspaceSidePane.ts` | 1,369 | 1,175 | 14.2% | 三档 | R3.2：纯呈现辅助（文件名含 Pane） |
| `packages/ui/src/v4/ConversationStatusPanel.tsx` | 1,300 | 1,144 | 12.0% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/SettingsPage.tsx` | 1,298 | 1,075 | 17.2% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/i18n/locales/en-US.ts` | 1,024 | 1,023 | 0.1% | 三档 | R3.3：文案/常量/样式资源 |
| `packages/ui/src/settings/RemotePluginSyncDialog.tsx` | 1,157 | 1,011 | 12.6% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/settings/SubagentsSection.tsx` | 1,143 | 995 | 12.9% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/v4/ConversationTimeline.tsx` | 1,156 | 943 | 18.4% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/PreviewPane.tsx` | 1,095 | 929 | 15.2% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/settings/AutomationsSection.tsx` | 1,139 | 911 | 20.0% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/settings/SourceServerManagementPanel.tsx` | 1,001 | 865 | 13.6% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx` | 921 | 790 | 14.2% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/settings/ExternalAgentImportDialog.tsx` | 925 | 787 | 14.9% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/v4/ConversationTurnGroup.tsx` | 888 | 756 | 14.9% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/settings/PluginsSection.tsx` | 873 | 748 | 14.3% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/components/ai-elements/markdown-table.tsx` | 824 | 727 | 11.8% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/RemoteConnectionFields.tsx` | 805 | 725 | 9.9% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/settings/McpSettingsSection.tsx` | 866 | 707 | 18.4% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/GitActionMenu.tsx` | 819 | 675 | 17.6% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/components/ai-elements/message.tsx` | 819 | 674 | 17.7% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/Root.tsx` | 824 | 655 | 20.5% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx` | 731 | 653 | 10.7% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/settingsPageHelpers.tsx` | 678 | 647 | 4.6% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/BotsDialog.tsx` | 719 | 637 | 11.4% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/settings/model-provider-section/Detail.tsx` | 712 | 613 | 13.9% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/LexicalChatInput.tsx` | 761 | 606 | 20.4% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/v4/ConversationShareConfirmationDock.tsx` | 611 | 574 | 6.1% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/hooks/useAppPanels.ts` | 723 | 573 | 20.7% | 三档 | R3.2：纯呈现辅助（文件名含 Pane） |
| `packages/ui/src/remote-connection/RemoteConnectionConnectingStep.tsx` | 651 | 572 | 12.1% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/v4/composer/V4ComposerToolbar.tsx` | 691 | 572 | 17.2% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/ElicitationDialog.tsx` | 705 | 571 | 19.0% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/terminal/TerminalSession.tsx` | 609 | 552 | 9.4% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/settings/usage-stats/CodingPlanUsagePanel.tsx` | 656 | 547 | 16.6% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/App.tsx` | 678 | 525 | 22.6% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/settings/model-provider-section/StatusCards.tsx` | 607 | 520 | 14.3% | 三档 | R3.1：UI 组件（React 渲染） |
| `packages/ui/src/command-center/CommandCenterDialog.tsx` | 610 | 511 | 16.2% | 三档 | R3.1：UI 组件（React 渲染） |

## 6. 一档工作量估算（按 b228 实际消耗折算）

b228 的实耗：2,621 单元（分母修正后；修正前记的 2,626 是旧口径）、2,024 行新增、16 批。折算系数：

- 注释行 / 单元 = 2,024 / 2,621 = **0.772 行/单元**
- 吞吐 = 2,621 / 16 = **164 单元/批**（约 126 行/批）
- 该 0.772 对应的终点是逻辑区 61.4%（全文件 45.8%）

下表已扣除 `browserGuestManager.ts`（2,621 单元、1,202 已覆盖、已按 §5.3 定格），口径是扫描截点的 193 个文件 / 25,723 单元（含本批已完成的 `oauthService.ts`）。

| 口径 | 需补单元 | 折合注释行 | 折合批次 | 相当于 b228 |
| --- | ---: | ---: | ---: | ---: |
| 一档补到全文件 45%（≈逻辑区 60%） | 7,607 | 5,872 | 46 | 2.9 |
| 一档补到全文件 60%（更严） | 11,466 | 8,852 | 70 | 4.4 |
| 一档全量 | 21,755 | 16,795 | 133 | 8.3 |

结论：一档按"逻辑区 60% + 抽样定格"走完，量级约 **7,607 个单元 / 5,872 行注释 / 46 批**，相当于 **2.9 个 b228**。

**文件级收尾的固定成本（按 v2.4 取小者重算）。** 旧规则「每个文件固定两轮 120 条」给出 193 × 120 = **23,160 条**——**该数是旧规则下的错误估算，已作废**。按 §5.3：136 个文件 R≤120，合计 5,827 个单元全读；57 个文件 R>120，首轮 60 条共 3,420 条；**最低 9,247 条判定**。

> 这个数只是最低值：① 不含 R>120 文件后续的「重抽 60 条 + 修补」轮次；② 不含补缺口本身的注释成本；③ 全读的成本就是 R，R 越接近 120 越贵。把 ② 加回来，一档的真实量级是 **约 5,872 行注释 + 192 份收尾记录 + ≥9,247 条判定**。A/B/C 分组后的写作成本另见 §8.6。

二档按 40% 走：按 b228 的逻辑区/全文件比（61.4 / 45.8 ≈ 1.34）折算，逻辑区 40% 约等于全文件 30%；需补 18,313 单元、约 14,120 行、112 批（约 7.0 个 b228），另加 1,474 个文件的全文件级块注释（不按单元计价）。若直接按全文件 40% 算，是 33,197 单元 / 25,595 行 / 202 批，偏保守。

二档的"残余一次 60 条"还有一个必须先定死的口径：按**文件**算 = 1,474 × 60 = **88,440 条判定**；按**批**合并算（112 批）= 6,720 条。两者差 13 倍，开工前必须写进预登记，不能等做完再解释。

三档按函数级：1,062 个文件，不以单元计价。按正则近似统计，函数锚点约 **9,279 个**（均 8.7/文件）；按每函数 3 行（目的/调用方/失败路径）计，约 **27,800 行**。这是近似值，开工前需按文件实测函数边界，不能沿用 b228 的单元折算。写不满三行的函数以 `文件:函数名` 记入「无注释价值函数」清单——允许存在，但必须点名。

## 7. 不在本表范围（必须单独决策）

以下包未扫描，不得据本表宣称"ZCode 全仓已分档"：

- `apps/zcode-cli`：约 2979 个 TS/JS 文件（含 `packages/core` 工具层；legacy 队列里的 `edit.ts` 在此）。
- `packages/client`、`packages/shared`、`packages/provider`、`packages/provider-node`、`packages/web`、`packages/web-share`、`packages/share-ui`、`packages/android`、`packages/zcode-cua`、`packages/zcode-server-cli` 等。

这些包若要进入范围，先按 §1 同一套规则扫描分档，不另行拍口径。

## 8. 一档内部优先序（按实际证据分 A/B/C）

判据改成「这个文件**实际做了什么**」，不再用文件名词表。「没命中可恢复标记」不是危险证据，只是没证据——按旧默认会把 104 个文件（72%）推进最贵的一组，A/B 就失去排序意义。

扫描口径：先剥掉注释、字符串与模板（同名文字不算证据），再给每个文件登记命中的证据类别。

### 8.1 不可逆证据（A）

| 类别 | 判定 | 检索锚点 |
| --- | --- | --- |
| 凭据/令牌 | 读写凭据或 token 对象 | `credentialService`、`saveActiveTokenSet`、`loadActiveTokenSet`、`clearActiveSession`、`safeStorage`、`keytar`、`accessToken`、`refreshToken`、`clientSecret`、`privateKey`、`password` |
| 远程控制/鉴权 | 起远程会话或做鉴权判定 | `ssh`、`sftp`、`docker`、`wsl`、`isAuthorized`、`hasPermission`、`checkPermission`、`isPathInside` |
| 文件删除 | 删除文件或目录 | `unlink`、`unlinkSync`、`rmdir`、`rmdirSync`、`rmSync`、`rimraf` |
| 进程启动 | 起子进程 | `spawn`、`spawnSync`、`execFile`、`execFileSync`、`execSync`、`fork` |
| IPC/桥接入口 | 注册主进程入口或暴露桥 | `ipcMain.`、`ipcRenderer.`、`contextBridge.` |

### 8.2 可恢复证据（B）

`cache`/`snapshot`、`viewport`/`screenshot`/`preview`、`telemetry`/`metric`/`report`、`progress`/`heartbeat`、`notify`/`clipboard`。

### 8.3 分组规则

先查 A 证据，再查 B 证据，**都不命中 → C 未判定**。C 不是 A：它只是没证据，既不按不可逆计成本，也不允许跳过，等默认判据定稿后再排。生成脚本：`_annot_baseline/_priority2.mjs`（输出 `_priority2.json`，可逐文件复核命中的证据词）。

### 8.4 三组合计（193 个非定格文件；其中 19 个已完成，待做 174 个）

| 组 | 文件 | 单元 | 未覆盖 | 组内已完成 |
| --- | ---: | ---: | ---: | --- |
| A 不可逆证据 | 56 | 10,445 | 8,594 | `oauthService.ts`（659 / 522 → 0）、`autoUpdater.ts`（1,168 / 958 → 0）、`ssh-backend.ts`（351 / 305 → 0）、`zaiProviderAdapter.ts`（226 / 187 → 0）、`protocol.ts`（153 / 134 → 0）、`bigmodelProviderAdapter.ts`（162 / 128 → 0）、`oauthCredentialRepo.ts`（229 / 108 → 0）、`oauthUnauthorizedRequest.ts`（77 / 61 → 0）、`sshAuth.ts`（58 / 52 → 0）、`create-backend.ts`（23 / 23 → 0）、`providerAdapter.ts`（19 / 12 → 0）、`oauth.ts`（16 / 1 → 0）、`index.ts`（1,355 / 1,032 → 0）、`desktopHostProcess.ts`（440 / 381 → 0）、`localMediaPreviewProtocol.ts`（100 / 94 → 0）、`resourceManagerNetwork.ts`（70 / 65 → 0）、`windowsAumidIcon.ts`（61 / 54 → 38，38 行为 `String.raw` 内结构行）、`desktopWebRemoteControlIpc.ts`（69 / 63 → 0） |
| B 可恢复证据 | 24 | 6,681 | 5,677 | — |
| C 未判定 | 112 | 8,157 | 7,103 | `credentialService.ts`（81 单元 / 0 未覆盖，截点即 100%） |
| **合计** | **193** | **25,723** | **21,755** | 待做 **174 文件 / 20,406 单元 / 17,613 未覆盖** |

各组的待做小计：A **39 文件 / 5,649 单元 / 4,833 未覆盖**；B **24 / 6,681 / 5,677**；C **111 / 8,076 / 7,103**（`credentialService.ts` 在截点就是 81/81，扣的只是文件与单元，不是缺口）。三组相加必须回到合计：39+24+111=174、5,649+6,681+8,076=20,406、4,833+5,677+7,103=17,613。

**对账：194 与 193 差的 1 个文件是 `browserGuestManager.ts`，差的 2,621 单元就是它的单元数。** 不是 `index.ts` 被摘出，也不是声明区单元或分母不同源——它的行还在 §3 表里，只是按 §5.3 定格后不再计入待做。再扣已完成文件（七个 + 凭据组六个 + `index.ts` + `desktopHostProcess.ts` + `localMediaPreviewProtocol.ts` + 打包回合三件）得 174：

| 口径 | 文件 | 单元 | 未覆盖 | 差额 |
| --- | ---: | ---: | ---: | --- |
| 一档扫描截点（§2 表） | 194 | 28,344 | 23,174 | — |
| 扣 `browserGuestManager.ts`（已定格） | 193 | 25,723 | 21,755 | −1 / −2,621 / −1,419 |
| 扣 `credentialService.ts`（截点 100%） | 192 | 25,642 | 21,755 | −1 / −81 / 0 |
| 扣 `oauthService.ts`（本批补完） | 191 | 24,983 | 21,233 | −1 / −659 / −522 |
| 扣 `autoUpdater.ts`（本批补完） | 190 | 23,815 | 20,275 | −1 / −1,168 / −958 |
| 扣 `ssh-backend.ts`（本批补完） | 189 | 23,464 | 19,970 | −1 / −351 / −305 |
| 扣 `zaiProviderAdapter.ts`（本批补完） | 188 | 23,238 | 19,783 | −1 / −226 / −187 |
| 扣 `protocol.ts`（本批补完） | 187 | 23,085 | 19,649 | −1 / −153 / −134 |
| 扣 `bigmodelProviderAdapter.ts`（本批补完） | 186 | 22,923 | 19,521 | −1 / −162 / −128 |
| 扣 `oauthCredentialRepo.ts`（本批补完） | 185 | 22,694 | 19,413 | −1 / −229 / −108 |
| 扣 `oauthUnauthorizedRequest.ts`（本批补完） | 184 | 22,617 | 19,352 | −1 / −77 / −61 |
| 扣 `sshAuth.ts`（本批补完） | 183 | 22,559 | 19,300 | −1 / −58 / −52 |
| 扣 `create-backend.ts` + `providerAdapter.ts` + `oauth.ts`（本批补完） | 183 | 22,559 | 19,300 | 同上 |
| 扣 `index.ts`（本批补完） | 179 | 21,146 | 18,232 | −1 / −1,355 / −1,032 |
| 扣 `desktopHostProcess.ts`（本批补完） | 178 | 20,706 | 17,851 | −1 / −440 / −381 |
| 扣 `localMediaPreviewProtocol.ts`（本批补完） | 177 | 20,606 | 17,757 | −1 / −100 / −94 |
| 扣 `resourceManagerNetwork.ts`（打包回合） | 176 | 20,536 | 17,692 | −1 / −70 / −65 |
| 扣 `desktopWebRemoteControlIpc.ts`（打包回合） | 175 | 20,467 | 17,629 | −1 / −69 / −63 |
| 扣 `windowsAumidIcon.ts`（打包回合，可注部分补完） | 174 | 20,406 | 17,613 | −1 / −61 / −16 |

两步总数必须能对上：25,723 = 28,344 − 2,621；24,983 = 25,723 − 81 − 659；23,815 = 24,983 − 1,168；23,464 = 23,815 − 351；23,238 = 23,464 − 226；23,085 = 23,238 − 153；22,923 = 23,085 − 162；22,694 = 22,923 − 229；22,617 = 22,694 − 77；22,559 = 22,617 − 58；22,501 = 22,559 − 23 − 19 − 16；21,146 = 22,501 − 1,355；19,970 = 23,174 − 1,419 − 522 − 958 − 305；19,783 = 19,970 − 187；19,649 = 19,783 − 134；19,521 = 19,649 − 128；19,413 = 19,521 − 108；19,352 = 19,413 − 61；19,300 = 19,352 − 52；19,264 = 19,300 − 23 − 12 − 1；18,232 = 19,264 − 1,032；20,706 = 21,146 − 440；17,851 = 18,232 − 381；20,606 = 20,706 − 100；17,757 = 17,851 − 94；20,536 = 20,606 − 70；17,692 = 17,757 − 65；20,467 = 20,536 − 69；17,629 = 17,692 − 63；20,406 = 20,467 − 61；17,613 = 17,629 − 16。任何一处对不上就停下查，不挑一个信。

> 旧版 §8 的「A 145 / 19,536 / 16,439、B 48 / 6,187 / 5,316」**作废**：A 的 145 里有 104 个是「未命中可恢复特征 → 按不可逆兜底」。文件名词表降级为人工复核线索，不再单独决定分组。

### 8.5 A 组清单（按风险序：凭据 → 远程控制/鉴权 → 文件删除 → 进程启动 → IPC 入口；同序按未覆盖降序）

| 文件 | 单元 | 未覆盖 | 证据 |
| --- | ---: | ---: | --- |
| `packages/desktop/src/main/autoUpdater.ts` | 1,168 | ~~958~~ **0** | 凭据/令牌、IPC/桥接（本批已完成，100%） |
| `packages/services/src/oauth/oauthService.ts` | 659 | ~~522~~ **0** | 凭据/令牌（本批已完成，100%） |
| `packages/server/src/remote/ssh-backend.ts` | 351 | ~~305~~ **0** | 凭据/令牌、远程控制（本批已完成，100%） |
| `packages/services/src/oauth/providers/zaiProviderAdapter.ts` | 226 | ~~187~~ **0** | 凭据/令牌（本批已完成，100%） |
| `packages/desktop/src/main/pluginSandbox/protocol.ts` | 153 | ~~134~~ **0** | 插件沙箱协议入口（本批已完成，100%） |
| `packages/services/src/oauth/providers/bigmodelProviderAdapter.ts` | 162 | ~~128~~ **0** | 凭据/令牌（本批已完成，100%） |
| `packages/services/src/oauth/repo/oauthCredentialRepo.ts` | 229 | ~~108~~ **0** | 凭据/令牌（本批已完成，100%） |
| `packages/services/src/oauth/oauthUnauthorizedRequest.ts` | 77 | ~~61~~ **0** | 凭据/令牌（本批已完成，100%） |
| `packages/server/src/remote/sshAuth.ts` | 58 | ~~52~~ **0** | 凭据/令牌（本批已完成，100%） |
| `packages/server/src/remote/create-backend.ts` | 23 | ~~23~~ **0** | 凭据/令牌（本批已完成，100%） |
| `packages/services/src/oauth/providers/providerAdapter.ts` | 19 | ~~12~~ **0** | 凭据/令牌（本批已完成，100%） |
| `packages/services/src/oauth/oauth.ts` | 16 | ~~1~~ **0** | 凭据/令牌（本批已完成，100%） |
| `packages/desktop/src/main/index.ts` | 1,355 | ~~1,032~~ **0** | 远程控制、IPC/桥接、鉴权（本批已完成，100%） |
| `packages/desktop/src/main/desktopHostProcess.ts` | 440 | ~~381~~ **0** | 进程启动、鉴权（本批已完成，100%） |
| `packages/desktop/src/main/localMediaPreviewProtocol.ts` | 100 | ~~94~~ **0** | 鉴权（本批已完成，100%） |
| `packages/desktop/src/main/resourceManagerNetwork.ts` | 70 | ~~65~~ **0** | IPC/桥接、鉴权（打包回合已完成，100%） |
| `packages/desktop/src/main/windowsAumidIcon.ts` | 61 | ~~54~~ **38** | 进程启动、远程执行（可注 23 已清零；38 单元在 `String.raw` 内，§7.4 不可注） |
| `packages/desktop/src/main/desktopWebRemoteControlIpc.ts` | 69 | ~~63~~ **0** | IPC/桥接、鉴权（打包回合已完成，100%） |
| `packages/server/src/remote/remoteAssetInstaller.ts` | 538 | 451 | 文件删除 |
| `packages/desktop/src/main/editors.ts` | 300 | 259 | 文件删除、进程启动 |
| `packages/server/src/remote/localTarGz.ts` | 234 | 213 | 文件删除 |
| `packages/desktop/src/main/browserView/browserTabRecoveryStore.ts` | 172 | 150 | 文件删除 |
| `packages/server/src/remote/wsl-backend.ts` | 359 | 328 | 进程启动 |
| `packages/services/src/process/processResourceSampler.ts` | 269 | 206 | 进程启动 |
| `packages/desktop/src/main/openInEditor.ts` | 224 | 190 | 进程启动 |
| `packages/server/src/remote/docker-backend.ts` | 194 | 180 | 进程启动 |
| `packages/services/src/terminal/terminalProfileMacOs.ts` | 193 | 154 | 进程启动 |
| `packages/services/src/process/processTreeSnapshot.ts` | 175 | 140 | 进程启动 |
| `packages/desktop/src/main/chromeProfileDiscovery.ts` | 149 | 130 | 进程启动 |
| `packages/desktop/src/main/applicationIcons.ts` | 134 | 119 | 进程启动 |
| `packages/services/src/runtime-tools/runtimeLoginShellEnvCapture.ts` | 144 | 115 | 进程启动 |
| `packages/desktop/src/main/chromeExecutableDiscovery.ts` | 119 | 97 | 进程启动 |
| `packages/desktop/src/main/desktopTraySupport.ts` | 105 | 91 | 进程启动 |
| `packages/server/src/remote/docker-detect.ts` | 92 | 86 | 进程启动 |
| `packages/services/src/process/windowsProcessListAsync.ts` | 105 | 85 | 进程启动 |
| `packages/server/src/remote/wsl-detect.ts` | 90 | 84 | 进程启动 |
| `packages/desktop/src/main/desktopMainIpcHelpers.ts` | 74 | 69 | 进程启动 |
| `packages/desktop/src/main/fileApplications.ts` | 94 | 58 | 进程启动 |
| `packages/desktop/src/main/chromeCredentialManager.ts` | 36 | 31 | 进程启动 |
| `packages/desktop/src/main/desktopLinuxXdg.ts` | 22 | 20 | 进程启动 |
| `packages/services/src/process/windowsTaskkillRunner.ts` | 4 | 3 | 进程启动 |
| `packages/desktop/src/main/desktopMainIpcRemote.ts` | 372 | 244 | IPC/桥接 |
| `packages/desktop/src/main/desktopCuaPermissionIpc.ts` | 257 | 223 | IPC/桥接 |
| `packages/desktop/src/main/pluginSandbox/host.ts` | 207 | 182 | IPC/桥接 |
| `packages/desktop/src/main/desktopMainIpcPlatform.ts` | 214 | 169 | IPC/桥接 |
| `packages/desktop/src/main/desktopBrowserViewIpc.ts` | 147 | 139 | IPC/桥接 |
| `packages/desktop/src/main/embeddedBrowserPermissionUiBridge.ts` | 146 | 133 | IPC/桥接 |
| `packages/desktop/src/main/desktopSaveFile.ts` | 129 | 120 | IPC/桥接 |
| `packages/desktop/src/main/rendererActionTraceIpc.ts` | 92 | 87 | IPC/桥接 |
| `packages/desktop/src/main/databaseStartupRelay.ts` | 80 | 73 | IPC/桥接 |
| `packages/desktop/src/main/desktopWebRemoteControlIpc.ts` | 69 | 63 | IPC/桥接 |
| `packages/desktop/src/main/resourceManagerStorage.ts` | 51 | 49 | IPC/桥接 |
| `packages/desktop/src/main/desktopBrowserDataIpc.ts` | 39 | 38 | IPC/桥接 |
| `packages/desktop/src/main/webRemoteControlRendererReconnect.ts` | 28 | 28 | IPC/桥接 |
| `packages/desktop/src/main/desktopPrintToPdf.ts` | 17 | 14 | IPC/桥接 |
| `packages/desktop/src/main/processResourceRendererHeapSource.ts` | 20 | 14 | IPC/桥接 |
| `packages/desktop/src/main/desktopCommandIpc.ts` | 13 | 12 | IPC/桥接 |
| `packages/desktop/src/main/desktopCuaPipIpc.ts` | 11 | 11 | IPC/桥接 |

B 组 24 个、C 组 112 个（其中 `credentialService.ts` 已完成，待做 111 个）的完整清单在 `_annot_baseline/_priority2.txt`，不在此复抄；C 组暂不排期。

> **占用 / 脏文件清单（开工前必查，结论二选一：漏提交 or 他人占用）**
>
> 1. `packages/server/src/remote/wslProxy.ts`、`packages/server/src/remote/wsl-detect.ts`、`packages/model-option-map/src/tokenizer.ts`——**归属：本线 b135 整批漏提交**（不是他人会话）。证据四条：① `docs/annotation/ZC-DEEP-b135.md` 登记「3 文件，+120 行」，逐文件为 `5 blocks, 40 lines`，与三文件工作区各 40 行改动完全一致；② 本次补提交前 `git log --all --oneline -- packages/server/src/remote/wslProxy.ts` 只有 `872ad960 feat: open source`，没有任何 b135 提交；③ 批次快照目录 `_annot_baseline/ZC-deep-b135` 的 mtime 是 **2026/11/8 15:54:47**，`wsl-detect.ts` / `tokenizer.ts` 的 mtime 是 **2026/11/8 15:56:57 / 15:56:58**，与批次落盘时间吻合（`wslProxy.ts` 的 mtime 显示 2026/11/10 13:33:48，是本次退回与补提交造成，不是原始落盘时间）；④ 三文件在 `ZC-DEEP-b135.md` 里有批次记录但仓库里没有对应提交，即「有台账、无提交号」。处置：2026-11-10 用 `_ssh-revert.mjs` 退回后复跑六道门禁（`codeTokenDiff=0`、`addedViolations=0`、`deletedNonZero=0`、`added=120`），补提交 **`67be296b`**，`git show --numstat 67be296b` 三行均为 `40 0`。**结论：已清空，不再是脏文件。**
> 2. `packages/server/src/remote/remoteAssetInstaller.ts`——**归属：本线 b18 整批漏提交**。证据：`ZC-DEEP-b18.md` 第 30 行登记该文件 `+300`，工作区 `git diff --numstat` 恰为 `300 0`；`git log --all --oneline` 没有任何 b18 提交；文件 mtime 为 **2026/11/7 13:53:20**。校验：`check-code-tokens` → `codeTokenDiff=0`；`zc-verify` → `added=300 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0`。**但 `zc-gate --scan` 判 `waterLines=54 waterRate=18.00%`**（Poem 2 组共 6 行、L 12 行、W 37 行，1358 行同时命中 L 与 W 去重后 = 54 行），按现行规则不得直接提交。处置：先按 L/W 规则改写这 54 行，再以「b18 补提交」落盘。状态：~~占用中（待修订后提交）~~ → **已补提交**（`89d591aa`，`git show --numstat` 为 `300 0`；54 行改写登记见 `ZC-DEEP-b18.md` §7）。
> 3. 同批另有 6 个文件同样未提交：`packages/desktop/src/host/windowRemoteConnectionRegistry.ts`、`packages/ui/src/v4/composer/useComposerAttachments.ts`、`packages/ui/src/components/ui/pptx-preview-viewer.tsx`、`packages/formal-proof/src/main.ts`、`packages/formal-proof/src/model.ts`、`apps/zcode-cli/packages/core/src/runtime/methods/steering.ts`——同属 b18 漏提交，本轮不动，只登记，避免和注释批次混在一起提交。
> 4. `git status --short` 全仓仍有约 2,045 行改动，绝大多数属其他工作线（`apps/dev-docs`、`apps/zcode-cli` 等），与注释范围无关，**不在本线登记范围**；本线只登记 `docs/annotation/` 与上述文件。
> 5. **非本线占用：15 个含代码改动的文件**（2026-11-10 安全快照时登记）。这 15 个文件是本轮 2,041 条工作区改动里唯一含真实代码改动的部分，合计 `+1,891/−285`，其中 285 行是**真实删除**（不是注释改写）。它们与注释工程无关，属别人正在做的事——**未 add、未改、未 stash，后续也不得纳入注释批次**。判定依据：`_annot_baseline/classify-dirty.mjs` 逐文件解析 `git diff -U0`，新增行里出现非注释行即归入 CODE 组；安全快照用 `zc-commit --require-pure-annot` 复核，命中「新增非注释行 / 删除行」即整批拒绝，因此 A 组 1,726 文件里不含这 15 个。
>
> | 文件 | 工作区 mtime | numstat |
> | --- | --- | ---: |
> | `apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts` | 2026-11-08 15:39 | +176/−22 |
> | `apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts` | 2026-11-07 14:40 | +297/−6 |
> | `apps/zcode-cli/packages/core/src/context/dynamic-sections.ts` | 2026-11-02 23:31 | +45/−2 |
> | `apps/zcode-cli/packages/core/src/context/sections/skills.ts` | 2026-11-02 23:28 | +33/−7 |
> | `apps/zcode-cli/packages/core/src/errors/error-payload.ts` | 2026-11-08 02:51 | +108/−8 |
> | `apps/zcode-cli/packages/core/src/hooks/workspace-hook-trust-coordinator.ts` | 2026-10-31 22:58 | +31/−5 |
> | `apps/zcode-cli/packages/core/src/runtime/methods/background.ts` | 2026-11-02 22:47 | +98/−12 |
> | `apps/zcode-cli/packages/core/src/runtime/methods/file-rewind.ts` | 2026-11-07 18:35 | +199/−8 |
> | `apps/zcode-cli/packages/core/src/runtime/methods/model-streaming-event-queue.ts` | 2026-10-31 20:42 | +27/−7 |
> | `apps/zcode-cli/packages/core/src/runtime/methods/rewind.ts` | 2026-11-08 16:02 | +123/−7 |
> | `apps/zcode-cli/packages/core/src/runtime/methods/target.ts` | 2026-11-08 01:27 | +119/−2 |
> | `apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts` | 2026-11-08 20:24 | +251/−32 |
> | `apps/zcode-cli/packages/core/src/tool/scheduler.ts` | 2026-11-02 22:57 | +99/−2 |
> | `apps/zcode-cli/packages/ios-simulator-plugin/src/providers/logs.ts` | 2026-11-03 02:07 | +27/−1 |
> | `packages/services/src/mcp-sync/mcpSyncService.ts` | 2026-11-07 23:16 | +258/−164 |
> | **合计（15）** | 2026-10-31 ~ 11-08 | **+1,891/−285** |
>
> 登记理由：这 15 个文件既不在 `ZC-DEEP-b*` 台账里，也不在 `ZC-DEEP-svc-*` / `L1-*` / `L2-*` 台账里；mtime 集中在 10-31 至 11-08，与本线 b1–b226 的落盘时间重叠但对不上批次。**它们就是「不属于本线」的定义样本**：不看改动内容、只看它有没有本线台账记录。
>
> 判据仍保留「`git status --short -- <file>` 非空就跳过」，但**必须先判归属**：查 `ZC-DEEP-*` 台账里有没有该文件的批次记录——有记录而仓库无提交 = 漏提交，先补提交再动；无记录 = 他人占用，写清会话与时间后跳过。不许只写「本来就不干净」。

#### 8.5.1 数值修订留痕（原句保留，2026-11-10）

`04cd8c4c` 的删改中，`−21` 全部落在本文件（`28 加 / 21 删`），三份台账与源码均 `0 删`。按「作废口径不得靠删除」的要求，被替换的旧表述逐条留在下表，原句全文可取回：`git show 04cd8c4c^:docs/annotation/ZC-SCOPE-TIERS.md`。

| 位置 | 原句（**已作废**） | 现行值 | 修订原因 |
| --- | --- | --- | --- |
| §2 截点说明 | 「已完成**十五个**一档文件……一档应为 **194 文件 / 28,344 单元 / 8,136 已覆盖 / 20,208 未覆盖 / 28.7%**，三档合计 **49,614 / 270,971 / 15.5%**；待做 **178 文件 / 21,961 单元 / 18,789 未覆盖**」 | 十八个；8,280 / 20,064 / 29.2%；49,758；175 / 21,761 / 18,645 | 打包回合再完成 3 文件（RMN 65、DWRC 63、WAI 可注 16），覆盖数上移、待做下移 |
| §3 标题 | 「其中 **15 个**已完成，待做 **178** 个」 | 18 / 175 | 同上 |
| §8.4 标题 | 「其中 **16 个**已完成，待做 **177** 个」 | 19 / 174 | 同上 |
| §8.4 合计行 | 「待做 **177 文件 / 20,606 单元 / 17,757 未覆盖**」 | 174 / 20,406 / 17,613 | 同上 |
| §8.4 小计段 | 「A **42 文件 / 5,849 单元 / 4,977 未覆盖**……42+24+111=**177**、5,849+6,681+8,076=**20,606**、4,977+5,677+7,103=**17,757**」 | A 39 / 5,649 / 4,833；右端 174 / 20,406 / 17,613 | 扣掉打包回合三件 |
| §8.4 对账段 | 「再扣已完成文件（七个 + 凭据组六个 + `index.ts` + `desktopHostProcess.ts` + `localMediaPreviewProtocol.ts`）得 **177**」 | 得 174（追加「打包回合三件」） | 同上 |
| §8.4 校验串 | 「…20,606 = 20,706 − 100；17,757 = 17,851 − 94。」（串到此为止） | 追加三段至 `17,613 = 17,629 − 16` | 保持 1 行 = 1 单元的逐步扣账 |
| §8.5 表 | `resourceManagerNetwork.ts` 「70 / **65**」；`windowsAumidIcon.ts` 「61 / **54**」；无 `desktopWebRemoteControlIpc.ts` 行 | `~~65~~ **0**`；`~~54~~ **38**`；新增 69 / `~~63~~ **0**` | 打包回合三件收口 |
| §8.7 窗口合计 | 「**合计 / 平均** \| — \| **1,598 / 320 行每回合** \| **33 / 6.6 批每回合**」 | 1,690 / 338；36 / 7.2 | 窗口右移纳入 R7（144 行 / 3 批） |
| §8.7 均值段 | 「1,598 行里 **1,416 行（88.6%）**……A 组剩余 **42 文件 / 5,849 单元**，**平均 139 单元一个**……实际速率是 **94 行/回合**（R6 实测），不是 **320**」 | 1,690 / 1,416（83.8%）/ 39 / 5,649 / 145 / 不是 338 | 均值基数换新窗口，且明确否掉 338 |
| §8.7 条件表 | A 组「4,977 \| 4,310 \| **14**（÷320） \| **53**（÷94）」；乙「17,757 \| 15,378 \| **48**（÷320） \| **189**（÷94）」 | 4,833 / 4,185 / 14 / 52；17,613 / 15,253 / 48 / 188 | 分母随 §8.4 现值重算 |
| §8.8 表 | 甲「42 \| 5,849 \| 4,977 \| **14 / 53**」；乙「177 \| 20,606 \| 17,757 \| **48 / 189**」 | 39 / 5,649 / 4,833 / 14 / 52；174 / 20,406 / 17,613 / 48 / 188 | 同上 |
| §8.8 说明 3 / 4 | 「约 320 行/回合、**6.6 批**」；「A 组剩余平均 **139 单元/文件**」 | 7.2 批；145 单元/文件 | 同上 |

> 这张表本身就是「作废但不删除」的执行：旧数一律保留并标 **已作废**，新数只在现行段落出现；未来再改，往本表追加行，不覆盖旧行。

### 8.6 成本：读的条数不是写作成本

`9,247` 只是**读**的条数（R≤120 的 136 个文件全读 5,827 + R>120 的 57 个文件首轮 3,420），不含给每个未覆盖单元写解释。写作成本按下面「累计实测比」算；b228 的 0.772 行/单元只作单文件参考，不再用于外推。

| 口径 | 未覆盖 | 折合注释行 |
| --- | ---: | ---: |
| 旧 A 组（旧分组，已作废） | 16,439 | 16,439 |
| 新 A 组（§2.7 不变量：1 行 = 1 单元） | 4,977 | 4,977 |
| C 未判定（判据定稿后再算） | 7,103 | 7,103 |

折合注释行**等于未覆盖单元数**（§2.7 是构造保证）。折算回合并见 §8.7，**不再除以任何「批次均值」**——那是量纲错误，见 §8.7 的作废记录。

**成本改用累计实测比，不再按单文件外推。** 已做文件的「本批新增行 ÷ 可注单元」滚动累加（不含批次前已有行，`credentialService.ts` 无行数记录不参与）：

| 文件 | 新增行 | 单元 | 行/单元 |
| --- | ---: | ---: | ---: |
| `oauthService.ts` | 875 | 659 | 1.328 |
| `autoUpdater.ts` | 1,078 | 1,168 | 0.923 |
| `ssh-backend.ts` | 423 | 351 | 1.205 |
| `zaiProviderAdapter.ts` | 273 | 226 | 1.208 |
| `protocol.ts` | 134 | 153 | 0.876 |
| `bigmodelProviderAdapter.ts` | 128 | 162 | 0.790 |
| `oauthCredentialRepo.ts` | 108 | 229 | 0.472* |
| `oauthUnauthorizedRequest.ts` | 61 | 77 | 0.792 |
| `sshAuth.ts` | 52 | 58 | 0.897 |
| `create-backend.ts` | 23 | 23 | 1.000 |
| `providerAdapter.ts` | 12 | 19 | 0.632 |
| `oauth.ts` | 1 | 16 | 0.063† |
| `index.ts` | 1,032 | 1,355 | 0.762‡ |
| `desktopHostProcess.ts` | 381 | 440 | 0.866§ |
| `localMediaPreviewProtocol.ts` | 94 | 100 | 0.940¶ |
| **累计** | **4,675** | **5,036** | **0.928** |

\* `oauthCredentialRepo.ts` 的起始状态已含 121 个已覆盖单元，1.0 的行/单元是按「新增行 ÷ 新增覆盖单元」算的；此处列的是「新增行 ÷ 全文件单元」，仅用于累计口径。

† `oauth.ts` 起始 93.8% 覆盖，只补 1 个单元，但它仍有 16 个可注单元参与分母。这类「截点已近乎全绿」的文件会把累计比往下拉，属于正常稀释，不是写法差异；看趋势看累计行，不看单行。

‡ `index.ts` 起始 23.8% 覆盖（323 单元已由上游注释覆盖），1,032 行全部用于 1,032 个新增单元，**行/新增单元恰为 1.000**；列表里是「行/全文件单元」，所以只显示 0.762。

§ `desktopHostProcess.ts` 起始 13.4%（59 单元已由上游注释覆盖，含 1 处行尾注释），381 行全部用于 381 个新增单元，**行/新增单元恰为 1.000**；0.866 是行/全文件单元。

¶ `localMediaPreviewProtocol.ts` 起始 6.0%（6 单元已由上游注释覆盖），94 行全部用于 94 个新增单元，**行/新增单元恰为 1.000**；0.940 是行/全文件单元。

**这条口径到此为止：从 §2.7 成为不变量起，「插入行数 ≡ 覆盖单元数」是构造保证，不是测量结果。** 每个单元的写作成本就是 1 行，历史表里的 1.328 / 0.923 等差异来自前不变量时期的批内差（多行注释、锚点复用）。因此：

- 成本折算**直接用未覆盖单元数**，不再乘 0.934 或 1.009；
- 累计比表只作历史留档，不再用于外推；
- 若某批出现 `Δuncovered ≠ −插入行数`，说明锚点错位，该批作废（§2.7）。

旧 A 组按 16,439 算是 **6.3 个 b228**；新 A 组 4,977 是 **1.9 个**，C 组 7,103 是 **2.7 个**。报告里写「A 组约 1.9 个 b228 当量、C 组 2.7 个」，不能只写「9,247 条」让人以为读一遍就完。

### 8.7 剩余规模：按最近 5 个回合折算（回合 ≠ 批次）

**回合 = 一封交付报告**。一批可以小到 1 行，一回合也可以装 15 批；拿批次平均行数当回合吞吐，量纲就错了（DEEP-SPEC §2.12）。

滚动窗口取**最近 5 个回合**（每完成一个文件窗口右移一格，旧回合滚出）：

| 回合 | 交付 | 插入行数 | 批数 |
| --- | --- | ---: | ---: |
| R2 | `sshAuth.ts` | 52 | 5 |
| R3 | `create-backend.ts` + `providerAdapter.ts` + `oauth.ts` | 36 | 3 |
| R4 | `index.ts` | 1,035 | 15 |
| R5 | `desktopHostProcess.ts` | 381 | 9 |
| R6 | `localMediaPreviewProtocol.ts` | 94 | 1 |
| R7 | `resourceManagerNetwork.ts` + `windowsAumidIcon.ts` + `desktopWebRemoteControlIpc.ts` | 144 | 3 |
| **合计 / 平均** | — | **1,690 / 338 行每回合** | **36 / 7.2 批每回合** |

**这个均值不能直接折 A 组剩余。** 1,690 行里 **1,416 行（83.8%）来自 R4 与 R5 两个大文件回合**：`index.ts` 有 3,182 行源码 / 1,355 单元，一轮就能吃下上千行；`desktopHostProcess.ts` 也有 440 单元。而 A 组剩余 39 文件 / 5,649 单元，**平均 145 单元一个**，与 R6 那批 94 行同量级。同一批量级的小文件，实际速率是 **94 行/回合**（R6 实测），不是 338；R7 打了三个小文件也只有 144 行，同样够不到均值。

因此甲/乙都给**条件式**，两个前提并列报（DEEP-SPEC §2.14）。打包列按 3–4 个同量级文件的 320 行中值折算，**不用窗口均值 338**——后者仍被两个大文件回合占 83.8%，正是本条要挡的量纲错配：

| 范围 | 未覆盖单元 | 折合行数（×0.866） | 打包：3–4 个小文件/回合（÷320） | 一文件一回合（÷94） |
| --- | ---: | ---: | ---: | ---: |
| A 组待做（§8.4） | 4,833 | 4,185 | **14 回合**（÷320） | **52 回合**（÷94） |
| 乙：全一档待做（A+B+C，§8.4） | 17,613 | 15,253 | **48 回合**（÷320） | **188 回合**（÷94） |

> 「一文件一回合」按未覆盖单元 1:1 折行（94 行覆盖 94 单元），不再乘 0.866——0.866 是「行 / 全文件单元」，扣的是开工前已覆盖的那部分，对小文件批次不成立。

按每工作日 1 回合：A 组 **3 周（打包）/ 10 周（不打包）**；乙 **10 周 / 38 周**。

**打包是施工规则，不是口径**（DEEP-SPEC §2.14）：单文件 <150 单元时一个回合做 2–4 个同量级文件，各自独立成批、各自核对 `Δuncovered = −插入行数`、各自提交。不打包的代价是固定开销按**文件数**线性叠加——基线 TSV、六件套度量、批次文档、提交各一份，与注释行数无关；文件越小，这部分占比越高。上表两列的差就是这个代价。

**每回合并批数 7.2 是可调的，不是约束**：批只决定单次审查粒度，不影响回合产出。`sessionStorage` 2,711 行 / 10 批、`index.ts` 1,035 行 / 15 批、`desktopHostProcess.ts` 381 行 / 9 批、`localMediaPreviewProtocol.ts` 94 行 / 1 批——批大小差 15 倍，回合产出没有对应差异。

**作废记录（均为错误量纲，不得再引用；本表即唯一登记处，规范母本同表见 `DEEP-SPEC.md` §2.12）**：

| 数 | 算法 | 错在哪 |
| --- | --- | --- |
| 18 回合 | 总单元 ÷ 批次数 | 分子含开工前已覆盖单元，不是本回合产出（量纲错） |
| 55 回合 | 批次数当回合数 | 批次 ≠ 回合（量纲错） |
| 95 / 334 回合 | 批次均值（53.4 单元/批）当回合吞吐 | 批次 ≠ 回合，滚动窗口也取错对象（量纲错） |
| ~~14 / 48（不加条件）~~ | 大文件回合均值 320 折小文件 | 分子被 1,035 + 381 两个回合主导（88.6%），粒度错配；只有**打包前提**下成立 |
| **保留** | 一回合 = 一封报告 | 甲 **14（打包）/ 52（一文件一回合）**；乙 **48 / 188** |

**口径变更不追改历史结论**：此前引用 18/55/95/334 的文档一律按本条作废，不回流重写。

### 8.8 范围决策：两个方案，待拍板

下表按 §8.4 现值与 §8.7 的两个前提折算（回合数与工期都随前提变）：

| 方案 | 范围 | 文件 | 可注单元 | 未覆盖 | 回合（打包 / 不打包） | 按工作日 1 回合 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 甲 | 只做 A 组（不可逆证据） | 39 | 5,649 | 4,833 | **14 / 52** | 约 3 周 / 10 周 |
| 乙 | 全一档（含 C 组未判定） | 174 | 20,406 | 17,613 | **48 / 188** | 约 10 周 / 38 周 |

说明四条：
1. 甲是乙的子集，先做甲不浪费工作量——甲做完后乙只剩 B 组 24 个与 C 组 111 个。
2. **C 组 111 个文件按「未命中 A/B 证据」兜底归类，不是已证实不可逆。** 判据定稿后若有一半落回 B 组（可恢复），那部分可降到「改了才补」的低频策略，乙的回合数随之下修。
3. 两个方案单价相同，差别只在范围；单价不靠挑文件优化——打包后约 320 行/回合、7.2 批，一文件一回合则 94 行/回合（§8.7）。
4. **默认按打包执行**（DEEP-SPEC §2.14）：A 组剩余平均 145 单元/文件，几乎全部落在 <150 的打包档；不打包等于把固定开销乘以文件数，多花 3.8 倍回合。

默认按乙继续推进，不等人；甲/乙 由决策方拍板后替换本节标题下的口径即可。

### 8.10 全量台账审计：1,300 文件 / 115,870 行未落提交（2026-11-10）

全量核对 228 个 `ZC-DEEP-b*.md`、1,411 条「文件 + 行数」登记，逐文件取 `git log -1 --format=%h`、`git diff --numstat`、`git status --porcelain`。逐文件表见 [ZC-LEDGER-AUDIT-2026-11-10.md](ZC-LEDGER-AUDIT-2026-11-10.md)，原始 TSV 在 `_annot_baseline/ledger-audit.tsv`。

| 判定 | 文件数 | 含义 |
| --- | ---: | --- |
| 未提交 | 1,098 | 工作区增量恰等于台账登记行数，仓库里没有对应提交 |
| 部分未提交 | 183 | 工作区增量小于登记行数 |
| 台账与实测不符 | 18 | 17 条是同一文件被多批追加（如 `edit.ts` 登记 95 / 工作区 +246），1 条路径解析不到 |
| 已提交且干净 | 111 | 工作区无改动，末次提交为注释提交 |
| 台账解析失败 | 1 | 台账正文没有文件表 |
| **合计** | **1,411** | **1,300 个文件 / 115,870 行只在工作区，没有提交号** |

四条口径：

1. **覆盖率数字不受影响**。`deep-quality` 量的是工作区，那些注释确实在文件里，所以 §2/§3/§8.4 的 covered / uncovered 没有算错；受影响的是「已完成」这个词——只有 111 个文件能证明落过提交。
2. 因此 §3 与 §8.4 的「18 / 19 个已完成」应读作「**本轮有提交号的** 18 / 19 个」；其余批次的注释内容已在工作区生效，但账上不能标「已提交」。
3. 补提交按 DEEP-SPEC §2.17 的白名单机制分批做：先补本轮要动的 `remoteAssetInstaller.ts`，再按批次号顺序推进；**禁止一次性 `git add -A`**，否则一次提交里混进上百个批次，账彻底对不上。
4. 17 条「超出登记」不是错账，是多批累加——同文件后续批次又加了行；这类文件的真实增量以工作区为准，登记数只代表首次批次。

**A 组的账怎么变**：不变。A 组 39 / 5,649 / 4,833 是从工作区测的，注释存在与否不受提交状态影响；变的是「这些数背后有没有人能在关机后复原」——目前 A 组里凡属 b1–b226 的批次文件，答案是没有。

