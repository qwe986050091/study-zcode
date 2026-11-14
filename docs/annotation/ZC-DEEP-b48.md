# ZC-DEEP-b48

> 批次：B48（12 文件，复算缺口 1,031 行；按当前工作树复算，优先同类/同目录：`core` 4 个、`ui/src/lib` 3 个、`ui/src` 3 个、`cli/command-center` 2 个）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b48\orig`；开工前 12 文件均为 `newComments=0`。

## 校验

```
node zc-verify.mjs ZC-deep-b48
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1090

node check-batch.mjs ZC-deep-b48 ZC-deep-b48-files.txt
TOTAL added=1090 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.27   461   323   101   90  packages/ui/src/lib/assistantDirectiveParser.ts
31.28   518   374   117   90  packages/ui/src/v4/conversationAssistantWorkItems.ts
31.28   491   358   112   89  packages/ui/src/lib/chatErrorAttribution.ts
31.29   447   310    97   90  apps/zcode-cli/packages/cli/src/command-center/slash-commands.ts
31.31   584   444   139   90  apps/zcode-cli/packages/core/src/runtime/internal-turn-methods.ts
31.36   495   354   111   89  apps/zcode-cli/packages/core/src/mcp/image-normalization.ts
31.44   402   299    94   90  packages/ui/src/UpdateStatusDialog.tsx
31.47   387   286    90   89  packages/ui/src/quickpick/quickPickCommands.ts
31.47   506   340   107   90  packages/ui/src/lib/toolDiffPreview.ts
31.47   833   591   186   95  apps/zcode-cli/packages/core/src/tool/handlers/edit.ts
31.48   508   359   113   94  apps/zcode-cli/packages/cli/src/command-center/create.ts
31.48   761   540   170   94  apps/zcode-cli/packages/core/src/workflow/lifecycle.ts
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.27 median=31.40 newComments=1090
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `core/tool/handlers/edit.ts` | Edit 工具（精确字符串替换） | INV-01~19；read-before-edit 三重校验（视图存在/mtime 未前进/内容一致）；精确匹配失败才走宽松匹配再对齐引号风格；多处匹配报 AMBIGUOUS_REPLACE；写回 atomic + expectedRevision 防覆盖；写成功同步 readFileState；空 old_string 的新建/已存在语义分流 | 95 |
| `core/workflow/lifecycle.ts` | 工作流快照生命周期变换（纯函数） | INV-01~18；恢复时 active 节点重置为 pending 并清 activity/phase；只重置 nodeIds 子图；取消仅限 active/pending，终态保历史；重开仅限终态且受 maxReopens；不满足前置条件抛错不静默降级；全部纯函数无 I/O | 94 |
| `core/mcp/image-normalization.ts` | MCP 图片归一化与降级 | INV-01~18；inline 按 base64 体积而非解码字节；raw 预算恒为 base64 的 3/4；官方 CUA 帧走保真透传且需 integrity + 帧引用双证据；伪造帧文本整块剥离；未变更返回原引用；单块失败不中断同批；取消优先于降级；落盘路径必须绝对 | 89 |
| `core/runtime/internal-turn-methods.ts` | 一轮对话的方法分发契约面 | INV-01~20；准入在同一同步段判定 busy/建 reservation/定 start-steer-queue；事件顺序 user→tool_scheduled→结果→checkpoint→终态；schedule 只读、execute 才产生副作用；rewind 先评估后变更、级联会话先行；fork 必须回 messageIdMap；compact 四入口共用摘要；durable 写入只走 createEvent/appendEvent；persist 失败必须上抛 | 90 |
| `ui/lib/assistantDirectiveParser.ts` | 助手特化指令纯文本解析 | INV-01~19；start/end 左闭右开；每轮新建起始正则避免 lastIndex 残留；负向断言禁止从连续冒号中间起匹配；consumedUntil 单调右移；引号内花括号与转义规则；参数非法置 null 不返回部分结果；围栏同字符且闭合不短于开启；未闭合围栏延到文末；前缀暂存只认文末连续尾部 | 90 |
| `ui/lib/chatErrorAttribution.ts` | 失败到 telemetry 归因的归一化 | INV-01~19；同入参同输出且不读模块外可变状态；空 reason 表示未失败、unknown 才表示无法归类；explicitSource 压过一切推断；source 与 reason 必须同表；结构化 reason 优先于弱证据；transport/generic code 只修正空或 unknown；413 先分上下文与请求体；状态码由窄到宽；正则禁 g 标志与回溯放大 | 89 |
| `ui/lib/toolDiffPreview.ts` | 工具调用 diff 文本生成 | INV-01~18；首行恒为 diff --git 同路径；新建/删除侧写 /dev/null；空差异仍返回合法 patch；按 LF 切分且不剥离 CRLF；前后缀不重叠；hunk 声明行数等于实际输出；LCS 单元上限触发锚点分段；锚点取唯一行且双下标递增；每条正文行恰好一个前导标记；结构化 diff 只下探一层防递归 | 90 |
| `ui/UpdateStatusDialog.tsx` | 更新状态弹窗（受控组件） | INV-01~18；phase 三态互斥；关闭只收 UI 不取消下载；下载中不渲染“稍后”；pending 时按钮与复选框全禁用并有 in-flight 二次拦截；skip 仅 before-download 且 skippable 时出现；三动作互斥渲染；标题 i18n 与阶段同步、版本号独占 nowrap；进度仅下载阶段挂载并 aria-live；edgeToEdge 关闭即卸载 | 90 |
| `ui/v4/conversationAssistantWorkItems.ts` | assistant 工作区行到渲染工作项的投影 | INV-01~18；输入顺序即渲染顺序；每行最多消费一次；Agent 行按 turnId + parentToolCallId 精确配对，仅历史行允许同 turn 兜底；分组 key 锚定首个真实 tool call；单工具不包成单子项分组；父阶段状态不等于子状态汇总；分组必须连续同类；过滤不回写输入；投影幂等、key 全局唯一 | 90 |
| `ui/quickpick/quickPickCommands.ts` | 快速选择命令注册表（纯数据） | INV-01~18；id 全局唯一；sectionId 必须在分区顺序表内；titleId 为 i18n key 不内联文案；keywords 中英双语小写；shortcut 仅展示不注册；disabled 不等于隐藏；run 惰性且不吞异常；能力开关缺省 true；登录/登出互斥；数组顺序即同分 tie-break；整体纯函数 | 89 |
| `cli/command-center/create.ts` | TUI 输入的单一出口 | INV-01~20；normalize 先行且后续只读 text/attachments；非 slash 只走 submitPrompt；登录闸门先于取 app；slash 命令遇附件显式拒绝；unknown 先交自定义命令；所有认领收敛在唯一 IIFE；历史在结果后只写一次；mode 每次现取；可选依赖缺失降级不抛错；abortSignal 原样透传；/new 必须回 sessionId 与 resetSessionProjection | 94 |
| `cli/command-center/slash-commands.ts` | 斜杠命令解析与帮助文案 | INV-01~19；命令名统一小写、rawName 保留原样；别名不跨命令复用；args 不参与命令名匹配；空输入/无斜杠返回 null；只认前导斜杠；未知命令保留 rawName 与 args；skill 空技能名与缺省 task 区分；可见集合由 workflowMode 门控且与 resolver 一致；内置优先于自定义；帮助目标归一大小写与前缀 | 90 |

