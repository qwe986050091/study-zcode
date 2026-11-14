# ZC-DEEP-b43

> 批次：B43（12 文件；含 B42 全部 8 个顺延中的 4 个，按同目录聚成 lib / settings / ai-elements 三组，再补 2 个面板）。
> 执行分三波：5 + 5 + 2（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b43\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b43
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1190

node check-batch.mjs ZC-deep-b43 ZC-deep-b43-files.txt
TOTAL added=1190 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.29   439   326  102   98  packages/ui/src/settings/HooksList.tsx
31.32   485   348  109   98  packages/ui/src/Terminal.tsx
31.34   490   351  110  100  packages/ui/src/settings/usage-stats/UsageHeatmap.tsx
31.35   474   319  100   98  packages/ui/src/components/ai-elements/mic-selector.tsx
31.37   559   408  128  101  packages/ui/src/lib/remoteConnectionWizard.ts
31.43   424   315   99   98  packages/ui/src/DeveloperToolsPane.tsx
31.43   459   315   99   99  packages/ui/src/lib/webElementContext.ts
31.45   496   337  106   99  packages/ui/src/components/ai-elements/context.tsx
31.45   457   337  106   99  packages/ui/src/lib/remoteConnectionPresentation.ts
31.47   508   375  118  100  packages/ui/src/settings/OffPeakTaskList.tsx
31.48   444   324  102  100  packages/ui/src/settings/RemoteSyncActions.tsx
31.50   665   454  143  100  packages/ui/src/components/ai-elements/attachments.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.29 median=31.43 newComments=1190
PASS: all 12 file(s) >= 30% (mode=code)
```

开工前 12 文件基线均为 `newComments=0`（`needLines=1138`）；目标新增按
`round(code × 0.314) − 当前注释行` 逐文件精确分配，合计 1,190 行。
本批 `suspicious=0`，无需改写；两处锚点问题（`UsageHeatmap.tsx` 把单行函数签名写成前缀、
`remoteConnectionWizard.ts` 两个单行签名）在子任务内补全整行锚点解决，未改动源码。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/lib/remoteConnectionWizard.ts` | 远程连接向导模型层 | INV-01~20；步骤文案优先级；表单校验唯一来源与顺序；端口 trim 一致性；凭据互斥；资源包默认覆盖；线路匹配与升级推荐；粘贴解析白名单 | 101 |
| `ui/src/lib/remoteConnectionPresentation.ts` | 远程连接展示投影 | INV-01~18；状态机分支优先级；色调调色板契约；返回体条件展开；地址与设备名脱敏回退；聚合优先级与导航挑选顺序 | 99 |
| `ui/src/lib/webElementContext.ts` | 网页元素上下文采集 | INV-01~16；事件常量协议；workspace 身份 key；载荷判型与最小必填；Markdown 编解码配对；截断与字段省略；围栏解析失败早退 | 99 |
| `ui/src/settings/RemoteSyncActions.tsx` | 远程同步操作区 | INV-01~16；双客户端链路可见性判定；ssh/wsl 目标与 sessionId trim 口径；同步防重入；弹窗意图按 targetKey 绑定并在切目标/断连时清空；preflight 超时仅竞速且 finally 清计时器 | 100 |
| `ui/src/settings/OffPeakTaskList.tsx` | 错峰任务列表 | INV-01~15；排序副本与位次稳定；busy 后缀匹配；菜单按状态互斥与冒泡阻断；提示浮层翻向策略；resize 监听生命周期；状态图标穷尽映射；空态与模型修复脚注优先级 | 100 |
| `ui/src/settings/HooksList.tsx` | 设置页 Hooks 列表 | INV-01~20；分区顺序契约；插件分组键退化与稳定排序；空态占位唯一入口；三态 disabled 组合；事件冒泡阻断；异步 void 调用 | 98 |
| `ui/src/settings/usage-stats/UsageHeatmap.tsx` | 用量热力图 | INV-01~16；52 周固定网格与 UTC 日索引；空日期早退不造假网格；level 1~4 与柱高 1~7 归一化；累计前缀和；三种提示文案键与 countMetric 对应；月份标签 span 恒等 | 100 |
| `ui/src/components/ai-elements/context.tsx` | 上下文用量组件 | INV-01~18；额度透传与除零/钳制；Provider 缺失即抛错；useMemo 依赖；环形图周长与进度条百分比口径；children 优先与 loading 语义；分项费用去重；0 与 undefined 语义区分 | 99 |
| `ui/src/components/ai-elements/attachments.tsx` | 附件展示与预览 | INV-01~12；source-document 归类优先级；mediaType 空值保护；图片/视频预览分支顺序与 objectUrl 失效；variant 上下文兜底与严格抛错差异；defaultPrevented 与冒泡顺序；hook 数量稳定性 | 100 |
| `ui/src/components/ai-elements/mic-selector.tsx` | 麦克风设备选择 | INV-01~16；设备枚举与权限申请时序；临时流逐轨释放；devicechange 监听成对增删；受控/非受控状态；ResizeObserver 宽度测量与 0 宽丢弃；deviceId 后缀正则与标签双空格权衡 | 98 |
| `ui/src/Terminal.tsx` | 终端面板 | INV-01~13；workspaceKey 归一化与隔离；panelState 唯一写入入口与函数式更新；手动关闭不杀 PTY；PTY 退出必删 tab；跨 workspace 保活与差集回收；activeSession 回退；tab 编号最小空位 | 98 |
| `ui/src/DeveloperToolsPane.tsx` | 开发者工具面板 | INV-01~16；只读投影边界；缺失值短横线口径；比率与时间格式化；statusType 穷尽映射；headers 副本排序与原生折叠；网络条目副本倒序 | 98 |

