# ZC-DEEP-b33

> 批次：B33（12 文件，全部位于 `packages/ui`，按「同目录优先」拆为 B33-A / B33-B 两个子批各自校验）。
> B33-A：`settings/model-provider-section` 3 文件 + `settings` 2 文件 + `v4` 1 文件（+748 行）；
> B33-B：`components/ui`、`ModelTrajectoryPaneParts`、`GitBranchSwitcher`、`plugin-ui`、`mentions`、`CodingPlanUsageRemainingPanel`（+737 行）。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b33\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b33
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1485

node check-batch.mjs ZC-deep-b33 ZC-deep-b33a-files.txt
TOTAL added=748 hardBad=0 suspicious=0

node check-batch.mjs ZC-deep-b33 ZC-deep-b33b-files.txt
TOTAL added=737 hardBad=0 suspicious=0
```

逐文件密度（列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.30   534   393  123  122  packages/ui/src/settings/HookForm.tsx
31.31   559   412  129  125  packages/ui/src/CodingPlanUsageRemainingPanel.tsx
31.37   568   408  128  120  packages/ui/src/mentions/components/MentionPanel.tsx
31.39   534   395  124  121  packages/ui/src/settings/BrowserSettingsSection.tsx
31.42   629   452  142  124  packages/ui/src/components/ui/toast.tsx
31.42   880   646  203  128  packages/ui/src/settings/model-provider-section/providerFamilyConnectionVisibility.ts
31.46   588   445  140  123  packages/ui/src/plugin-ui/adapters/pluginUiManagedPage.ts
31.49   539   397  125  122  packages/ui/src/GitBranchSwitcher.tsx
31.49   545   397  125  123  packages/ui/src/ModelTrajectoryPaneParts.tsx
31.50   530   400  126  126  packages/ui/src/v4/officeSuggestedPrompts.ts
31.51   598   438  138  126  packages/ui/src/settings/model-provider-section/ProviderModelMetadata.ts
31.51   549   403  127  125  packages/ui/src/settings/model-provider-section/Navigation.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.30 median=31.44 newComments=1485
PASS: all 12 file(s) >= 30% (mode=code)
```

开工前 12 文件基线均为 `newComments=0`；`zc-verify` 的 `added=1485`
与两组子批 `check-batch` 合计（748 + 737）一致，也与逐文件目标合计一致。
`// INV-` 条数：12~16 条/文件。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `settings/model-provider-section/ProviderModelMetadata.ts` | 模型元数据表单的继承值、覆盖值与展示兜底 | INV-01~14；Draft 只承载 Personal Overlay、继承值仅作 placeholder；inputFormat 缺省仅文本；覆盖标记只记非 null 叶子 | 126 |
| `settings/model-provider-section/Navigation.tsx` | 模型供应商设置页的左侧导航与选中态 | INV-01~14；选中判据只比 `item.key`；节点 key 统一由 `create*NodeKey` 生成；路由与高亮同源 | 125 |
| `settings/model-provider-section/providerFamilyConnectionVisibility.ts` | 供应商家族的「已连接/已配置/可用」三态判定 | INV-01~12；无权益不得由旧凭据推出已连接；首份权益视图未到保持检查中；权益为假按不可用原因分流 | 128 |
| `settings/HookForm.tsx` | Hook 配置表单的编辑、校验与保存 | INV-01~14；空命令禁止提交；非法 JSON 只报错不覆盖原文；自定义配置只接受普通对象 | 122 |
| `settings/BrowserSettingsSection.tsx` | 浏览器设置分区与 browser-use 插件启停 | INV-01~16；开关只取插件 `enabled`；无工作区/加载中/插件缺失必须禁用；启停需回读确认 | 121 |
| `v4/officeSuggestedPrompts.ts` | 办公模式推荐语料与分类排序 | INV-01~15；id 连续且唯一；category 四值穷尽；四类数量固定；顺序即首屏顺序 | 126 |
| `components/ui/toast.tsx` | Toast 宿主、队列与自动消失 | INV-01~14；宿主至多一个；首帧未就绪不得丢消息；`items` 是唯一渲染源 | 124 |
| `ModelTrajectoryPaneParts.tsx` | 模型轨迹面板的消息行与展开卡片 | INV-01~13；同一 call 内输入/输出行号连续；`expansionKey` 全局唯一；缺字段降级不抛错 | 123 |
| `GitBranchSwitcher.tsx` | Git 分支切换入口与搜索 | INV-01~16；非仓库整棵树返回 null；`mutationPending` 期间全部禁用；搜索只过滤不改当前分支 | 122 |
| `plugin-ui/adapters/pluginUiManagedPage.ts` | 插件托管页的桥接、代际与生命周期 | INV-01~14；同页 controller 唯一；`appIdentity` 变化才清 widgetState；代际丢弃迟到结果 | 123 |
| `mentions/components/MentionPanel.tsx` | @ 提及候选面板的虚拟列表与键盘导航 | INV-01~14；`flatOptionIndex` 只在 option 行自增；同组状态行优先级 error > loading > empty；标题/状态行不占下标 | 120 |
| `CodingPlanUsageRemainingPanel.tsx` | 编码套餐剩余额度面板 | INV-01~14；快照有效性三条件；`team:` 前缀放行其余须命中可用供应商；选中项失效回退首个有效项 | 125 |