合计 **1,090**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 准入必须在同一同步段内完成

`internal-turn-methods.ts` 的 `admitPrompt` 要求 busy 判定、reservation 建立、start/steer/queue 决策在同一个同步段内完成。
若拆成两次 await，两个并发 prompt 会同时看到 idle，同一会话出现两条交错 turn，历史写入顺序与 UI 顺序都会错乱。

### 2. Diff 首行必须是 `diff --git` 且两侧同路径

`toolDiffPreview.ts` 输出的第一行固定为 `diff --git`。若把正文里以 `--` 开头的 SQL 注释当成第二个文件头，
`@pierre/diffs` 会把整块预览解析成两个文件，后续 hunk 全部错位甚至崩溃。

### 3. 图片归一化只看 base64 体积

`image-normalization.ts` 的 inline 判定以 base64 字节数为准，而不是解码后的原始字节。
口径一旦放宽，请求体在编码后会超出 provider 上限，provider 直接丢弃整轮结果，用户看到的是“模型没有回复”。

### 4. 归因结果不回流

`chatErrorAttribution.ts` 的输出只用于观测看板。任何把归因结果用于 UI 提示或重试决策的改动，
都会让一次观测口径调整变成用户可感知的行为变更。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 准入拆成两次 await | 并发 prompt 同时 start，同一会话两条交错 turn |
| Edit 写回不带 expectedRevision | 覆盖用户或格式化工具刚写入的内容 |
| 恢复时未重置 active 节点 | 新进程永远等待旧进程的节点结果 |
| 官方 CUA 帧被重编码 | 像素契约破坏，模型按错误坐标点击 |
| MCP 单图失败中断整批 | 一张坏图带走同条结果里的文本与其他图片 |
| 指令解析复用带 g 的正则 | 同一轮后续指令被静默跳过 |
| 引号内花括号参与闭合判定 | 参数值被提前截断，后续正文当成参数 |
| diff hunk 声明行数与输出不符 | 解析器按声明吞行，后续 hunk 全部错位 |
| LCS 不设单元上限 | 千行文件分配数亿单元，主线程卡死 |
| 更新弹窗关闭即取消下载 | 用户以为已中止，安装包仍在写盘 |
| 工作项投影回写输入 rows | 二次渲染内容缺失或顺序跳动 |
| quick pick 把 disabled 写成过滤 | 用户以为功能被删除 |
| slash 命令附件被静默丢弃 | 用户以为命令带图生效 |
| 登录闸门晚于取 app | 未登录请求打到模型侧，报鉴权错误 |

## 顺延

B48 复算清单共 20 个候选，本批按同类同目录取 12 个，其余 8 个顺延到 B49，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 本批 `suspicious=0`；全部文件按 `round(code × 0.314) − 当前注释行` 精确补行，密度落在 31.27%~31.48%。
