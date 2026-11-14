# L2-B11：desktop host 目录注释索引

> 批次范围：`packages/desktop/src/host/`（含 `database-startup/`、`pluginSandbox/`）下全部非测试 `.ts/.tsx`，
> 排除 `dist/`、`node_modules/`、`fixtures/`；本批为覆盖审计中唯一未纳入索引的区域。
> 目标：按 L2 标准补注释（职责 / 输入输出口径 / 副作用 / 失败语义 / 维护的不变量 / 非平凡分支的「为什么」），
> 重点覆盖大纲不变量 #18：desktop attachment 的 `clientMode` / `generation(seq)` / `dispose` 语义。
> 硬约束：只新增注释行与紧邻空行；逐文件 `git --no-pager diff --no-index --numstat 基线 当前` 删除列必须为 0；
> 每文件 `parseDiagnostics=0` 且 `/*` 与 `*/` 计数相等；基线目录 `d:\code\_annot_baseline\L2-B11\host\`。

## 文件索引

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `windowHostAttachmentRegistry.ts` | 窗口级 attachment 账本（attach/detach/代际清理/dispose） | #18 三要素全量口径：clientMode 归属、generation 代际清理、dispose 幂等；替换语义与 port close 竞争 | +63 |
| `windowHostAttachmentRpcPolicy.ts` | 按 clientMode 决定服务暴露面（手机白名单 / 桌面全量） | fail-closed 白名单、为何不能用 denylist、窗口目录服务另组一套、整体失败不发布半套 | +39 |
| `windowHostControllerProjection.ts` | 任务/工作区投影与 V4 增量帧 | logEpoch + seq 单调语义、resync 基线、离线只降级不删除、provisional 撤销不发帧 | +61 |
| `promptAttachmentTransferService.ts` | 远端 prompt 附件暂存传输 | operationId 唯一 owner、跨 await 的 isCurrent 校验、cancel/dispose 与远端文件回收 | +39 |
| `remotePromptAttachments.ts` | 远端附件物化与清理 | 私有根目录与 700/600 权限、HOME 绝对路径校验、失败时尽力回收、路径改写倒序替换 | +37 |
| `conversationShareAttachmentService.ts` | 纯 re-export | 按约定跳过（纯 re-export 不注） | 0 |
| `automationModelSelection.ts` | Automation 提交的模型选择收敛 | fixedSelection 优先、getView 校验、失败即派发失败 | +14 |
| `botGroupTaskScope.ts` | 群任务路由 scope 绑定 | attachment scope 覆盖 RPC 入参、source-settings 拒绝 | +13 |
| `cronBotDelivery.ts` | 定时任务 Bot 终态订阅 | 派发前订阅、无目标返回 false、失败冒泡 | +14 |
| `cronRunLifecycle.ts` | run claim / 终态回写 / manual claim 释放 | best-effort 语义、释放时机、心跳 dispose | +33 |
| `botRemoteWorkspaceResolver.ts` | Bot 远程工作区（R3）解析 | legacy 消歧、generation→runtimeKey、歧义返回 null | +23 |
| `browserRecordingArtifactMaterializer.ts` | 录制 WebM 落盘/上传 | workspace 逃逸校验、staging+rename、远端 posix 规范 | +21 |
| `offPeakDispatchPlan.ts` | 闲时派发形态与可派发性 | 三分支判定、permanent/transient 错误分类 | +19 |
| `windowTopicResourceRelay.ts` | topic 资源反向请求中继 | peer 实例级校验、fail-closed、bots 能力要求 | +17 |
| `taskRealtimeBridge.ts` | Host↔main 任务实时桥 | pending 关联、eventId 去重窗口、dispose 拒绝悬挂 | +33 |
| `browserControlMainBridge.ts` | Host↔main 浏览器控制桥 | requestId 关联、generation/clientMode 透传、超时 sideEffect | +45 |
| `hostAgentResourceTelemetry.ts` | CLI 资源样本透传 | 只透传不统计、environmentKey 条件写入、发送失败吞掉 | +15 |
| `hostMcpResourceTelemetry.ts` | MCP 进程树资源样本透传 | 按批转发、不改顺序、失败只丢当前批 | +12 |
| `hostMcpTelemetry.ts` | MCP 生命周期遥测透传 | 事件原样透传、disposable 归属 | +11 |
| `hostNetworkTelemetry.ts` | 网络遥测批量回传 | 满批/定时双触发、utilityProcess parentPort、stop 顺序 | +23 |
| `hostNetworkCapture.ts` | 抓包批次出口 | 两层 capture 同步 captureId、旁路不抛错 | +16 |
| `hostResourceTelemetryEnvironment.ts` | 环境身份哈希 | 规范身份 sha256、不泄漏原始地址、同规格不合并 | +11 |
| `hostToolExecResourceTelemetry.ts` | 工具执行完成事实透传 | completionToken 原值、失败只丢当前条 | +12 |
| `hostSelfResourceTelemetry.ts` | Host 自身资源遥测 | 单定时器双出口、同一次读数、无 parentPort 只写日志 | +12 |
| `hostServiceResourceTelemetry.ts` | collection 级遥测聚合订阅 | 缺能力 fail-safe、注册失败整体回滚、dispose 幂等 | +22 |
| `hostSessionCreateTelemetry.ts` | session_create 埋点 | 仅真实新建、整体 try/catch、client_kind 固定 | +15 |
| `hostMemoryDiagnosticsLog.ts` | Host 内存诊断日志 | 60s 采样、门控语义、遥测先于门控、stop 幂等 | +22 |
| `hostLog.ts` | 日志参数序列化与过滤 | Error/cause 递归序列化、Node 警告过滤、永不抛错 | +19 |
| `rpcLogLevel.ts` | RPC 日志分级 | FAIL→warn、轮询成功→debug、provider-not-ready→info | +14 |
| `hostInitialization.ts` | transport 临时所有权交接 | 初始化失败本地清理、deadline、原始错误不覆盖 | +14 |
| `hostShutdownPhases.ts` | 关闭阶段串行执行器 | 串行原因、逐 phase deadline、超时不取消 | +17 |
| `hostUncaughtExceptionGuard.ts` | 进程级异常分级守卫 | 仅隔离指定分配错误、上报失败不抛出、不放宽判定 | +18 |
| `hostMessagePortGuard.ts` | 消息入口 port 守卫 | 失败必须 close 全部 port、成功不提前 close | +20 |
| `hostWorkspaceTaskTracker.ts` | workspace 任务计数 | key 归一、begin 幂等、ACK≠空闲、总量非负 | +21 |
| `hostResourceUsage.ts` | 资源快照响应器 | 单轮 in-flight、不排队、abort 后不迟到回帖 | +25 |
| `hostRemoteWorkspaceProxyState.ts` | 远端代理层 workspace 账本 | 按 workspace 清理、同步 replay、订阅替换 | +27 |
| `startupDiskSampler.ts` | 启动期磁盘余量采样 | dev scope 聚合、busy 单轮、封基线后不计跌幅 | +38 |
| `electronPort.ts` | MessagePortMain→MessagePortLike 适配 | 事件风格差异、成对 listener、不吞异常 | +14 |
| `e2eCoverage.ts` | E2E 覆盖率主动落盘 | 环境开关、退出路径不抛出、flush 时机 | +12 |
| `pluginSandbox/contract.ts` | 插件沙箱登记桥合约 | 三方法职责、pending 传输、事实不在本桥 | +11 |
| `pluginSandbox/index.ts` | 登记桥实现 | 先登记再 send、回包缺字段即失败、dispose 拒绝悬挂 | +26 |
| `database-startup/contract.ts` | Worker 消息合约 | strict schema、progress phase 顺序、failed 必带错误码 | +13 |
| `database-startup/module.ts` | 模块清单 | requires/provides 与 policy 一致、入口边界 | +3 |
| `database-startup/contract.example.ts` | 合约示例 | 示例也走 parse、schema 变更同步 | +9 |
| `database-startup/hostDatabaseStartup.ts` | 启动期库准备编排 | 采样→内部库→会话库→services、失败显式、cwd 去重 | +19 |
| `database-startup/storagePreparationProcesses.ts` | 两条 Worker 存储准备路径 | 退出判定、30s 首帧超时、abort 监听清理、realpath 复用 | +30 |
| `database-startup/tasksStorageWorker.ts` | tasks-index Worker 入口 | 帧协议、异常转 failed、finally 关端口、旧设置参与迁移 | +11 |
| `databaseStartupCoordinator.ts` | 启动状态机与发布 | attemptId fencing、sequence 单调、publish 失败吞掉 | +21 |
| `connectDesktopSourceServer.ts` | Desktop 连接 Source 的入口 | 每代物理连接重建私有能力、mode 同步时机、双清理 | +18 |
| `connectSourceServerTarget.ts` | Host 手动连接入口 | deferCredentials、仅认证 flight 提交凭据、复用保留原 profile | +16 |
| `remoteProviderProvisioningService.ts` | 本地→远端 Provider 配置同步 | WeakMap 私有执行器、错误码归因、成功不带诊断字段 | +26 |
| `remoteWorkspacePreparation.ts` | 远端 workspace 校验与身份绑定 | `/.` 遍历校验、ELOOP 归入不可用、abort 优先 | +17 |
| `remoteWorkspaceRpcContract.ts` | 远端 RPC channel 合约 | 版本演进、缺失一次性报错、类型收窄 | +17 |
| `remoteDynamicWorkflowUserMode.ts` | 动态工作流用户选择推送 | 仅 desktop-attached、server 静默跳过、逐连接隔离 | +3 |
| `remoteMediaPreviewProxyHelpers.ts` | 媒体预览纯工具层（背压/Range/路径/错误回写） | drain 单次结算、Range 三态、headersSent 后 destroy | +35 |
| `remoteMediaPreviewProxy.ts` | remote attachment 专属媒体预览代理 | lease 生命周期、scopeKey 固化、token 轮换、409 先于写头 | +45 |
| `remoteWorkspaceServiceCollection.ts` | server remote 服务集合装配 | 合同逐项一致、缺失即整体失败、Provider 单向下发 | +41 |
| `serverRemoteConnection.ts` | Desktop 直连/duplex 物理连接 | 端点归一、握手所有权、失败回收、capability 准入 | +55 |
| `serverRemoteDuplexTransport.ts` | 隧道上的 HTTP/WS 传输适配 | 单隧道复用 fail-fast、Socket 形状补齐、首帧先订阅 | +35 |
| `sourceServerMigrationCounts.ts` | 迁移统计异步投影 | 连接对象身份代际、合并刷新、不发布半份数字 | +20 |
| `sourceServerRecoveryPolicy.ts` | 自动恢复终态与 close 事件映射 | 仅 retrying 可恢复、终态四类、字段透传 | +20 |
| `sourceServerStartupReconnect.ts` | 启动静默重连门禁 | 已有完整注释，无需补注（已满足） | 0 |
| `sourceServerOperationLogs.ts` | Source 维度操作日志账本 | sequence 占位、旧 run 丢弃、ssh 秘密脱敏 | +28 |
| `sourceSettingsServiceCollection.ts` | source-settings 服务面装配/摘除 | 桌面专属白名单、仅 online 代际可服务 | +21 |
| `sourceServerManagementService.ts` | Source 管理服务（快照+命令） | generation 双读校验、删除三步序、attachment 清理钩子 | +62 |
| `sourceServerReleaseResolver.ts` | 发行包解析（本地/远端/开发） | 三来源优先、绝不静默回退、原子缓存与 SHA 校验 | +43 |
| `windowHostSessionsIndexObserver.ts` | sessions-index V4 被动观察 | logEpoch+seq 基线、ACK 前有界暂存、runtime 换代清空 | +21 |
| `sourceServerConnectionManager.ts` | Source 连接代际状态机（connect/重连/更新/断开） | online owner 身份判定、迟到成功只释放不发布、终态停自动恢复 | +93 |
| `sourceServerDirectory.ts` | Source/Profile/Workspace 持久化事务 | writeChain 串行、身份替换换新 profileId、凭据回滚 | +93 |
| `windowRemoteConnectionRegistry.ts` | 窗口级远程连接/会话注册表 | #18 全量：scope fail-closed、generation 换绑、两层 dispose | +110 |
| `windowHostControllerService.ts` | Controller 投影聚合运行时 | refresh 代际校验、replacement 链、attachment 级 dispose | +75 |
| `index.ts` | Window Host 进程入口（无导出） | 扩写文件头：#18 在 attach/expose/handle/两层释放的落点 | +9 |
