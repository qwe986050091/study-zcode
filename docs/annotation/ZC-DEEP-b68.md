# ZC-DEEP-b68

> 批次：B68（12 文件，按 31.4% 口径计算目标 769 行，实际 +769，无补插）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b68\orig`；开工前 12 文件均为 `newComments=0`（30% 口径 needLines=769）。

## 校验

```
node zc-verify.mjs ZC-deep-b68
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=769

node check-batch.mjs ZC-deep-b68 ZC-deep-b68-files.txt
TOTAL added=769 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.19   299   218    68   64  packages/ui/src/ToolCallBlocks/ToolSummaryRow.tsx
31.25   411   288    90   64  apps/zcode-cli/packages/debug/src/shared.ts
31.25   355   256    80   64  packages/ui/src/components/ui/select.tsx
31.34   295   217    68   64  packages/ui/src/settings/usage-stats/CodingPlanUsageLineChart.tsx
31.34   289   201    63   63  packages/ui/src/lib/whiteboard.ts
31.34   270   201    63   63  packages/ui/src/v4/ConversationFileRewindDialog.tsx
31.36   353   236    74   64  packages/ui/src/lib/promptInputTriggers.ts
31.41   399   277    87   64  packages/ui/src/lib/toolDisplay.ts
31.43   276   210    66   64  packages/desktop/scripts/mcp-apps-host-fixture/managed-checks.ts
31.46   290   213    67   64  packages/ui/src/feedback/TicketDetail.tsx
31.50   674   473   149   67  apps/zcode-cli/packages/adapters/src/model/transform.ts
31.60   314   231    73   64  packages/ui/src/resource-manager/storage/StorageSection.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.19 median=31.35 newComments=769
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/settings/usage-stats/CodingPlanUsageLineChart.tsx` | 用量统计折线图渲染器 | INV-01~18；色板 6 槽与可见系列截取上限必须同源；取色按取模回落首位；折线颜色走容器注入变量而非色板直值；行键与 dataKey 同源；缺失采样点补 0；刻度稀疏按 14/45 分档且首尾保留；空态判定排在全部 hook 之后；纵轴上限取全系列最大值 | 64 |
| `ui/ToolCallBlocks/ToolSummaryRow.tsx` | 工具调用单行摘要 | INV-01~18；action 分支优先于 canToggle 与 forceOpen；action 行刻意不渲染展开箭头；testId 必须有兜底；键位白名单只认 Enter 与空格；命中才 return true；preventDefault 必须在键位判断之后 | 64 |
| `debug/src/shared.ts` | 调试台共享数据契约 | INV-01~18；全文件只允许类型声明、运行时完全擦除；ObservationSourceKind 为封闭四值；关联键缺省表示源头未提供而非空串；时间统一 ISO 且 endAt 缺省即进行中；lane 为封闭九值；cancelled 不得降级成 error | 64 |
| `desktop/scripts/mcp-apps-host-fixture/managed-checks.ts` | 夹具校验编排 | INV-01~18；只登记用例不自行断言；环境由调用方注入不自建 Host；宿主与访客两套求值通道严格分工；通知代数只增不复用；订阅去重由 SDK 真实链路承担；挂起审批必须跨锚点卸载存活 | 64 |
| `ui/components/ui/select.tsx` | Select 组件族 Radix 包装 | INV-01~18；`use client` 必须在文件首行；Radix 以 Select 别名整包导入；每个包装自带 data-slot；触发器只过渡颜色；variant/size 默认值两处同值；cva 只产出 class 串不携带状态 | 64 |
| `ui/feedback/TicketDetail.tsx` | 反馈工单详情视图 | INV-01~18；复制成功态是瞬时 UI 状态不入共享 store；切换工单先让复制态失效；复位计时器同时只允许一个存活；缺剪贴板能力只告警返回；写入被拒不得置成功态；计时器走 globalThis | 64 |
| `ui/lib/promptInputTriggers.ts` | 输入触发解析 | INV-01~18；触发符固定 / @ $ #，¥/￥ 只是别名；普通触发必须落在行首或空白后；@ 额外接受汉字紧邻；汉字 + 域名形态必须拒绝；先放宽正则再退回通用正则；query 是最长无空白片段 | 64 |
| `ui/lib/toolDisplay.ts` | 工具调用展示投影 | INV-01~18；只做投影不写回；计划结果只从 output 提取不回读 input；计划必须非空字符串才成立；计划文件路径相对 workspacePath 拼接；返回值固定 plan 有值；patch 优先只对 diff 策略开放 | 64 |
| `ui/lib/whiteboard.ts` | 白板纯工具函数 | INV-01~18；只提供纯函数不持有文档状态；identity 去空白后优先、缺失才取路径；文档 id 带 whiteboard: 前缀；笔迹 id 带 stroke: 前缀；空前缀回落 Whiteboard；序号从 1 单调递增并跳过占用名 | 63 |
| `ui/resource-manager/storage/StorageSection.tsx` | 存储 tab 总览与操作入口 | INV-01~18；只消费 useStorageUsage 投影；选择态三项留在组件内不复制快照；容量与时间只经 formatBytes/formatDateTime；清理只有 runClean 一条写路径；单一 busy 闸源自 cleaningCategory；桥不可用是唯一提前返回分支 | 64 |
| `ui/v4/ConversationFileRewindDialog.tsx` | 文件回退预览弹层 | INV-01~18；只读 preview 与回调不自行发请求；弹层完全受控；variant 决定标题/描述/页脚且默认 fileRewind；文件分类只有 safe/unsafe/ignored；未知 reason 回落 unsupportedCheckpoint；带 reason 显示原因、其余显示操作数 | 63 |
| `adapters/model/transform.ts` | 逻辑历史到 wire 消息投影 | INV-01~18；唯一投影入口且只读入参；输出顺序与输入一致且媒体后置紧跟结果；pendingToolMediaParts 单累积器、flush 后立即清空；tool 消息缺 id/name 在请求前抛 InvalidModelRequest；tool_reference 越界即抛错；含 video 的 tool 结果强制 textify | 67 |

合计 **769**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. action 分支必须排在 canToggle 之前

`ToolSummaryRow.tsx` 在函数体第一个 `if (action)` 提前返回。
下移后带动作的行同时成为折叠触发器，一次点击既执行动作又切换展开，产生两套状态写入。

### 2. 调试契约文件不得混入运行时值

`debug/src/shared.ts` 只允许类型声明，编译后完全擦除。
一旦混入函数或常量，web 端会把服务端模块打进 bundle，并在 Node 专属依赖上编译失败。

### 3. 通知代数只增不复用

`managed-checks.ts` 用自增的 `updates` 作为资源通知代数。
代数回退会让 `waitResources` 立即返回，读到上一轮遗留事件，用例假通过。

### 4. 复制成功态必须随工单切换失效

`TicketDetail.tsx` 在 `[ticket.id]` 的 effect 里清空 `copiedIssueId`。
缺这一步时复制 A 再切到 B，B 上会短暂显示 A 的「已复制」。

### 5. flush 后必须立刻清空累积器

`transform.ts` 的 `flushPendingToolMedia` 在 push 之后立即重置。
漏清会让同一批媒体重复挂到后续每一条 user 消息前面，provider 收到重复 part。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| action 分支下移 | 点击既执行动作又切换展开，状态双写 |
| 色板槽位少于可见系列 | 后几条线共用颜色，图例无法分辨 |
| 调试契约混入值 | web 端打包 Node 依赖，构建失败 |
| 通知代数复用 | 等待资源立即返回，读到上一轮事件 |
| 复制态不随工单失效 | 切到新工单仍显示已复制 |
| 触发器正则缺行首约束 | 路径 a/b 弹出命令面板 |
| 计划结果回读 input | 计划事件与结果块重复渲染 |
| 文档 id 缺前缀 | 持久化键与笔迹 id 冲突 |
| 清理出现第二条写路径 | 确认语义分叉，部分路径无确认 |
| 累积器 flush 后不清空 | 媒体重复挂载，provider 报重复 part |

## 顺延

B68 复算清单共 20 个候选，本批取 12 个，其余顺延到 B69，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.19%~31.60%，`suspicious=0`；
> 本批三波均一次插入通过，无补插。
