# ZC-DEEP-b76

> 批次：B76（6 文件，按 31.4% 口径计算目标 358 行，实际 +358，无补插）。
> 自本批起单批降为 **6 文件**，分两波 3 + 3 执行，降低中断中途的概率。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b76\orig`；开工前 6 文件均为 `newComments=0`（30% 口径 needLines=335）。

## 校验

```
node zc-verify.mjs ZC-deep-b76
SUMMARY files=6 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=358

node check-batch.mjs ZC-deep-b76 ZC-deep-b76-files.txt
TOTAL added=358 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.33   459   332   104   59  apps/zcode-cli/packages/core/src/runtime/methods/context.ts
31.34   521   367   115   60  apps/zcode-cli/packages/tui/src/app-tool-transcript.ts
31.40   406   293    92   59  apps/zcode-cli/packages/core/src/hooks/workspace-hook-review-flow.ts
31.44   532   388   122   60  apps/zcode-cli/packages/bootstrap/src/app/script-workflow-runtime.ts
31.53   330   222    70   60  packages/ui/src/components/ai-elements/queue.tsx
31.63   290   215    68   60  packages/ui/src/DesktopTopOverlay.tsx
SUMMARY files=6 coreBelow30=0 needLines=0 min=31.33 median=31.42 newComments=358
PASS: all 6 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `bootstrap/src/app/script-workflow-runtime.ts` | 脚本工作流运行时 | INV-01~18；调用序号按实例累计且 run/resume 不重置；活动行先 create 再排队；终态记录先于事件写入 | 60 |
| `core/src/hooks/workspace-hook-review-flow.ts` | workspace hook 审核流程 | INV-01~18；每 session 单槽位，同代际 open 幂等；校验顺序存在性→代际→快照；settle 必须 clearTimeout 且只 resolve 一次 | 59 |
| `core/src/runtime/methods/context.ts` | 上下文初始化方法 | INV-01~18；contextInitialized 只在历史重建成功后置位；历史前缀按快照→init→回灌顺序；三类降级都不抛错终止 | 59 |
| `tui/src/app-tool-transcript.ts` | TUI 工具调用流水 | INV-01~18；卡片身份只认 toolCallId；阶段单向推进不回退；展示层单一收口限 4 行/100 列 | 60 |
| `ui/src/components/ai-elements/queue.tsx` | 队列卡片组件组 | INV-01~18；status 解析先于图标/样式查表；属性展开顺序决定覆盖关系；层级结构不可合并 | 60 |
| `ui/src/DesktopTopOverlay.tsx` | 桌面顶部浮层 | INV-01~18；指针事件成对作用才附 no-drag；平台分支互斥判定；浮层宽度只在侧栏可见时绑变量 | 60 |

合计 **358**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. contextInitialized 只在历史重建成功后置位

`context.ts` 把它当作「初始化已完成」的唯一事实源。
提前置位会让下一轮沿用半成品历史，且初始化异常后再也不会重试，用户看到的是永久缺失的前缀。

### 2. 每 session 只保留一个 review flow 槽位

`workspace-hook-review-flow.ts` 同代际重复 `open` 幂等复用，pending 期跨代际必须显式 supersede。
放任并存会让两个 flow 各自计时并分别 resolve，审核结果与用户看到的卡片对不上。

### 3. 终态记录先于事件写入

`script-workflow-runtime.ts` 先落库终态再发事件，订阅方在 finally 退订。
顺序颠倒后，订阅者被唤醒时查库仍是 running，任务列表会停在「进行中」。

### 4. 阶段只前进不回退

`app-tool-transcript.ts` 的 pending → running → completed/failed 单向推进，终态可补建但不回退。
回退会让已完成的卡片重新显示为运行中，用户重复触发同一个工具。

### 5. 属性展开顺序即覆盖关系

`queue.tsx` 把 `{...props}` 放在 className、尺寸、defaultOpen 之后。
前置展开会让调用方无法覆盖默认值，自定义宽度与初始展开态全部失效。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 初始化标记提前置位 | 历史前缀永久缺失且不再重试 |
| 活动更新早于子会话持久化 | 外键失败，活动行丢失 |
| review flow 并存 | 审核结果与卡片错位 |
| settle 未清定时器 | 超时后仍会二次 resolve |
| 阶段允许回退 | 已完成卡片重回运行中 |
| toolName 缓存后写 | 乱序事件覆盖正确名称 |
| status 解析晚于查表 | 未完成项显示为完成样式 |
| props 前置展开 | 调用方默认值覆盖全部失效 |
| 平台分支顺序错 | Windows 走到 mac 分支，按钮错位 |
| 宽度变量无条件绑定 | 侧栏隐藏时浮层宽度塌陷 |

## 顺延

B76 复算清单共 20 个候选，本批取 6 个，其余 14 个顺延到 B77（含 `hooks/useComposerConnectionSwitch.ts`、
`hooks/useSessionSubagents.ts`、`lib/builtinSkillI18n.ts`、`mentions/providers/sessionsMentionProvider.ts`、
`remote-connection/RemoteConnectionHistoryInput.tsx`、`ToolCallBlocks/fileSummaries.ts` 等），
开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec，3 文件一组并行，逐文件密度校验。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.33%~31.63%，`suspicious=0`。
> 本批 6 个 spec 的 raw 首块均自带 `//` 前缀，一次插入成功，无补插。
