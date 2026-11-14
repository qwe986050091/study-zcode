# ZC-DEEP-b74

> 批次：B74（12 文件，按 31.4% 口径计算目标 729 行，实际 +729，无补插）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b74\orig`；开工前 12 文件均为 `newComments=0`（30% 口径 needLines=691）。

## 校验

```
node zc-verify.mjs ZC-deep-b74
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=729

node check-batch.mjs ZC-deep-b74 ZC-deep-b74-files.txt
TOTAL added=729 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.19   281   202    63   59  packages/ui/src/store/conversationShareSelectionStore.ts
31.28   294   211    66   60  packages/ui/src/settings/model-provider-section/StartPlanCard.tsx
31.28   257   195    61   59  packages/desktop/scripts/mcp-apps-host-fixture/agent.ts
31.29   464   342   107   61  apps/zcode-cli/packages/bootstrap/src/app/workflow-facade.ts
31.31   269   198    62   59  packages/shared/src/zcode-protocol-v4/workspace-hook-review.ts
31.36   498   354   111   62  packages/ui/src/settings/pluginStoreListing.ts
31.43   340   245    77   61  packages/zcode-server-cli/src/packaging/stageCli.ts
31.46   613   445   140   64  packages/ui/src/store/zcodeSessionStoreTypes.ts
31.54   366   260    82   62  packages/ui/src/ToolCallBlocks/renderers/list-saved-workflows-presentation.tsx
31.55   294   206    65   60  packages/ui/src/settings/model-provider-section/codingPlanProductPresentation.ts
31.61   257   193    61   61  packages/ui/src/settings/PluginConfigControls.tsx
31.63   280   196    62   61  packages/ui/src/v4/conversationFindHighlightDom.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.19 median=31.39 newComments=729
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/settings/model-provider-section/StartPlanCard.tsx` | 体验套餐额度卡片 | INV-01~18；只认 entitlementSummary 准入；额度过滤三条件；空摘要返回 null 不回落本地文案 | 60 |
| `ui/settings/PluginConfigControls.tsx` | 插件配置控件组 | INV-01~18；空 entries 在 Hook 后早返回；配置只读 userConfig；读值统一走 getValue；保存中统一禁用 | 61 |
| `ui/settings/pluginStoreListing.ts` | 插件商店纯函数层 | INV-01~18；StorePluginItem 是唯一视图模型；忙碌键与操作 id 逐字对齐；更新判定同时看 orphaned | 62 |
| `ui/settings/model-provider-section/codingPlanProductPresentation.ts` | CodingPlan 展示模型 | INV-01~18；unknown 全量防御；只收 string 或带 text 对象；去空白后再判空 | 60 |
| `ui/store/zcodeSessionStoreTypes.ts` | 会话 store 类型契约 | INV-01~18；只声明类型与默认值工厂；workspaces 以 workspacePath 为键；workspaceInit 单事实源 | 64 |
| `ui/store/conversationShareSelectionStore.ts` | 分享选择草稿 store | INV-01~18；按 taskId 分区成对读写；缺失任务回落冻结常量；excludedRowIds 用补集表示 | 59 |
| `ui/ToolCallBlocks/renderers/list-saved-workflows-presentation.tsx` | 工作流清单卡 | INV-01~18；不可解析返回 null 而非空结果；display 优先于 legacy；legacy 探测顺序固定 | 62 |
| `ui/v4/conversationFindHighlightDom.ts` | find 高亮 DOM 层 | INV-01~18；三层高亮名为 CSS 契约；style id 全局唯一；样式内容与常量严格一致 | 61 |
| `zcode-server-cli/src/packaging/stageCli.ts` | CLI 发行目录装配 | INV-01~18；平台走白名单；Node 版本单一常量；二进制查找顺序固定 | 61 |
| `apps/zcode-cli/.../app/workflow-facade.ts` | workflow 执行门面 | INV-01~18；缓存键三元组；child 继承父会话依赖；查写在同步段完成；guarded 不得静默降级 | 61 |
| `desktop/scripts/mcp-apps-host-fixture/agent.ts` | MCP Apps 宿主夹具 | INV-01~18；事件一次性交付；emit 先历史后等待者；after 是历史下标 | 59 |
| `shared/src/zcode-protocol-v4/workspace-hook-review.ts` | workspace hook 审核协议 | INV-01~18；只做形状校验不引 IO；对象一律 strict；nonEmptyString 先 trim 再判长 | 59 |

合计 **729**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. open 的空态必须返回 null 而不是空列表

`list-saved-workflows-presentation.tsx` 在两条解析失败路径上都返回 `null`。
改成返回空数组会被渲染成「这个项目里没有工作流」，用户会误以为配置丢失。

### 2. 忙碌键必须与操作 id 逐字对齐

`pluginStoreListing.ts` 的 `isItemBusy` 用固定拼接键匹配安装、恢复、卸载等操作。
前缀或分隔符写错一个字，按钮可点但操作被静默吞掉，用户只看到点击无反应。

### 3. 缓存键是 (definitionId, definitionVersion, kind)

`workflow-facade.ts` 的 `workflowRuntimeForDefinition` 用三元组拼 cacheKey。
漏掉版本后定义换代仍命中旧 runtime，用户改完脚本却还在执行上一版。

### 4. 事件是一次性交付

`agent.ts` 的 `Events` 命中后立即从等待集合移除，`emit` 先写历史再遍历等待者。
让新等待者收到本次事件会把「下一轮」的预期提前满足，用例从此不稳定。

### 5. 平台必须走白名单

`stageCli.ts` 的 staging 目标只接受 `supportedServerTargets` 内的值。
自由字符串会让 staging 目录与 node 二进制架构错配，产物在目标机上无法启动。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 空摘要回落本地文案 | 两套额度口径，诱导错误购买 |
| 直接解构 userConfig | 未配置插件整块白屏 |
| 忙碌键拼错 | 按钮可点但操作被吞 |
| 展示模型放行脏数据 | 对象字符串直接显示给用户 |
| 类型文件内新增 setter | 状态变更绕开单一入口 |
| 草稿跨任务复用 | 分享选择串到别的任务 |
| 解析失败返回空列表 | 用户误以为配置丢失 |
| 高亮名与 CSS 漂移 | 某一层高亮失去背景色 |
| 平台不做白名单 | 产物与目标架构错配 |
| 缓存键漏版本 | 改完脚本仍执行上一版 |
| 事件被多个等待者共享 | 用例读到别人的事件 |
| 协议对象非 strict | 旧客户端静默吞掉新字段 |

## 顺延

B74 复算清单共 20 个候选，本批取 12 个，其余顺延到 B75，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.19%~31.63%，`suspicious=0`；
> 本批 wave1 两个 spec 的 raw 首块漏了 `//` 前缀，插入器整文件拒写（无残留），补前缀后一次通过。
