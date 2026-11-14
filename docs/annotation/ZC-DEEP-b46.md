# ZC-DEEP-b46

> 批次：B46（12 文件，缺口 1,071 行；按当前工作树复算，优先同类/同目录：`ui/v4`、`ui/lib`、`shared`、`adapters`）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b46\orig`；开工前 12 文件均为 `newComments=0`，无半插入残留。

## 校验

```
node zc-verify.mjs ZC-deep-b46
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1127

node check-batch.mjs ZC-deep-b46 ZC-deep-b46-files.txt
TOTAL added=1127 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.30   498   361  113   94  packages/ui/src/DirectoryBrowser.tsx
31.32   797   562  176   96  apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts
31.33   446   332  104   95  packages/ui/src/v4/ConversationDraftSuggestedPrompts.tsx
31.36   521   354  111   92  packages/ui/src/lib/nodeReplToolDisplay.ts
31.37   441   322  101   93  packages/ui/src/lib/chatErrorAttributionEvidence.ts
31.41   522   382  120   94  packages/ui/src/v4/composer/composerDraftStore.ts
31.45   454   337  106   94  packages/shared/src/project-access-token-client.ts
31.46   481   356  112   95  packages/ui/src/app-shell/WorkflowWorkspaceCard.tsx
31.47   660   483  152   97  apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-run.ts
31.53   414   314   99   93  packages/ui/src/project-sidebar/ChatRemoteFolderSelection.tsx
31.56   458   301   95   92  packages/shared/src/permission-request-preview.ts
31.56   432   301   95   92  packages/ui/src/components/ui/chart.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.30 median=31.43 newComments=1127
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `adapters/src/exec/node-execution-adapter-run.ts` | 单次执行状态机 | INV-01~20；唯一 spawn 点；finishExit 幂等；requestStop 首因优先；登记与注销成对；输出路径 spawn 前发布；timeout 只覆盖运行期；孤儿进程与 pipe 未释放的失败路径 | 97 |
| `adapters/src/model/failure-classifier.ts` | 模型失败分类 | INV-01~20；取消优先且恒不可重试（两处冗余守卫）；retry-after 单次解析全分支透传；业务码优先于 HTTP 状态；WeakSet 防环；400~599 状态码域；BFS 层序稳定；兜底不抛错 | 96 |
| `ui/v4/ConversationDraftSuggestedPrompts.tsx` | 草稿推荐提示词入口 | INV-01~20；chips 与 list 双形态；Popover 固定结构避免重挂；浮层开关单一真源 anchorItemId；受控确认弹窗与二次关闭；i18n 解析与 reduced-motion | 95 |
| `ui/app-shell/WorkflowWorkspaceCard.tsx` | 工作流工作区卡片 | INV-01~20；persistKey 三元组决定展开记忆；状态只取 journal、failed 兼看 exitCode；Read 不可展开；peek 与正文互斥；Windows 盘符路径判定；running 只显示 startedAgo | 95 |
| `ui/DirectoryBrowser.tsx` | 目录浏览器 | INV-01~20；请求票据保证最后一次导航胜出；await 后逐处 isCurrent 校验；finally 持票关 loading；隐藏目录必须省略 includeHidden 键；符号链接只换图标；embedded 分流不带遮罩与 Esc | 94 |
| `ui/v4/composer/composerDraftStore.ts` | Composer 草稿持久化 | INV-01~20；scope 由 clientNamespace/hostId/projectId 组成；读-改-写合并；未显式传入不抹 projectId/taskGroupId；空白正文不落盘；legacyClaimed 认领；写盘降级 | 94 |
| `shared/src/project-access-token-client.ts` | 项目访问令牌客户端 | INV-01~20；会话键为 origin 加 family；登录切换清缓存并递增 generation；跨 await 副作用前 assertCurrent；在途 Promise 去重与失败即删；仅 404 废弃 Key ID；错误只外传固定码 | 94 |
| `ui/lib/chatErrorAttributionEvidence.ts` | 聊天错误归因证据 | INV-01~20；来源仅三值且分支原子返回成对证据；判定顺序即优先级；业务码仅对白名单 provider 生效；码先 trim 再查表；传输码大小写归一；超时优先于断连；证据不足不臆造 reason | 93 |
| `ui/project-sidebar/ChatRemoteFolderSelection.tsx` | 远端目录确认入口 | INV-01~20；hostId 唯一派生；alive 与 isCurrent 双重会话校验；flight 同步互斥；admittedHost 成员身份基准；matches 单根/未删除/路径来源一致；保存前 readHost 与 readDirectory 复核 | 93 |
| `ui/lib/nodeReplToolDisplay.ts` | node_repl 展示模型 | INV-01~20；实时 tool.updated 与终态 snapshot 双形态递归扫描；深度上限 4；visited 防环；MIME 白名单与图片去重；标题实现名过滤；js_reset 全名前缀判定 | 92 |
| `shared/src/permission-request-preview.ts` | 权限请求预览归一化 | INV-01~20；入口永不抛出；rawInput 优先于 input；键名一律小写匹配；四条递归路径依赖 seen 防环；文件路径上限 6 前置熔断；目录键 cwd/directory 跳过；scope 三元链顺序即语义 | 92 |
| `ui/components/ui/chart.tsx` | Chart 基础组件族 | INV-01~20；chartId 必须合法且与 data-chart 同源；Provider value 必须 memo 稳定；按主题注入 CSS 变量；Tooltip 提前返回位于全部 hook 之后；载荷只解一层且配置键仅接受字符串 | 92 |