合计 **1,190**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 手动关闭终端页签不能杀 PTY

`Terminal.tsx` 把「关闭面板」和「终止进程」拆成两条路径：手动关闭只从可见集合里移除，PTY 继续保活。
合并后用户切走再切回会拿到新进程，正在跑的构建当场中断——且不会有任何提示。

### 2. 热力图空日期必须早退，不能补零网格

`UsageHeatmap.tsx` 在数据为空时直接返回空态。补零会渲染出满屏 0 值格子，
用户无法区分「没有数据」和「这段时间真的一次没用」。

### 3. 网页元素上下文的 Markdown 编解码必须成对演进

`webElementContext.ts` 的序列化与解析共用同一套字段省略与截断规则。只改一侧，
解析会把被截断的围栏当完整内容，注入给模型的是半截元素信息。

### 4. 远程同步弹窗意图必须按 targetKey 绑定

`RemoteSyncActions.tsx` 的弹窗意图带 targetKey，切换目标或断连即清空。
去掉后旧目标上的确认会在新目标上执行，表现是「确认同步 A，实际改了 B」。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 关闭终端页签同时杀 PTY | 切走再切回，正在跑的构建中断 |
| 热力图空数据补零 | 满屏 0 值格子，无法区分无数据与真零 |
| 编解码单侧改动 | 模型收到被截断的元素信息 |
| 远程同步意图不绑 targetKey | 确认 A 却改了 B |
| 设备枚举与授权顺序颠倒 | 首次打开麦克风列表为空，需重开面板 |
| 临时流不逐轨释放 | 麦克风指示灯常亮 |
| 附件预览不校验 mediaType 空值 | 空类型被当图片渲染，出现破图 |
| 用量分项不去重 | 费用被重复累加，总额虚高 |
| Hooks 分区顺序漂移 | 设置页顺序随插件加载顺序抖动 |
| 终端保活不做差集回收 | 已删除工作区的 PTY 长期占用内存 |

## 顺延

B43 复算清单为 20 文件，本批取 12 个（含 B42 顺延中的 4 个），其余 8 个顺延到 B44（缺口各 94~96 行）：
`packages/ui/src/hooks/useGitBranchSwitcher.ts`（96）、
`packages/ui/src/presentation/presentationPdfPrintExport.ts`（96）、
`packages/desktop/src/main/browserView/browserPlaywrightExecutor.ts`（95）、
`packages/web/src/web-remote-control/ui/webRemoteControlDeviceListPage.tsx`（95）、
`packages/ui/src/plugin-ui/app/pluginUiHostController.ts`（94）、
`packages/ui/src/project-sidebar/useProjectTree.ts`（94）、
`packages/ui/src/remote-connection/RemoteConnectionSelection.tsx`（94）、
`packages/ui/src/v4/telemetry/localTtftObserver.ts`（94）。

> 说明：每文件独立 spec（≤150 行），5 文件一组并行（并发上限 5），逐文件密度校验。
> 本批无 `suspicious`；2 处锚点问题在子任务内解决，未改动源码。
