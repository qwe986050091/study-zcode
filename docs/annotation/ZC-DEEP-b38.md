# ZC-DEEP-b38

> 批次：B38（12 文件，跨 4 个模块；本批优先消化 B37 全部 7 个顺延文件，再补 5 个）。
> B38-A：`ui` 4 + `desktop/main` 1 + `server/remote` 1（+653 行）；
> B38-B：`ui` 4 + `desktop/main` 1 + `ui/settings` 1（+659 行）。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b38\orig`。

## 校验

```
node zc-verify.mjs ZC-deep-b38
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1312

node check-batch.mjs ZC-deep-b38 ZC-deep-b38a-files.txt
TOTAL added=653 hardBad=0 suspicious=0

node check-batch.mjs ZC-deep-b38 ZC-deep-b38b-files.txt
TOTAL added=659 hardBad=0 suspicious=0
```

逐文件密度（列口径：`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.28   540   374  117  110  packages/server/src/remote/localTarGz.ts
31.30   536   393  123  110  packages/ui/src/settings/saved-workflows/SavedWorkflowDetailView.tsx
31.34   492   367  115  106  packages/ui/src/ToolCallBlocks/renderers/agent.tsx
31.34   658   469  147  112  packages/ui/src/chat-input-toolbar/display.tsx
31.35   624   437  137  111  packages/desktop/src/main/desktopOAuthDeepLink.ts
31.35   489   370  116  111  packages/ui/src/settings/model-provider-section/ProviderModelMetadataDialog.tsx
31.38   477   341  107  107  packages/ui/src/components/ai-elements/open-in-chat.tsx
31.40   515   379  119  110  packages/ui/src/ToolCallBlocks/renderers/node-repl.tsx
31.44   477   353  111  109  packages/ui/src/feedback/FeatureRequestDialog.tsx
31.46   605   445  140  110  packages/ui/src/prompt-editor/ChatPromptEditor.tsx
31.50   499   346  109  107  packages/ui/src/ToolCallBlocks/renderers/execute.tsx
31.51   514   365  115  109  packages/desktop/src/main/networkTelemetryAggregator.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.28 median=31.36 newComments=1312
PASS: all 12 file(s) >= 30% (mode=code)
```

开工前 12 文件基线均为 `newComments=0`（`needLines=1253`）；`zc-verify` 的 `added=1312`
与两组子批 `check-batch` 合计（653 + 659）一致，也与逐文件目标合计一致。

执行备注：`FeatureRequestDialog.tsx` 首轮有 1 处 `suspicious`（中文句以 `catch` 开头），
已就地改写为「捕获分支只负责…」，行数不变、仍为纯注释行，重跑 `check-batch` 后归零。
`localTarGz.ts` 首次派发因并发上限（5）未启动，文件保持基线未动，二次派发后从零写入 110 行。

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `server/src/remote/localTarGz.ts` | 本地 tar/gzip 解包与安全落盘 | INV-01~16；512 字节块对齐与截断即失效；GNU 长名与 pax 头跳过；ustar 校验和；zip-slip 与符号链接落点校验；0755/静默 chmod；readdir 排序确定性 | 110 |
| `ui/src/settings/saved-workflows/SavedWorkflowDetailView.tsx` | 已保存工作流详情与编辑 | INV-01~17；`target` 作用域透传与取消守卫；`loadState` 三态；draft/baseline 脏判定；参数行 key 唯一性与错误清理；saving 复位；取最新 completed run | 110 |
| `ui/src/ToolCallBlocks/renderers/agent.tsx` | Agent 工具块渲染 | INV-01~18；父子工具生命周期边界；后台进程三态与四态；`data-*` 测试锚点；i18n 文案；`useCallback`/`useMemo` 依赖完整性；JSX 排版约束 | 106 |
| `ui/src/chat-input-toolbar/display.tsx` | 聊天输入工具条展示层 | INV-01~15；高权限模式判定；hook 顺序与 early return；值域外回调丢弃；模型搜索口径；重试文案不倒计时；provider 分层文案；浮层定位与告警配色；testId 契约 | 112 |
| `desktop/src/main/desktopOAuthDeepLink.ts` | 桌面 OAuth / 分享 deep link 路由 | INV-01~16；安全闸门顺序（UNC 与 statSync 之前拒绝）；`state` 到窗口的路由与 5 分钟过期；未就绪窗口 pending 缓存与重放；share import 绑定窗口与去重上限；窗口销毁清理 | 111 |
| `ui/src/settings/model-provider-section/ProviderModelMetadataDialog.tsx` | 供应商模型元数据弹窗 | INV-01~18；受控草稿契约；add/edit 自动聚焦互斥；smart 与覆盖集合语义；输入法回车拦截与组合态 ref；提交返回值判定；禁用与只读边界；无障碍 id | 111 |
| `ui/src/components/ai-elements/open-in-chat.tsx` | 第三方 AI 聊天入口 | INV-01~18；providers 表契约（URLSearchParams 编码、`hints=search`、github 恒等映射）；Context 默认值 undefined 即硬失败；`useMemo` 引用稳定；属性展开顺序；`rel="noopener"` | 107 |
| `ui/src/ToolCallBlocks/renderers/node-repl.tsx` | Node REPL 工具块渲染 | INV-01~18；短结果与 JSON 探测契约；`hasDetails`/`canToggle` 展开判定；错误与落盘结果可见性；摘要三态文案优先级；代码块 eager 布局权衡；`browser_turn_end` 提前返回 | 110 |
| `ui/src/feedback/FeatureRequestDialog.tsx` | 功能请求弹窗与异步建单 | INV-01~20；提交禁用与二次判空；提交中关闭/取消语义；只取消无 ticketId 的作业；卸载后不写状态；作业身份比较与订阅 dispose；`done` 链收尾；900ms 延迟切页 | 109 |
| `ui/src/prompt-editor/ChatPromptEditor.tsx` | 提示词编辑器 | INV-01~18；初值同步幂等与 rAF 时序；`onSubmit` 返回值透传；Esc 与 Dialog 事件冲突；拖拽三态判定与冒泡收口；两布局共树不重挂载；ref 归属与插槽渲染 | 110 |
| `ui/src/ToolCallBlocks/renderers/execute.tsx` | 命令执行工具块渲染 | INV-01~17；入参四形态归一（`-lc` 取下一项、shell 前缀正则、`parsed_cmd` 回落）；输出多路优先级；`safeParse` 静默降级；`isRunning`/权限预览守卫；陈旧闭包 | 107 |
| `desktop/src/main/networkTelemetryAggregator.ts` | 主进程网络遥测聚合 | INV-01~18；接口名脱敏与低基数化；每 transport 128 桶上限与 other 兜底；错误类型与 primary 并列裁决；重试计数语义；分阶段耗时容忍缺失；flush 破坏性读取与截断 | 109 |

合计 **1,312**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 解包必须先校验落点，再写任何字节

`localTarGz.ts` 对每个条目先做归一化路径与 `zip-slip` / 符号链接落点检查，通过后才创建目录与写文件。
把校验挪到写之后再检查、或以 `stat` 结果作为放行依据，都会让 `../` 条目在检查前就落到工作区之外；
而符号链接条目若先建链再校验，后面的普通条目会顺着链接写到链接目标所在目录。

### 2. deep link 的安全闸门顺序不可重排

`desktopOAuthDeepLink.ts` 在解析参数后先拒绝 UNC 路径、再做 `statSync`，最后才分发到窗口。
顺序一旦颠倒（先 `statSync` 或先找窗口），构造出的 `\\host\share` 形式 URL 会触发一次网络探测，
形成可被外部主机观测的 NTLM 凭据泄露面，而且用户侧看不到任何提示。

### 3. 未就绪窗口的 pending 重放必须有身份与上限

窗口尚未完成加载时，deep link 先进入 pending 队列，待 `did-finish-load` 后按窗口身份重放；
队列同时有去重与条数上限。去掉身份比较会让重放投递到后开的窗口，去掉上限则被反复点击撑成无界内存增长。

### 4. 遥测聚合的基数上限是硬约束

`networkTelemetryAggregator.ts` 每个 transport 只保留 128 个桶，超出归入 other。
放开这个上限后，接口名里带用户 id 或随机段时桶数随请求量线性增长，
最终表现为主进程内存缓慢上涨且指标导出体积失控，而单看某一次请求完全正常。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 解包先写后校验 | `../` 条目写到工作区外 |
| 符号链接先建链后校验 | 后续条目穿透到链接目标目录 |
| tar 块长度非 512 对齐仍继续解析 | 后续条目全部错位，解出乱码文件 |
| deep link 先 statSync 再拒 UNC | 触发外部网络探测，凭据泄露面 |
| pending 重放不校验窗口身份 | deep link 投递到错误的窗口 |
| pending 队列无上限 | 反复点击后内存持续增长 |
| 提交中允许直接关闭 | 作业继续建单，产生用户不知情的工单 |
| 作业回调不比较 id | 旧作业完成把新弹窗带进工单页 |
| 订阅不 dispose | 回调叠加，进度抖动 |
| 初值同步不幂等 | 光标被反复重置到开头 |
| Esc 在弹窗内不拦截 | 关闭编辑器的同时连带关闭上层弹窗 |
| 拖拽三态判定顺序错 | 工作区外文件被当作内部项处理 |
| 遥测桶无上限 | 主进程内存上涨、导出体积失控 |
| 桶名不脱敏 | 用户标识进入指标，造成隐私问题 |

## 顺延

B38 复算清单为 19 文件，本批取 12 个（含 B37 全部 7 个顺延），其余 7 个顺延到 B39：
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/subagent-session-query.ts`（缺口 103）、
`apps/zcode-cli/packages/cli/src/prompt-command.ts`（缺口 102）、
`apps/zcode-cli/packages/office-runtime/ui/viewers/PdfView.tsx`（缺口 102）、
`packages/ui/src/git-graph/GitGraphPane.tsx`（缺口 102）、
`packages/ui/src/lib/assistantPreviewCards.ts`（缺口 102）、
`packages/ui/src/lib/taskChangeSummary.ts`（缺口 102）、
`packages/ui/src/store/pluginManagementStore.ts`（缺口 102）。

> 说明：按防超限规则执行，每文件单独 spec（≤150 行），5~6 文件一组并行（并发上限 5，第 6 个顺延到下一波），
> 逐文件密度校验。本批 1 处 `suspicious` 已就地改写修正。
