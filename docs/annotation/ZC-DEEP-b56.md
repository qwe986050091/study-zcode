# ZC-DEEP-b56

> 批次：B56（12 文件，复算缺口 880 行；按当前工作树复算，优先同类/同目录：`ui/src` 7 个（`components/ai-elements`、`root`、`ToolCallBlocks`、`v4/composer`、`app-shell`、`git-graph`、`lib`、`settings`）、`desktop/src/main` 4 个（含 `browserView`、`mcpUserDirectory`）、`core/runtime/methods` 1 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b56\orig`；开工前 12 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b56
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=926

node check-batch.mjs ZC-deep-b56 ZC-deep-b56-files.txt
TOTAL added=926 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.32   492   364   114   77  apps/zcode-cli/packages/core/src/runtime/methods/compact-persistence.ts
31.33   554   399   125   78  packages/ui/src/settings/automationFormat.ts
31.34   669   485   152   80  packages/ui/src/v4/composer/useDraftSessionPrewarm.ts
31.35   364   252    79   76  packages/desktop/src/main/mcpUserDirectory/claude.ts
31.36   457   338   106   77  packages/ui/src/app-shell/types.ts
31.37   441   322   101   78  packages/ui/src/ToolCallBlocks/ToolLayout.tsx
31.44   373   264    83   76  packages/desktop/src/main/browserView/browserTabRecoveryStore.ts
31.44   375   264    83   76  packages/desktop/src/main/windowsInstallResourceLocks.ts
31.45   406   283    89   78  packages/ui/src/components/ai-elements/mermaid-block.tsx
31.45   364   248    78   76  packages/ui/src/lib/codeCommentContext.ts
31.50   438   327   103   78  packages/ui/src/root/reconnectRemoteWorkspaceHistoryEntry.ts
31.54   341   241    76   76  packages/ui/src/git-graph/layout.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.32 median=31.40 newComments=926
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/ai-elements/mermaid-block.tsx` | Mermaid 图渲染块 | INV-01~18；异步渲染队列与执行时机；renderKey 含主题键+代码哈希防竞态；主题切换重读 token 与系统配色监听；语法错误降级为 plaintext；空代码短路；卸载取消标记与探针节点清理 | 78 |
| `ui/root/reconnectRemoteWorkspaceHistoryEntry.ts` | 远程工作区重连历史条目 | INV-01~18；身份键 `identity?.trim() \|\| path` 回退；进度键登记/去重/finally 移除；目标快照与凭据同源；SSH 凭据继承与 override；`requireStoredCredentials` 结构化失败；Host ready 分阶段通知；tab upsert 与 identity 迁移 | 78 |
| `ui/ToolCallBlocks/ToolLayout.tsx` | 工具调用块布局 | INV-01~19；模块级展开表生命周期与诊断计数；300ms 延迟卸载与 Radix 高度测量；受控/非受控与 forceOpen 硬锁；autoOpen 一次性与 running→completed 边沿；renderContent 惰性求值；复制冒泡隔离 | 78 |
| `ui/v4/composer/useDraftSessionPrewarm.ts` | 草稿会话预热 hook | INV-01~18；enabled 与 owner 三元组去重；coordinator 复用；single-flight 单飞闸与 completion 一次性释放；invalidationVersion 变化重跑与 retire 收口；StrictMode 延迟 cleanup；dispose/mark* 状态机；ACK 晚到就地删除；有界退避与失败静默 | 80 |
| `core/runtime/methods/compact-persistence.ts` | 压缩时间线持久化 | INV-01~19；timeline part 必须先于 compaction part；partId 复用导致覆盖写；恢复只收敛 started/retrying；boundary 是摘要已提交的唯一证据；字段缺省演进；事务化写入与 best-effort 回滚账本 | 77 |
| `desktop/main/browserView/browserTabRecoveryStore.ts` | 浏览器页签崩溃恢复存储 | INV-01~19；单文件键空间与双表提交；schemaVersion/窗口绑定不落盘；mutationQueue 串行（明确「串行而非去抖」的代价）；原子落盘与临时文件清理；三档容量裁剪与 LRU；损坏文件隔离；会话隔离三键过滤与稳定排序 | 76 |
| `desktop/main/mcpUserDirectory/claude.ts` | Claude MCP 用户目录适配 | INV-01~20；state 覆盖原生配置与 workspace 覆盖顺序；路径归一化与 Windows 大小写容错；坏 JSON 视为空、写回 `?? {}` 补位；upsert 落点路由与双侧 delete；未知顶层键保留与 `projects` 其它工作区透传；原子写与 2 空格缩进；未注册 source 立即抛错 | 76 |
| `desktop/main/windowsInstallResourceLocks.ts` | Windows 安装资源锁 | INV-01~20；跨进程互斥（Invoke 脚本排除自身 PID、路径归一化）；超时与输出上限；taskkill 与 750ms 句柄交接窗口；各阶段降级为 errors 不阻断 NSIS；PID 去重与探针 sentinel 双文件清理；可写性三步往返判定 | 76 |
| `ui/app-shell/types.ts` | 壳层类型契约 | INV-01~19；WorkspaceShellZCodeState 与 CreateTask 选项；RemoteWorkspaceRecoveryStatus 状态集；DeviceAdditionResult 与返回目标；RemoteConnectionOpenPreference；AppProps 与 WorkspaceShellLayoutProps 的 Omit 继承边界 | 77 |
| `ui/git-graph/layout.ts` | 提交图布局算法 | INV-01~19；行序与提交顺序；车道分配与回收；laneCount 三处上界；合并边与 truncated；lockedFirst 曲线方向；边/路径 id 稳定性；纯函数确定性；空输入与边界提交；宽高公式 | 76 |
| `ui/lib/codeCommentContext.ts` | 代码评论上下文 | INV-01~19；行号/选区归一；路径与版本；范围合并；解析不改入参；markdown 生成与 prompt 拼接的块边界；工作区归属 | 76 |
| `ui/settings/automationFormat.ts` | 自动化计划格式化 | INV-01~19；cron 组装/反解析（步长 59/24/31 降级、5 段校验、判定链顺序）；GMT 偏移与 intl 消息 id；非法输入回退与往返回比；复数与 1-5 工作日文案；失败态与重试队列；卡片 30 天阈值 | 78 |

