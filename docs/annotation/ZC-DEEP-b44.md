# ZC-DEEP-b44

> 批次：B44（12 文件；B43 顺延的 8 个全部纳入，再按同目录补 `v4` / `lib` / `root` / `onboarding` 各 1 个）。
> 执行分三波：5 + 5 + 2（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b44\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b44
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1184

node check-batch.mjs ZC-deep-b44 ZC-deep-b44-files.txt
TOTAL added=1184 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.28   471   358  112   98  packages/ui/src/project-sidebar/useProjectTree.ts
31.31   445   329  103   99  packages/desktop/src/main/browserView/browserPlaywrightExecutor.ts
31.31   539   396  124   98  packages/ui/src/v4/V4InteractionDialogs.tsx
31.33   472   332  104   97  packages/ui/src/lib/toolIdentity.ts
31.33   556   399  125  101  packages/ui/src/presentation/presentationPdfPrintExport.ts
31.35   523   386  121   98  packages/ui/src/root/useRootOAuthEffects.ts
31.36   475   354  111   98  packages/ui/src/plugin-ui/app/pluginUiHostController.ts
31.44   440   334  105   98  packages/ui/src/v4/telemetry/localTtftObserver.ts
31.46   517   391  123   98  packages/ui/src/onboarding/OccupationOnboarding.tsx
31.48   505   359  113  101  packages/ui/src/hooks/useGitBranchSwitcher.ts
31.51   412   311   98   98  packages/ui/src/remote-connection/RemoteConnectionSelection.tsx
31.52   447   330  104  100  packages/web/src/web-remote-control/ui/webRemoteControlDeviceListPage.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.28 median=31.35 newComments=1184
PASS: all 12 file(s) >= 30% (mode=code)
```

开工前 12 文件基线均为 `newComments=0`（`needLines=1130`），不存在上次「输出窗口超限」
残留的半插入文件；目标新增按 `round(code × 0.314) − 当前注释行` 逐文件精确分配，合计 1,184 行。
本批 `suspicious=0`，无需改写；3 个子任务出现「首轮多算 1 行」，均按规程用基线快照回退后
重插至精确行数，未改动任何源码 token。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/hooks/useGitBranchSwitcher.ts` | Git 分支切换 hook | INV-01~18；watcher 回灌后快照失效与丢弃策略；展开即重拉；失败转阻塞卡片后重试；mutationPending 互斥位与 finally 复位；no-op 切换不刷新全局；本地投影先于全局刷新；身份缺失/空路径失败路径 | 101 |
| `ui/src/presentation/presentationPdfPrintExport.ts` | 演示文稿 PDF 打印导出 | INV-01~20；打印 DOM 属性握手与 print/screen 样式契约；Skia 丢字黑名单与 macOS 字体替换探测；字体栈解析状态机与回退链；离屏量宽缓存；逐页渲染与顺序就绪等待；句柄倒序释放与失败清场 | 101 |
| `desktop/src/main/browserView/browserPlaywrightExecutor.ts` | Playwright 执行器 | INV-01~17；隔离世界与 returnByValue 可序列化约束；运行时函数不得引用模块作用域；overlay 幂等与 finally 清理；poll 截止时间跨阶段扣减与取消优先；networkidle 显式拒绝；URL 严格匹配与通配转义；abort 终止 | 99 |
| `web/src/web-remote-control/ui/webRemoteControlDeviceListPage.tsx` | 远程控制设备列表页 | INV-01~15；view 唯一事实源与 selectable 准入；在线/离线分组互斥；重名 MID 仅作展示；单连接直选与多连接弹层；sheetDeviceMid 派生失效；错误/加载/空态优先级 | 100 |
| `ui/src/plugin-ui/app/pluginUiHostController.ts` | 插件 UI 宿主控制器 | INV-01~20；phase 状态机推进；dispose 幂等与摘链顺序；prepare 期间卸载的双重清理；端口代际过滤；握手只首次生效；notify 丢弃策略；回收期间关闭通知挂起 | 98 |
| `ui/src/project-sidebar/useProjectTree.ts` | 项目树 hook | INV-01~18；目录服务整组取自同一 Source；serial 丢弃过期快照；flight/dirty 合并刷新；accepted 快照比对与自动归档清理；首发 pending 的提交/取消/结算；scopes 身份去重与观察换代 | 98 |
| `ui/src/remote-connection/RemoteConnectionSelection.tsx` | 远程连接选择 | INV-01~18；筛选只读快照；快照缺失安全；无档案行禁用；退役档案/最近目录回退语义；WSL/Docker 门控；懒加载与空态互斥；方向键取模排除禁用项 | 98 |
| `ui/src/v4/telemetry/localTtftObserver.ts` | 本地 TTFT 观测 | INV-01~15；点击起点与关闭开关；容量与回收顺序；首输出冻结与重复帧水位；initial/resync/recovery 三种投递语义；身份合并守卫；时钟校准与休眠判定；TTL 资源回收 | 98 |
| `ui/src/v4/V4InteractionDialogs.tsx` | 交互弹窗集合 | INV-01~20；pendingInteractions 选取与 workspaceHookReview 边界；快照 sessionId 校验；Bot 逐题进度覆盖与弹窗 key；snooze 单飞与失败回退；权限应答单飞与 ACK 语义；草稿写入与剪枝 | 98 |
| `ui/src/lib/toolIdentity.ts` | 工具身份判定 | INV-01~15；身份判定顺序即契约；toolName→kind→raw→zcode meta 候选优先级；legacy agent/title 先后手；TodoWrite/Goal 仅作 legacy 映射；legacy kind 正则家族顺序；unknown 共享常量只读 | 97 |
| `ui/src/root/useRootOAuthEffects.ts` | 根级 OAuth 副作用 | INV-01~20；登录收尾编排顺序与门控条件；三个仲裁 ref 与轮询串行/归属登记；CAS 冲突与迟到回调不可回写成功态；卸载守卫与订阅释放 | 98 |
| `ui/src/onboarding/OccupationOnboarding.tsx` | 职业引导弹窗 | INV-01~15；三源可见性合成；savingRef 双保险；occupation/mode 的 null 跳过语义；预填与用户编辑竞态；keydown 捕获阶段拦截；5 秒记录超时；记录失败不回滚设置 | 98 |

