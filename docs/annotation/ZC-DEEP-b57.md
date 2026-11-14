# ZC-DEEP-b57

> 批次：B57（12 文件，复算缺口 872 行；按当前工作树复算，优先同类/同目录：`ui/src` 8 个（`feedback`、`lib`、`settings/model-provider-section`、`settings/saved-workflows`、`v4`、`app-shell` 等）、`bootstrap/app` 1 个、`core/tool/handlers` 1 个、`desktop/src/main` 1 个、`e2e-report/viewer` 1 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b57\orig`；开工前 12 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b57
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=927

node check-batch.mjs ZC-deep-b57 ZC-deep-b57-files.txt
TOTAL added=927 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.23   348   253    79   76  packages/ui/src/settings/model-provider-section/ProviderFamilyModeHeader.tsx
31.25   381   288    90   75  apps/zcode-cli/packages/bootstrap/src/app/workflow-methods.ts
31.28   335   243    76   76  packages/ui/src/ModelTrajectoryPaneDetails.tsx
31.30   349   246    77   76  packages/ui/src/lib/conversationSelectionReference.ts
31.34   673   469   147   78  packages/desktop/src/main/desktopRuntimeEnv.ts
31.36   468   338   106   77  packages/ui/src/settings/saved-workflows/SavedWorkflowsSection.tsx
31.37  1562  1138   357   88  packages/ui/src/v4/conversationProjectionStore.ts
31.39   421   309    97   76  apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-flags-process.ts
31.40   335   242    76   76  packages/e2e-report/src/viewer/ChartPanels.tsx
31.40   329   242    76   76  packages/ui/src/feedback/TicketsView.tsx
31.43   389   280    88   77  packages/ui/src/WindowsCaptionMenuButton.tsx
31.48   444   324   102   76  packages/ui/src/app-shell/WorkflowWorkspaceSidePane.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.23 median=31.37 newComments=927
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `e2e-report/viewer/ChartPanels.tsx` | 报告趋势图面板 | INV-01~20；错误态短路与空数据占位三分支；容器+进程序列合并与前缀；dataset 构造与 Total 主线加权；单点/多点时序半径；颜色 CSS 变量解析与 hex/alpha 降级链；tooltip 数值归一与刻度同源；memo 化纯派生 | 76 |
| `ui/feedback/TicketsView.tsx` | 反馈工单列表视图 | INV-01~18；拉取快照语义；limit=50 无分页/无筛选；空态三条件门禁；整页骨架与页脚内联刷新互斥；选中态外部持有；复制单号能力探测与 1600ms 定时器；刷新/复制竞态；错误重试 | 76 |
| `ui/lib/conversationSelectionReference.ts` | 会话选区引用 | INV-01~18；scope 键归一（草稿/匿名区分与 NUL 分隔）；空数组即删除的归一表示；去重键字段顺序与 markdown 分支；追加判定次序且失败不改入参；userselect 优先与历史块解析；非法条目整块回退；事件先写快照后派发 | 76 |
| `ui/ModelTrajectoryPaneDetails.tsx` | 模型轨迹明细面板 | INV-01~18；ContentPartView 分发链；ToolPayload 与 ToolIdBadge；DetailSection/CodeBlock；UsageBadges 的 usage 缺失与空分片守卫；EmptyState；summarizeRecords 派生汇总；formatValue；长文本截断 | 76 |
| `ui/settings/model-provider-section/ProviderFamilyModeHeader.tsx` | 供应商家族模式头 | INV-01~19；模式切换与单选项短路；受控 Select 语义；失败/禁用态；标题与套餐标签派生；选项排序与过滤；可访问性与测试 id；团队名兜底 | 76 |
| `ui/settings/saved-workflows/SavedWorkflowsSection.tsx` | 已保存工作流列表 | INV-01~18；列表加载与 readiness 汇总；搜索为子组纯投影；分组顺序与身份键；删除确认只在成功后推进刷新序号；空态/无工作区/错误态；深链幂等与详情早返回；创建草稿不代发 | 77 |
| `ui/v4/conversationProjectionStore.ts` | 会话投影 store | INV-01~20；snapshot 整体替换与双 revision 失效；delta 衔接与断档重订阅；订阅代际与 ACK 退订；connectInFlight 与 available 竞态；runtime 退避；recovery 单飞/内容失败/看门狗；overlay 看门狗；行共享与内存上限；close 资源清退 | 88 |
| `ui/WindowsCaptionMenuButton.tsx` | Windows 标题栏菜单按钮 | INV-01~18；触发区 no-drag 与 type；拖动区域会吞掉无标记点击；DesktopCommandIds 派发与串行回拉；键盘可达性（aria-label/disabled/title）；平台条件渲染与取消标记；DPI 偏移权衡；订阅与卸载 | 77 |
| `bootstrap/app/workflow-methods.ts` | CLI 工作流方法门面 | INV-01~19；方法注册与依赖注入；参数校验与 kind 兜底；启动五步顺序与前后台分叉；错误映射不吞错、失败不落活动；abortSignal 透传与 stop 不写活动 | 75 |
| `core/tool/handlers/bash-readonly-policy-flags-process.ts` | Bash 只读策略 flag 白名单 | INV-01~19；只读命令判定；flag 取值消费；进程/持久化副作用；误判为只读的危险；拒绝路径优先保守；各命令白名单单一来源 | 76 |
| `desktop/main/desktopRuntimeEnv.ts` | 桌面运行时环境解析 | INV-01~18；环境变量 trim/判空/布尔白名单；开发与打包（含 preview）分支；优先级链（进程环境 > 本地 env > 编译期常量 > 平台默认）；非法值与缺失制品回退 | 78 |
| `ui/app-shell/WorkflowWorkspaceSidePane.tsx` | 工作流侧边面板 | INV-01~19；可见性与 focused 语义；按 tab.runId 选择 run；空态/不可用/错误四态互斥；宽度由 pane scope 与 flex 分配；与主视图 focusPhaseId 落点同步；租约生命周期；落点滚动幂等；首批错位封顶与截断提示 | 76 |

合计 **927**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 投影快照必须整体替换

`conversationProjectionStore.ts` 收到 snapshot 时整体替换并递增双 revision。
做字段合并会保留上一代已删除的行，用户看到已清理的消息残留在会话里。

### 2. delta 断档必须重订阅

`conversationProjectionStore.ts` 在 delta 序号不连续时放弃增量、重新订阅。
硬接断档会让缺口之后的所有事件错位，消息顺序与实际发生顺序不一致。

### 3. 只读判定必须保守

`bash-readonly-policy-flags-process.ts` 对未列白名单的 flag 一律判非只读。
放宽为「未知 flag 视为安全」会让带副作用的命令绕过审批，直接改写工作区。

### 4. 工单列表是快照而非分页

`TicketsView.tsx` 固定 limit=50 并整份替换。
改成增量追加会在刷新时重复渲染旧页，用户看到重复工单。

### 5. 侧边面板落点滚动必须幂等

`WorkflowWorkspaceSidePane.tsx` 用租约标记保证同一落点只滚动一次。
不幂等时每次重渲染都强制滚动，用户手动翻看历史会被拉回底部。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 投影 snapshot 做字段合并 | 已删除消息残留 |
| delta 断档硬接 | 消息顺序错乱 |
| 未知 bash flag 视为只读 | 有副作用命令绕过审批 |
| 工单列表增量追加 | 刷新后重复工单 |
| 侧边面板滚动不幂等 | 查看历史被拉回底部 |
| 图表 dataset 同快照产出不稳定 | 每次渲染图表抖动 |
| 选区引用不归一 | 同一选区被当成两处 |
| 保存工作流删除后不推进刷新序号 | 列表仍显示已删除项 |
| 标题栏按钮缺 no-drag | 点击被拖动区吞掉 |
| 运行时 env 优先级倒置 | 本地配置覆盖进程环境，调试失效 |
| 工作流方法失败仍写活动 | 界面显示已启动但实际未运行 |

## 顺延

B57 复算清单共 20 个候选，本批取 12 个，其余顺延到 B58，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 `suspicious=0`；全部文件按 `round(code × 0.314) − 当前注释行` 精确补行，密度落在 31.23%~31.48%。
