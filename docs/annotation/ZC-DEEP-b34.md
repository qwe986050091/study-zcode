# ZC-DEEP-b34

> 批次：B34（12 文件，跨 8 个模块；本批优先消化 B32/B33 顺延的 8 个文件，再补 4 个 UI 文件）。
> B34-A：dev-docs 1 + desktop scripts 1 + server 1 + desktop main 2 + core 1 + zcode-server-cli 1 + shared 1（+1,016 行）；
> B34-B：`packages/ui` 4 文件（+488 行）。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b34\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b34
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1504

node check-batch.mjs ZC-deep-b34 ZC-deep-b34a-files.txt
TOTAL added=1016 hardBad=0 suspicious=0

node check-batch.mjs ZC-deep-b34 ZC-deep-b34b-files.txt
TOTAL added=488 hardBad=0 suspicious=0
```

逐文件密度（列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.33   875   600  188  122  packages/ui/src/components/ai-elements/prompt-input.tsx
31.37   574   424  133  120  packages/ui/src/settings/InstalledPluginManagement.tsx
31.38   881   615  193  123  packages/ui/src/store/tabStore.ts
31.38  1307   940  295  130  packages/shared/src/zcode-protocol-v4/transport.ts
31.39   542   411  129  128  packages/desktop/scripts/gen-ui-fixture/main.ts
31.44   798   582  183  131  apps/dev-docs/src/feature-boundary-graph/FeatureBoundaryGraphView.tsx
31.45   605   442  139  125  packages/desktop/src/main/chromeCookieManager.ts
31.45   900   655  206  123  packages/ui/src/v4/sessionsIndexStore.ts
31.48   858   594  187  126  apps/zcode-cli/packages/core/src/permission/service.ts
31.49   739   543  171  126  packages/zcode-server-cli/src/supervisor/supervisor.ts
31.49   607   435  137  126  packages/server/src/remote/zcodeAgentDevDeploy.ts
31.51   601   438  138  124  packages/desktop/src/main/browserView/electronBrowserWebmRecorder.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.33 median=31.45 newComments=1504
PASS: all 12 file(s) >= 30% (mode=code)
```

开工前 12 文件基线均为 `newComments=0`；`zc-verify` 的 `added=1504`
与两组子批 `check-batch` 合计（1,016 + 488）一致，也与逐文件目标合计一致。
`// INV-` 条数：12~16 条/文件。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `apps/dev-docs/.../FeatureBoundaryGraphView.tsx` | 开发者文档站的能力边界图视图 | INV-01~15；图数据为模块级只读快照；`flowNodes/flowEdges` 只派生不回写；坐标只来自 layout，视图内不重算 | 131 |
| `packages/desktop/scripts/gen-ui-fixture/main.ts` | 桌面 UI fixture 生成脚本入口 | INV-01~14；`argv[2]` 缺失立即失败；userData 钉在 `join(root, "profile")`；离线检查在 app ready 前安装 | 128 |
| `packages/server/src/remote/zcodeAgentDevDeploy.ts` | 开发用 agent bundle 的远端部署 | INV-01~12；非 development 不做远端写入；devVersion 覆盖 bundle 与全部插件资源；五类产物全匹配才允许跳过 | 126 |
| `packages/desktop/src/main/chromeCookieManager.ts` | Chrome Cookie 库的读取与导入 | INV-01~16；数据库路径只在两个候选中选；读取一律走临时快照；在线备份失败才回退文件拷贝且限 3 次 | 125 |
| `apps/zcode-cli/packages/core/src/permission/service.ts` | CLI 权限决策服务 | INV-01~14；硬禁用先于交互；`planEnabled` 先于 guarded 直通；`alwaysAsk` 位于两处模式直通之前 | 126 |
| `packages/desktop/src/main/browserView/electronBrowserWebmRecorder.ts` | Electron 页面录制器 | INV-01~12；单会话单 MediaRecorder 所有权；三个 deferred 各自只结算一次；`cleanup` 是唯一资源出口且幂等 | 124 |
| `packages/zcode-server-cli/src/supervisor/supervisor.ts` | zcode-server 的 Core 进程 supervisor | INV-01~14；同 data-root 单锁；持锁期间必须已确认无存活 Core；状态只能沿固定迁移路径走 | 126 |
| `packages/shared/src/zcode-protocol-v4/transport.ts` | 协议 v4 传输层的握手、帧与能力判定 | INV-01~14；`deliveryProfile` 与 `clientMode` 成对；capabilities 为 strict 且按 Host 声明放行；能力位判真一律 `=== true` | 130 |
| `packages/ui/src/settings/InstalledPluginManagement.tsx` | 已安装插件的管理详情面板 | INV-01~12；`plugin` 为 null 只渲染空态；加载中不得显示空态；组件分组只由派生函数产出 | 120 |
| `packages/ui/src/store/tabStore.ts` | 主区标签的打开、激活与关闭 | INV-01~12；`activeTabId` 非 null 必存在于 tabs；settings 至多一个且 id 固定；同 identity 至多一个 workspace tab | 123 |
| `packages/ui/src/components/ai-elements/prompt-input.tsx` | AI 输入框与附件提交原语 | INV-01~14；提交只由 form submit 触发、输入法组合态不提交；受控/非受控同一形状；有 provider 时附件唯一来源是 provider | 122 |
| `packages/ui/src/v4/sessionsIndexStore.ts` | v4 会话索引的增量合并与全量刷新 | INV-01~12；snapshot 必须重建 Map；delta 仅在 `fromSeq === seq` 时合并；陈旧帧按序号丢弃 | 123 |