合计 **1,184**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. TTFT 首输出必须冻结，重复帧不得推高水位

`localTtftObserver.ts` 在第一次拿到输出时把首输出时间冻结，后续重复帧只做去重不重算。
若允许覆盖，重连或 resync 带来的迟到帧会把首字时间整体后移，指标会随网络抖动漂移，
而用户看到的界面延迟并没有变化。

### 2. 插件宿主 dispose 必须幂等，且端口按代际过滤

`pluginUiHostController.ts` 的回收路径可被「prepare 期间卸载」再触发一次。重复摘链会二次
注销同一个端口；不按代际过滤则旧端口的迟到消息会被当成本代握手，表现是插件面板闪回旧内容。

### 3. 项目树快照按 serial 丢弃，不能「后到先赢」

`useProjectTree.ts` 用单调 serial 判定过期快照。网络乱序时，旧 serial 的结果如果落盘，
会把已经展开的目录打回收起状态——用户正在点的节点会突然消失。

### 4. Playwright 隔离世界里的运行时函数不得引用模块作用域

`browserPlaywrightExecutor.ts` 通过 `evaluate` 注入的函数会被序列化后在页面内重建，
任何对模块级变量/辅助函数的引用在页面侧都不存在。改错时表现为 `xxx is not defined`，
且错误只在真实浏览器里出现，单测（jsdom）不会暴露。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 首输出时间允许被后续帧覆盖 | TTFT 指标随网络抖动漂移 |
| 插件宿主 dispose 不幂等 | 端口被二次注销，插件面板空白 |
| 端口消息不按代际过滤 | 旧代际消息触发握手，面板闪回旧内容 |
| 项目树快照不按 serial 丢弃 | 已展开节点被打回收起 |
| 分支切换 no-op 仍刷新全局 | 无用重渲染，输入框失焦 |
| PDF 导出句柄不倒序释放 | 大文档导出后进程内存不回收 |
| 设备列表不按 selectable 准入 | 离线设备可点，进入后立即报错 |
| 远程连接无档案行不禁用 | 点击后停在空面板无提示 |
| 工具身份判定顺序被调整 | 同一工具在 UI 上换名字，历史记录归类错乱 |
| OAuth 迟到回调回写成功态 | 已登出的账号被重新标记为已登录 |

## 顺延

B44 复算清单为 20 文件，本批取 12 个，其余 8 个顺延到 B45（缺口各 91~93 行）：
`apps/zcode-cli/packages/core/src/agent/message-history.ts`（93）、
`apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-multiword-gh.ts`（93）、
`apps/zcode-cli/packages/tui/src/app.tsx`（93）、
`packages/zcode-server-cli/src/runtime/componentCache.ts`（93）、
`packages/web/src/web-remote-control/domain/webRemoteControlScreenCopy.ts`（92）、
`apps/zcode-cli/packages/cli/src/tui-prompt-handler.ts`（91）、
`apps/zcode-cli/packages/core/src/tool/handlers/bash-command-permission-policy.ts`（91）、
`packages/desktop/src/main/chromeInstallationCandidates.ts`（91）。

> 说明：每文件独立 spec（≤150 行），5 文件一组并行（并发上限 5），逐文件密度校验。
> 本批无 `suspicious`；3 处「多 1 行」由子任务自行回退快照后重插，未改动源码。
