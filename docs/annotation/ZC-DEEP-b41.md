# ZC-DEEP-b41

> 批次：B41（12 文件；含 B40 全部 7 个顺延文件，再补 5 个）。
> 执行分三波：5 + 5 + 2（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b41\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b41
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1248

node check-batch.mjs ZC-deep-b41 ZC-deep-b41-files.txt
TOTAL added=1248 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.27   455   339  106  103  packages/ui/src/settings/model-provider-section/ProviderFormControls.tsx
31.29   591   425  133  106  packages/ui/src/settings/model-provider-section/enterpriseCodingPlanProducts.ts
31.30   518   393  123  103  apps/zcode-cli/packages/core/src/runtime/methods/index.ts
31.31   623   444  139  104  packages/ui/src/onboarding/OnboardingDialog.tsx
31.38   565   376  118  105  packages/ui/src/lib/planModeTool.ts
31.44   621   439  138  105  packages/ui/src/lib/settingsNavigation.ts
31.44   471   334  105  103  packages/e2e-report/src/viewer/trendData.ts
31.46   562   391  123  104  packages/desktop/src/main/desktopCrashCapture.ts
31.47   528   375  118  104  packages/desktop/src/main/browserView/browserScreenshotSurfaceCoordinator.ts
31.47   541   394  124  103  packages/ui/src/settings/saved-workflows/SavedWorkflowProjectGroup.tsx
31.48   647   467  147  104  apps/zcode-cli/packages/core/src/mcp/index.ts
31.51   494   365  115  104  packages/ui/src/v4/ConversationShareSelectionPanel.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.27 median=31.44 newComments=1248
PASS: all 12 file(s) >= 30% (mode=code)
```

开工前 12 文件基线均为 `newComments=0`（`needLines=1188`）；目标新增按
`round(code × 0.314) − 当前注释行` 逐文件精确分配，合计 1,248 行。
首轮有 3 处 `suspicious`（中文句以 `catch` / `import` 开头），已就地改写为中文表述，行数不变，重跑后归零。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/src/settings/model-provider-section/ProviderFormControls.tsx` | 供应商表单控件 | INV-01~17；编辑事务的 revision 快照与并发基线；保存期间 ref 互斥；测试请求竞态与反馈去重；删除按钮 blur 点击丢失；错误文案优先级与本地化 | 103 |
| `ui/src/settings/model-provider-section/enterpriseCodingPlanProducts.ts` | 企业编码套餐商品目录 | INV-01~16；静态目录与 pricing 三态合并；已购 SKU 补位；展示价取最小值；优惠额反推；多席位与周期数放大；活动金额按比例分摊并末档吃残差；二维码内容取 payUrl 的回退顺序；三方支付判定；试算快照不可重算 | 106 |
| `apps/zcode-cli/packages/core/src/runtime/methods/index.ts` | 运行时方法装配表 | INV-01~14；装配表幂等；同源重名导入；proto 名即内部契约；直接赋函数保住 this；队列/lease 与 steering reservation 配对；事件三件套与 durable 写入成套；compact 四层与三路径 fork/rewind | 103 |
| `ui/src/onboarding/OnboardingDialog.tsx` | 新手引导弹窗 | INV-01~18；步骤顺序唯一来源与占位步骤；候选工作区去重与默认全选的一次性标记；自动扫描入口门控；进度分子分母口径与除零；AGENTS.md 覆盖与运行中关闭的二次确认；外部导入按需启用 | 104 |
| `ui/src/lib/planModeTool.ts` | 计划模式工具语义 | INV-01~14；递归提取的环检测与 seen 弱集；空标题/三态归一；候选择优单调性；结构化键与集合键一致；模式项识别与语义到原生映射；full-auto 到 yolo 的修复语义；JSON 失败降级；摘要取舍边界 | 105 |
| `ui/src/lib/settingsNavigation.ts` | 设置页导航状态 | INV-01~18；意图写入与消费顺序；旧 id 迁移；隐藏分区回退；存储异常降级；插件 tab 映射；usage tab 回退抖动；监听器清理 | 105 |
| `packages/e2e-report/src/viewer/trendData.ts` | 趋势视图数据装配 | INV-01~18；产物候选回退链；并发拉取与降级契约；时间轴基准与耗时夹负；NDJSON 行级容错；docker 单位换算（1000/1024）；type 归桶累加；配色索引偏移 | 103 |
| `desktop/src/main/desktopCrashCapture.ts` | 崩溃转储捕获 | INV-01~15；dump 只复制不动 live；mtime 还原与清理排序；容量下限至少留 1；孤立 dmp.json 收敛删除；reporter/监听幂等；gone 事件日志分级；timer unref | 104 |
| `desktop/src/main/browserView/browserScreenshotSurfaceCoordinator.ts` | 截图表面协调 | INV-01~18；guest key 去重与串行化；ready 身份逐字段校验与 sender 冻结；unscaled 缩放契约；request 登记先于发送；lease 单次释放与 settle 收敛；window 销毁/dispose 的调度暂停与资源归还 | 104 |
| `ui/src/settings/saved-workflows/SavedWorkflowProjectGroup.tsx` | 已存工作流项目分组 | INV-01~14；三套 target 坐标不得混用；rpcReady 与 refreshSeq 的拉取时机；目录监听与坏文件 empty 判定；运行/修订/删除/提升各自的事务与失败路径；详情态与实参窗共享状态 | 103 |
| `apps/zcode-cli/packages/core/src/mcp/index.ts` | MCP 服务索引 | INV-01~18；CUA 规范名与 authority 门；双名 allow-deny 兼容；providerVisible 与 app-only；node_repl 风险升级；结果预算与帧保护；结果回灌与错误展示；title 注入与剥离；进度事件与 workspaceKey | 104 |
| `ui/src/v4/ConversationShareSelectionPanel.tsx` | 会话分享选择面板 | INV-01~16；受控选择唯一事实源；运行中轮次排除；全选三态与取反；preflight/rows_limit 禁用确认；窄屏下移与 scrollHeight 量测；滑块进度映射；监听与 rAF 清理 | 104 |