合计 **926**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 压缩时间线必须先写 timeline part

`compact-persistence.ts` 固定先落 timeline 再落 compaction。
顺序颠倒时崩溃会留下「有摘要但无时间线」的状态，恢复逻辑找不到 boundary，压缩结果被整体丢弃。

### 2. 页签恢复存储是串行而非去抖

`browserTabRecoveryStore.ts` 用 mutationQueue 串行化每次写入，而不是合并延迟写。
去抖会让崩溃前最后一刻的页签变化丢失，用户重启后回到更早的标签页集合。

### 3. 未注册的 MCP source 必须抛错

`mcpUserDirectory/claude.ts` 的路径解析依赖 source descriptor，未注册时立即抛错。
静默回退到默认目录会把 Claude 配置写进 ZCode 自己的目录，两套配置互相覆盖。

### 4. 车道回收不能复用仍活跃的边

`git-graph/layout.ts` 只在父提交都已分配后回收车道。
提前复用时，跨分支的合并边会连到错误的提交上，历史图出现指向错乱的连线。

### 5. 预热必须单飞

`useDraftSessionPrewarm.ts` 用 single-flight 闸门保证同一 owner 只有一次在途预热。
并发发起会重复创建草稿会话，用户看到多个空会话窗口。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 压缩先写摘要后写时间线 | 崩溃后恢复丢压缩结果 |
| 页签恢复写入去抖 | 重启后丢失最后几个标签页 |
| 未注册 source 静默回退 | Claude 配置写进 ZCode 目录互相覆盖 |
| 车道提前复用 | Git 图连线指向错误提交 |
| 预热不单飞 | 出现多个空草稿会话 |
| Mermaid 不按 renderKey 防竞态 | 主题切换时旧图覆盖新图 |
| ToolLayout forceOpen 被 autoOpen 覆盖 | 用户手动展开的块又被收起 |
| 重连历史不去重进度键 | 同一条目重复显示、进度重复 |
| 安装锁不在异常路径释放 | 下次安装被自身残留锁阻塞 |
| cron 步长不夹取 | 生成非法表达式，自动化永不触发 |
| 代码评论范围不合并 | 同一文件出现多条重叠评论 |

## 观察（未改动）

`mcpUserDirectory/claude.ts` 的 `buildNativeConfigPath` 依赖 `getSourceDescriptor`，而当前
`MCP_SOURCE_DESCRIPTORS` 仅注册 `zcodeagentmcp`，`packages/desktop/test/mcpZcodeAgent.test.ts` 也断言
`getSourceDescriptor("claudeclimcp")` 抛错。注释按「未注册 source 立即抛错」陈述实际行为，未改代码；
若这是待修缺陷需另行确认。

## 顺延

B56 复算清单共 20 个候选，本批取 12 个，其余顺延到 B57，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 `suspicious=0`；全部文件按 `round(code × 0.314) − 当前注释行` 精确补行，密度落在 31.32%~31.54%。
