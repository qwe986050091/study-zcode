# ZC-DEEP-b42

> 批次：B42（12 文件；含 B41 全部 8 个顺延文件，再补 4 个）。
> 执行分三波：5 + 5 + 2（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b42\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b42
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1230

node check-batch.mjs ZC-deep-b42 ZC-deep-b42-files.txt
TOTAL added=1230 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.30   481   361  113  100  packages/ui/src/chat-input-toolbar/ComposerModelMenu.tsx
31.31   564   396  124  102  packages/desktop/src/main/openInEditor.ts
31.32   463   348  109  100  packages/ui/src/EmbeddedBrowserPaneParts.tsx
31.37   493   357  112  102  packages/ui/src/hooks/useUsageStats.ts
31.38   437   325  102  102  packages/ui/src/ModelTrajectoryExpandableMessage.tsx
31.40   527   379  119  103  packages/ui/src/highspeed/highspeedTurnStore.ts
31.40   432   328  103  102  packages/desktop/scripts/mcp-apps-host-fixture/sampling-main.ts
31.42  1106   818  257  109  packages/ui/src/settingsPageHelpers.tsx
31.45   598   442  139  103  packages/ui/src/v4/WorkbenchPane.tsx
31.48   492   359  113  102  packages/ui/src/chat-input-toolbar/ThoughtLevelCycleControl.tsx
31.53   439   333  105  103  packages/desktop/scripts/mcp-apps-host-fixture/showcase-main.ts
31.55   505   336  106  102  packages/ui/src/ToolCallBlocks/fileSummaryHeuristics.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.30 median=31.40 newComments=1230
PASS: all 12 file(s) >= 30% (mode=code)
```

开工前 12 文件基线均为 `newComments=0`（`needLines=1168`）；目标新增按
`round(code × 0.314) − 当前注释行` 逐文件精确分配，合计 1,230 行。
本批 `suspicious=0`，无需改写；两处锚点歧义（`ThoughtLevelCycleControl.tsx` 的 `return (`、
`EmbeddedBrowserPaneParts.tsx` 的 `BrowserToolbar` 缺 `{`）在子任务内用 `nth` / 补全锚点解决，未改动源码。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `desktop/scripts/mcp-apps-host-fixture/sampling-main.ts` | MCP Apps 采样夹具入口 | INV-01~20；参数与启动时序；特权 scheme 注册时机；check 超时与证据落盘；采样与会话隔离；模型冻结；准入幂等与凭据隔离；取消不重放；布局重排存活；撤销与资源回收 | 102 |
| `desktop/scripts/mcp-apps-host-fixture/showcase-main.ts` | MCP Apps 展示夹具入口 | INV-01~20；权限白名单边界；guest 生命周期与 destroyed 时序；MutationObserver 等待而非睡眠；存储重建与删除范围；采样与主会话隔离；取消/超时失败路径；环境关闭与退出码 | 103 |
| `desktop/src/main/openInEditor.ts` | 用外部编辑器打开路径 | INV-01~16；路由优先级与 id 契约；远端 URI（SSH authority / WSL distro / file-uri 与 folder-uri）；UNC 候选降级与 explorer 委托退出判定；stat 与 detached spawn 的资源释放；失败路径统一返回 | 102 |
| `ui/src/highspeed/highspeedTurnStore.ts` | 高速轮次指标 store | INV-01~18；records 单一数据源与整体替换；300 条上限淘汰；commandId 幂等登记；完成态指标不可覆盖；卡级 TPS 校验与回退；healthy 补查双槽位去重；落盘单向标记；自动分享两阶段认领；水合 changedRows；publishChange 事务与订阅解绑 | 103 |
| `ui/src/hooks/useUsageStats.ts` | 用量统计取数 hook | INV-01~20；请求代次竞态仲裁；requestScope / requestScopeKey 拼接与快照保留；Coding Plan 共享缓存（requestedAt / inFlight / 失败删除）；WeakMap 资源回收；错误文案与日志边界；effect 依赖与禁用态清空 | 102 |
| `ui/src/ModelTrajectoryExpandableMessage.tsx` | 模型轨迹可展开消息 | INV-01~16；展开态三层状态合并（命令版本闸门 / 覆盖优先 / 搜索展开并集）；复制与预览两套序列化及失败路径；工具方向与角色推断优先级；data 属性与常驻挂载契约 | 102 |
| `ui/src/settingsPageHelpers.tsx` | 设置页字段与控件帮助层 | INV-01~16；设置值单一来源与草稿态回填；trim 脏判定与保存钮/回车一致；No Proxy 归一化；shell 下拉 auto↔id 映射与兜底去重；代理三件套同卡约束；Linux 托盘与通知禁用；缺服务不渲染 | 109 |
| `ui/src/chat-input-toolbar/ThoughtLevelCycleControl.tsx` | 思考档位循环控件 | INV-01~15；全受控投影；进度条零值契约；单档固定态；Radix Select 空值与待提交事务竞速；rAF 去抖与订阅清理；下拉关闭焦点恢复顺序 | 102 |
| `ui/src/chat-input-toolbar/ComposerModelMenu.tsx` | Composer 模型选择菜单 | INV-01~20；选择派生唯一来源；browse 浏览态失效语义；滑杆 aria-disabled 与原生 disabled 的差异；气泡固定种子与末档条件；key 重建边界；Radix 事件冒泡与键盘提交时机；插槽与锁定过滤 | 100 |
| `ui/src/ToolCallBlocks/fileSummaryHeuristics.ts` | 文件类工具摘要推断 | INV-01~20；写文件语义门控；路径与内容候选的取用优先级；空串与成对 before/after 语义；actionLabel 与 changeStat/patch 映射；pending/completed 阶段优先级与 kind 收敛 | 102 |
| `ui/src/v4/WorkbenchPane.tsx` | v4 工作台面板 | INV-01~17；pane 的 scope 解析顺序；恢复守卫只结算一次；workspaceId 就绪前不判定；sessions-index 引用计数与订阅释放；group primary 删除顺序；draft 首发绑定；shell 状态的 workspace 隔离；搜索高亮按 taskId 精确匹配；hidden 不卸载；焦点 capture 不拦截 | 103 |
| `ui/src/EmbeddedBrowserPaneParts.tsx` | 内嵌浏览器面板部件 | INV-01~14；工具栏投影、遥测与事件边界；permissionControl 仅隐藏而不卸载；外部打开 URL 白名单；覆盖层隐藏错误页且不自动重试；排序菜单项与 aria 语义 | 100 |

合计 **1,230**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 内嵌浏览器权限控件只能隐藏、不能卸载

`EmbeddedBrowserPaneParts.tsx` 的 `permissionControl` 一旦卸载，浏览器侧对权限请求的应答通道就会断开，
表现为页面一直挂在「等待授权」状态而无任何报错。因此隐藏（样式或可见性）是唯一安全做法。

### 2. 高速轮次指标写成后不可覆盖

`highspeedTurnStore.ts` 对已完成轮次的指标采用「只写一次」语义。若允许后续事件覆盖，
补查或重放会把手改过的 TPS / 耗时改回默认值，用户看到的历史曲线会自己抖动。

### 3. 用量统计必须以代次仲裁

`useUsageStats.ts` 的并发请求按代次比较，只让最新一次落地。丢掉代次比较后，
慢的旧请求会覆盖新请求结果，表现为切换工作区后统计数字弹回上一个工作区的值。

### 4. 工作台面板恢复守卫只结算一次

`WorkbenchPane.tsx` 的恢复流程带一次性守卫。去掉后 React 严格模式下的双次 effect 会重复消费恢复意图，
导致同一 pane 被打开两次或 draft 绑定错位。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 权限控件卸载而非隐藏 | 页面卡在等待授权，无报错 |
| 完成态指标被后续事件覆盖 | 历史曲线自己抖动、数值回退 |
| 用量请求不按代次仲裁 | 切换工作区后数字弹回旧值 |
| 恢复守卫去掉 | 同一 pane 打开两次、draft 绑定错位 |
| 编辑器路由不区分远端 URI 形态 | 远端路径被当本地路径打开，或静默无反应 |
| 高速轮次去掉上限淘汰 | store 无界增长，长时间会话内存持续上升 |
| 设置草稿不回填 | 首次进入设置页保存即把未编辑字段重置为默认 |
| 模型菜单滑杆依赖原生 disabled | 无障碍下 aria 禁用与交互禁用不一致 |
| 文件摘要忽略成对 before/after | 改写类工具被显示为新增 |
| 内嵌浏览器覆盖层自动重试 | 错误页反复请求，放大失败 |

## 顺延

B42 复算清单为 20 文件，本批取 12 个（含 B41 全部 8 个顺延），其余 8 个顺延到 B43（缺口各 95~96 行）：
`packages/ui/src/hooks/useGitBranchSwitcher.ts`（96）、
`packages/ui/src/lib/remoteConnectionWizard.ts`（96）、
`packages/ui/src/presentation/presentationPdfPrintExport.ts`（96）、
`packages/ui/src/settings/RemoteSyncActions.tsx`（96）、
`packages/ui/src/settings/usage-stats/UsageHeatmap.tsx`（96）、
`packages/desktop/src/main/browserView/browserPlaywrightExecutor.ts`（95）、
`packages/ui/src/components/ai-elements/context.tsx`（95）、
`packages/ui/src/lib/remoteConnectionPresentation.ts`（95）。

> 说明：每文件独立 spec（≤150 行），5 文件一组并行（并发上限 5），逐文件密度校验。
> 本批无 `suspicious`；2 处锚点歧义在子任务内解决，未改动源码。
