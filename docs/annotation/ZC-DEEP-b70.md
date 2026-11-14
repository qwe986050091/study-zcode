# ZC-DEEP-b70

> 批次：B70（12 文件，按 31.4% 口径计算目标 753 行，实际 +753，无补插）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b70\orig`；开工前 12 文件均为 `newComments=0`（30% 口径 needLines=720）。

## 校验

```
node zc-verify.mjs ZC-deep-b70
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=753

node check-batch.mjs ZC-deep-b70 ZC-deep-b70-files.txt
TOTAL added=753 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.16   268   199    62   62  packages/ui/src/settings/MemorySettingsViewer.tsx
31.25   277   208    65   62  packages/ui/src/project-sidebar/grouped/sticky-group-header.tsx
31.31   261   198    62   62  packages/desktop/scripts/mcp-apps-host-fixture/widget.tsx
31.31   261   198    62   62  packages/shared/src/zcode-slash-command-help.ts
31.31   284   198    62   62  packages/ui/src/components/ai-elements/chain-of-thought.tsx
31.32   516   380   119   65  apps/zcode-cli/packages/cli/src/plugins-command.ts
31.32   363   265    83   63  packages/ui/src/v4/paneLayoutPersistence.ts
31.36   332   236    74   63  packages/ui/src/lib/planUsageArmsTelemetry.ts
31.38   327   239    75   63  packages/ui/src/hooks/useModelSelectionView.ts
31.46   287   213    67   63  packages/ui/src/feedback/FeedbackSubmitSections.tsx
31.50   277   200    63   63  packages/model-option-map/src/evaluator.ts
31.58   283   209    66   63  packages/ui/src/store/subagentsContextStore.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.16 median=31.32 newComments=753
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `desktop/scripts/mcp-apps-host-fixture/widget.tsx` | MCP Apps 宿主夹具页面 | INV-01~18；能力全部挂到 window 供测试驱动；回调只观察不改变宿主状态；页工具与工具结果流分离；资源订阅与存储能力各自独立入口；卸载时清空挂载点 | 62 |
| `model-option-map/src/evaluator.ts` | 受限 CEL 求值器 | INV-01~18；只接受 parser 已校验的语法树；结果必须不可变；数字必须可序列化；越界与类型错误统一走诊断；不引入动态执行 | 63 |
| `shared/src/zcode-slash-command-help.ts` | 斜杠命令帮助元数据 | INV-01~18；五项字段即对外契约；aliases 与 name 不得重复；usage 只描述形态不描述实现；帮助表是唯一事实源 | 62 |
| `ui/components/ai-elements/chain-of-thought.tsx` | CoT 展示组件族 | INV-01~18；纯展示不持有思考数据；开合状态由调用方受控；步骤顺序即数组顺序；来源与图片块缺失时不占位 | 62 |
| `ui/settings/MemorySettingsViewer.tsx` | Project Memory 只读列表 | INV-01~18；只读投影不起草写回；作用域切换与搜索独立；空目录给空态而非空白；唤起编辑器只走平台能力 | 62 |
| `ui/store/subagentsContextStore.ts` | 子代理列表快照仓库 | INV-01~18；按 workspace 与 provider 组合分 key；加载去重与竞态裁决在 store 内；只保留最新请求结果；启用开关走服务调用 | 63 |
| `ui/project-sidebar/grouped/sticky-group-header.tsx` | 分组吸顶头 | INV-01~18；四个入口聚合但不合并语义；折叠/改色/新建/解散各自独立回调；展示投影不写分组状态 | 62 |
| `ui/feedback/FeedbackSubmitSections.tsx` | 反馈提交展示区 | INV-01~18；描述/联系方式/日志开关均为受控；可访问性属性必须完整；底部操作区只转发不判定 | 63 |
| `ui/lib/planUsageArmsTelemetry.ts` | ARMS 用量埋点 | INV-01~18；只上报生命周期与首字延迟；provider 与模型名不得原样出网；事件名固定；重复上报需按请求 id 去重 | 63 |
| `ui/hooks/useModelSelectionView.ts` | 模型选择视图 hook | INV-01~18；对外只暴露 state/reload/refresh；事件订阅与显式刷新合流；卸载必须退订；空视图不伪造默认值 | 63 |
| `ui/v4/paneLayoutPersistence.ts` | 分屏布局持久化 | INV-01~18；读取时对不可信输入整体校验；版本不符即整体丢弃；写入只落规范化结构；内存快照与 localStorage 同源 | 63 |
| `cli/src/plugins-command.ts` | plugins 子命令入口 | INV-01~18；只做参数校验与确认交互；真实副作用全部委托 bootstrap；非交互模式不得阻塞等待；结果格式化统一 | 65 |

合计 **753**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 求值结果必须不可变

`evaluator.ts` 在构造结果时冻结或新建容器，不复用语法树内节点。
复用会让上游一次求值污染后续求值，同一表达式在不同输入下得到相同输出。

### 2. 埋点不得出网 provider 与模型名

`planUsageArmsTelemetry.ts` 只上报枚举化后的生命周期与耗时。
原样上报会同时带来隐私泄露与高基数问题，报表维度被打散。

### 3. 布局读取必须整体校验

`paneLayoutPersistence.ts` 对 localStorage 内容做整体 schema 校验，失败即丢弃。
逐字段容错会让半损坏布局进入渲染，出现空 pane 或重复面板。

### 4. 请求竞态只保留最新结果

`subagentsContextStore.ts` 用请求序号裁决回包。
不裁决会让慢回包覆盖新快照，切 workspace 后看到上一个工作区的子代理。

### 5. CLI 非交互模式不得阻塞

`plugins-command.ts` 在非 TTY 下跳过确认交互。
阻塞等待会让 CI 与脚本调用永久挂起。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 求值复用语法树节点 | 一次求值污染后续结果 |
| 埋点上报原始模型名 | 隐私泄露且维度爆炸 |
| 布局逐字段容错 | 半损坏布局进入渲染，空 pane |
| 子代理回包不裁决 | 旧快照覆盖新工作区 |
| CLI 非交互仍等待确认 | CI 永久挂起 |
| CoT 组件自持开合 | 受控调用方关不掉 |
| 帮助表 aliases 重复 | 命令解析命中不确定 |
| 反馈区自行判定可提交 | 与服务端校验分叉 |
| 模型视图卸载不退订 | 卸载后仍写状态 |
| 分组头合并回调语义 | 一次点击触发多个操作 |

## 顺延

B70 复算清单共 20 个候选，本批取 12 个，其余顺延到 B71，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.16%~31.58%，`suspicious=0`；
> 本批三波均一次插入通过，无补插。