合计 **1,504**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 派生视图不得回写源数据

`FeatureBoundaryGraphView.tsx` 的 `flowNodes/flowEdges` 只由 graph + layout + 三态派生，
坐标只读 `layout.nodes`。视图内一旦重算布局或把筛选结果写回 graph，重置后就回不到初始图，
边端点也会与节点坐标分叉。

### 2. 索引合并必须校验「上一帧序号」

`sessionsIndexStore.ts` 的 delta 只在 `frame.fromSeq === state.seq` 时合并，`toSeq <= seq` 的帧直接丢弃。
少这一步，跳帧会被静默接受、回放帧会把水位倒退，后续真增量被永久判为陈旧，投影缺一段且不再自愈。

### 3. 进程与录制资源只有一个出口

`electronBrowserWebmRecorder.ts` 的 `cleanup` 是唯一资源出口，并用 `closed` 标志做幂等；
`supervisor.ts` 的锁必须在确认 Core 终态后才释放。两个文件的共同点是：
正常结束、abort、页面销毁、启动失败都是出口，释放只能集中在单一幂等函数里，
否则 stop 与 abort 竞态下会出现重复关闭端口或孤儿进程继续写库。

### 4. 平台读取要先做「快照」再做解析

`chromeCookieManager.ts` 的所有读取都在临时快照上，绝不直接 `SELECT` 源库；
在线备份失败才回退文件拷贝，且最多 3 次。Chrome 运行时直接读源库会拿到撕裂数据，
表现为导入随机缺行而不报错——这类「静默少数据」比抛错更难排查。

### 5. 能力与配置的缺省必须是「安全侧」

`transport.ts` 的能力位判真一律 `=== true`，缺省等价 false；`deliveryProfile` 与 `clientMode`
必须成对，否则弱一致客户端会拿到可重放水位并在重连时续传出空洞。
`permission/service.ts` 同理：硬禁用先于交互、`alwaysAsk` 先于模式直通，
任何一处顺序写反都会让「本应确认」的操作静默执行。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 视图把筛选结果写回 graph | 重置后回不到初始图，边端点错位 |
| 视图内重算布局 | 出现第二套坐标，节点与边漂移 |
| fixture 未钉 userData | Chromium 缓存写进仓库，重启读出旧 Service Worker |
| 部署跳过判定不全 | 远端缺插件资源，Agent 启动即失败 |
| 直接读 Chrome 源库 | 运行时读到撕裂数据，导入随机缺行 |
| 备份失败无限重试 | 导入静默返回 0 行 |
| 权限判定顺序写反 | 硬禁用工具弹窗即可运行，或审批一次绕过 plan |
| 录制 start 重复发送 | 派生第二条 captureStream，WebM 无法解码 |
| deferred 重复结算 | 状态机停在错误阶段 |
| cleanup 不幂等 | 重复关闭端口/窗口，或删掉另一路径正在写的文件 |
| 锁在 Core 未终态时释放 | 孤儿 Core 继续写库，日志互相覆盖 |
| 能力位用真值判断 | 旧端走增量路径，收到整键 patch 时状态机不认 |
| 加载中显示空态 | 用户看到假空态并重复安装 |
| `activeTabId` 指向不存在标签 | 主区白屏且永不复位 |
| 输入法组合态触发提交 | 中日文选词时发送半截文本 |
| 附件有两份真相 | UI 与提交载荷不一致 |
| 索引 delta 不校验 fromSeq | 跳帧被接受，投影永久缺一段 |

## 顺延

B34 复算清单为 17 文件，本批取 12 个（含前两批全部 8 个顺延），其余 5 个顺延到 B35：
`packages/ui/src/v4/telemetry/conversationTelemetryParityE2E.ts`（缺口 115）、
`packages/client/src/webRemoteControlAcknowledgedRelayProtocol.ts`（缺口 114）、
`packages/desktop/scripts/mcp-apps-host-fixture/chain-main.ts`（缺口 114）、
`packages/ui/src/git-branch-switcher/GitBranchDialogs.tsx`（缺口 114）、
`packages/ui/src/project-sidebar/ProjectNodeContent.tsx`（缺口 114）。

> 说明：按防超限规则执行，每文件单独 spec（≤150 行），5 文件一组并行，逐文件密度校验。
> `supervisor.ts` 有 1 行注释以英文关键字 `switch` 开头被自查规则判为疑似代码行，
> 已改写为纯中文表述；`deletedNonZero` 仍为 0。