合计 **1,485**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 「继承值」与「显式覆盖」必须是两套存储

`ProviderModelMetadata.ts` 的 Draft 只承载 Personal Overlay，继承值仅用于 placeholder；
`overriddenFieldsValue` 只记录 `personalConfig` 中非 `null` 的叶子。把 placeholder 写回 Overlay，
用户没碰过的能力位就会被凭空固定，之后上游更新再也进不来。

### 2. 选中态与路由同源，本地不另存一份

`Navigation.tsx` 的选中判据只比 `item.key` 与 `selectedNodeKey` 全等，点击只上报、高亮只读。
本地先乐观高亮再等父层纠偏，会在 key 归一化（preset/套餐）时出现两次高亮或高亮丢失。

### 3. 「窗口期」不能当「未连接」

`providerFamilyConnectionVisibility.ts` 明确区分「不可检查但仍在加载」与「确定没连上」：
前者必须保持检查中，后者才按不可用原因分流。把窗口期当未连接，用户会被踢回登录页；
把权益为假直接当未连接，欠费与凭据失效会被混成同一种提示。

### 4. 宿主的「唯一性」与「首帧容错」同时成立

`toast.tsx` 的宿主至多一个，且首帧 `addToast` 为 null 时通过 `requestAnimationFrame` 重试而不是丢弃。
只保证唯一会丢首帧消息，只保证不丢会造出第二个 portal；两者必须同时满足。

### 5. 组件下标只对「可选项」自增

`MentionPanel.tsx` 的 `flatOptionIndex` 只在 option 行分配，分组标题与状态行不占用。
一旦状态行也吃下标，`selectedIndex` 会指向不存在的选项，回车插入错项且高亮整段消失。
同一组状态行还必须按 `error > loading > empty` 互斥，避免错误行与空态行同时上屏。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 继承值写回 Overlay | 用户没编辑的字段被固定，上游更新失效 |
| `inputFormat` 缺省不补 | 旧模型被判不支持文本，提交即 invalid |
| 用 providerId 比较选中 | preset 与套餐 key 错位，侧栏无高亮 |
| 本地乐观高亮 | 父层纠偏时闪烁错位 |
| 窗口期判成未连接 | 用户被踢回登录 |
| 权益为假一律当未连接 | 欠费/凭据失效被混成同一提示 |
| 空命令允许保存 | 运行时拉起空进程 |
| 非法 JSON 覆盖原文 | 用户正在编辑的长文本被清空 |
| 宿主重复创建 | 同一提示成对出现，层叠上下文互抢 |
| 首帧消息直接丢弃 | 首屏提示静默消失 |
| `expansionKey` 不唯一 | 多张卡片展开状态串台 |
| 缺 `response/usage` 直接取字段 | 轨迹面板整块白屏 |
| 切换中不禁用 | 并发 checkout，分支状态错乱 |
| 搜索改写当前分支 | 关键字被当成切换，标记漂移 |
| 状态行占用 option 下标 | 回车插入错项，高亮消失 |
| 状态行不互斥 | 错误行与空态行同时上屏 |
| widgetState 跨 appIdentity 复用 | 同插件热重载丢草稿，或跨插件串数据 |
| 代际不比较 | 已 suspend 的页面被迟到结果复活 |

## 顺延

B33 由 B32 顺延的 1 个 UI 文件 + B33 复算清单的前 11 个 UI 文件组成，共 12 个。
仍待处理（顺延到 B34）：
`apps/dev-docs/src/feature-boundary-graph/FeatureBoundaryGraphView.tsx`（缺口 123）、
`packages/desktop/scripts/gen-ui-fixture/main.ts`（缺口 123）、
`packages/server/src/remote/zcodeAgentDevDeploy.ts`（缺口 120）、
`packages/desktop/src/main/chromeCookieManager.ts`（缺口 119）、
`apps/zcode-cli/packages/core/src/permission/service.ts`（缺口 118）、
`packages/desktop/src/main/browserView/electronBrowserWebmRecorder.ts`（缺口 118）、
`packages/zcode-server-cli/src/supervisor/supervisor.ts`（缺口 118）、
`packages/shared/src/zcode-protocol-v4/transport.ts`（缺口 117）。

> 说明：按防超限规则执行，每文件单独 spec（≤150 行），5 文件一组并行，逐文件密度校验。
> `officeSuggestedPrompts.ts` 首轮少 1 行，从该文件基线快照还原后按修订 spec 重插；
> 还原只影响本批新增注释，既有代码零改动。