合计 **1,127**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 执行状态机只允许一个 spawn 点

`node-execution-adapter-run.ts` 每次执行只能从唯一位置 spawn 子进程，`finishExit` 必须幂等，
`requestStop` 以首因为准。改错时会出现孤儿进程（父进程已收尾、子进程仍在写输出）、
或者取消路径被误报成 `spawn_error`，排障时看到的失败原因与真实原因完全不符。

### 2. 取消优先于一切可重试判定

`failure-classifier.ts` 中取消错误即使同时带 5xx 或网络错误特征，也必须判定为不可重试。
若顺序被调换，用户点了停止之后系统还会自动重试，表现为「越取消越忙」，并可能重复计费。

### 3. 目录浏览必须让最后一次导航胜出

`DirectoryBrowser.tsx` 用单调票据标记每次导航，所有 await 之后逐处校验 `isCurrent`。
缺这一层时，慢返回的旧目录会覆盖新目录，用户看到路径与列表内容对不上，点确认还会把
错误路径交给上层。

### 4. 访问令牌缓存必须在跨 await 前确认代际

`project-access-token-client.ts` 在登录切换时清空缓存并递增 generation，所有跨 await 的写入
前都要 `assertCurrent`。少了这道检查，登出后再登录的旧请求回写，会把上一个账号的令牌
安装到当前会话，属于跨账号串号故障。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 执行状态机出现第二个 spawn 点 | 同一次执行拉起两个进程，输出交错 |
| finishExit 不幂等 | exit 与 close 双触发，结果被覆盖 |
| 取消错误被判定成可重试 | 用户停止后系统继续重试并重复计费 |
| 目录导航不校验票据 | 旧响应覆盖新列表，确认路径与显示不一致 |
| 草稿持久化不合并旧字段 | 切项目后 projectId 被抹掉，草稿串到别的项目 |
| 令牌缓存不校验代际 | 登出重登后旧令牌回写，跨账号串号 |
| 权限预览递归不防环 | 循环引用 input 导致渲染栈溢出 |
| 图表 Provider value 不稳定 | 每次渲染重建上下文，所有图表重绘 |
| node_repl 递归不设深度上限 | 深嵌套 raw 扫描卡死消息渲染 |
| 推荐提示词浮层多个真源 | 浮层反复重挂，动画重播 |

## 顺延

B46 复算清单共 20 个候选，本批取 12 个（`ui` 8 个、`shared` 2 个、`adapters` 2 个），
其余 8 个顺延到 B47，将在开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 `suspicious=0`；全部文件按 `round(code × 0.314) − 当前注释行` 精确补行，密度落在 31.30%~31.56%。