合计 **1,248**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 已存工作流的三套 target 坐标不能混用

`SavedWorkflowProjectGroup.tsx` 同时存在项目、目录、文件三种 target 形态。把其中一种的字段
拼进另一种请求，服务端仍会返回成功，但实际改的是另一个路径下的文件——用户看到「保存成功」，
重新打开却是旧内容。

### 2. 崩溃转储只复制不动 live 文件

`desktopCrashCapture.ts` 对现场 dump 做复制后处理，原地改写会让仍持有该文件的崩溃处理链路读到被截断的内容。
清理时容量下限至少保留 1 个，是因为全部删光后下一次崩溃就没有可对照的基线。

### 3. MCP 的 providerVisible 与 app-only 是两套可见性

`core/src/mcp/index.ts` 里前者决定模型是否看到工具，后者决定 App 侧能否调用。
合并成一个开关后，要么内部工具暴露给模型，要么 App 调用被误拒——两种都表现为「功能消失」而不是报错。

### 4. 计划模式的候选提取必须带环检测

`planModeTool.ts` 递归遍历结构时用 seen 弱集截断环。去掉后遇到自引用对象会栈溢出，
而这类对象在用户从外部粘贴配置时很常见，表现是打开计划模式即崩溃。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 工作流 target 坐标混用 | 提示保存成功，重开仍是旧内容 |
| 崩溃转储原地改写 | 崩溃处理链路读到截断文件 |
| 清理把转储删光 | 下次崩溃无基线可对照 |
| MCP 可见性两开关合并 | 工具对模型不可见，或 App 调用被误拒 |
| 计划模式递归无环检测 | 粘贴自引用配置后打开即栈溢出 |
| 设置意图写入晚于消费 | 首次进入设置页落在错误分区 |
| 设置存储异常不降级 | 本地存储损坏导致设置页白屏 |
| 全选用布尔而非三态 | 部分选中时再点全选变成全不选 |
| 测试请求不校验序号 | 连续点测试，旧结果覆盖新结果 |
| 截图 lease 重复释放 | 后续截图请求拿不到资源，画面卡住 |
| 分享选择把运行中轮次算入 | 分享内容缺最后一条回复 |
| 趋势单位混用 1000/1024 | 报表里内存与磁盘数字对不上 |

## 顺延

B41 复算清单为 20 文件，本批取 12 个（含 B40 全部 7 个顺延），其余 8 个顺延到 B42（缺口各 97~98 行）：
`packages/desktop/scripts/mcp-apps-host-fixture/sampling-main.ts`（98）、
`packages/desktop/scripts/mcp-apps-host-fixture/showcase-main.ts`（98）、
`packages/ui/src/highspeed/highspeedTurnStore.ts`（98）、
`packages/ui/src/hooks/useUsageStats.ts`（98）、
`packages/ui/src/ModelTrajectoryExpandableMessage.tsx`（98）、
`packages/ui/src/settingsPageHelpers.tsx`（98）、
`packages/desktop/src/main/openInEditor.ts`（97）、
`packages/ui/src/chat-input-toolbar/ThoughtLevelCycleControl.tsx`（97）。

> 说明：每文件独立 spec（≤150 行），5 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 3 处 `suspicious` 已就地改写修正；`trendData.ts` 有 1 处锚点歧义，用全文锚点解决，未改动源码。
