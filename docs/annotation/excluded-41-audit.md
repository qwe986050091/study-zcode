# 被剔除 41 个文件审计报告

- 仓库：`d:\code\ZCode`（分支 `main`）
- 审计时间：2026-11-03
- 数据来源：上一轮 15 个 commit 的批次校验日志 + `_annot_baseline` 各批次基线 + 当前工作区

## 一、结论摘要

| 项 | 数量 | 说明 |
|---|---|---|
| 剔除记录 | 41 条 | 对应 **40 个唯一文件**；`execution-state.ts` 在 L1-A1、L2-B2 两次被剔除 |
| (A) 可安全提交 | 29 个 | 基线对比删除列 = 0，且相对 HEAD 的全部变更行均为注释行 |
| (B1) 仅注释改写但由本次引入 | 0 个 | 相对基线的删除列全部为 0，本次注释工作未删除任何行 |
| (B2) 含真实代码改动 | 11 个 | 相对 HEAD 存在代码行增删，提交会把既有/异常代码改动混入 |
| **其中本次注释工作引入代码改动** | **1 个** | **`turn.ts`：新增代码块 471-489 与既有 454-470 完全重复** |
| 补做提交 | 3 个 commit | 仅包含 29 个 (A) 类文件，均逐个指定路径暂存 |
| 仍留在工作区 | 11 个 (B2) | 一律未暂存、未提交，待人工决定 |

> 关键判断：`git diff --cached --numstat` 的“删除列非 0”绝大多数并非本次注释工作造成。逐文件对比基线后，**40 个文件的基线→当前删除列全部为 0**，即本次注释一律是纯增量。真正的风险只有两类：①既有未提交的代码/格式化改动被一起带进提交（10 个文件）；②`turn.ts` 中本次注释工作插入的重复代码块（1 个文件）。

## 二、判定方法

1. **基线 vs 当前工作区**：`git --no-pager diff --no-index --numstat <基线副本> <当前文件>`
   - 删除列 = 0 → 本次注释工作是纯增量，删除来自“注释开始前就存在的未提交改动” → (A)。
2. **HEAD vs 当前工作区**：`git --no-pager diff HEAD -U0 -- <file>`，把变更行分为“注释行 / 代码行”
   - 全部为注释行 → 提交后只产生注释变更，安全。
   - 含代码行 → (B2)，不提交。
3. **代码行是否本次引入**：用基线→当前 diff 中是否存在非注释新增行判定。只有 `turn.ts` 存在（17 行）。

## 三、表 A：(A) 可安全提交（29 个）

基线批次列表示该文件所属的注释批次；`基线 vs 当前` 与 `HEAD vs 当前` 均为 `+新增/-删除`。所有文件的基线删除列均为 0。

| # | 文件（相对仓库根） | 基线批次 | 基线 vs 当前 | HEAD vs 当前 | 当前 HEAD 端被替换的旧注释要点 |
|---|---|---|---|---|---|
| 1 | apps/zcode-cli/packages/core/src/runtime/methods/streaming-tool-coordinator.ts | L1-A1 | +2 / -0 | +258 / -1 | runtime admission 后空名保留说明 |
| 2 | apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts | L1-A1 | +9 / -0 | +144 / -1 | 自动续写提示不写入持久轨迹 |
| 3 | apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts | L1-A2 | +8 / -0 | +333 / -5 | 成员浅快照与不可变约定 |
| 4 | apps/zcode-cli/packages/core/src/runtime/methods/input-intent-persistence.ts | L1-A3 | +6 / -0 | +35 / -1 | 工具执行前收紧群任务授权 |
| 5 | apps/zcode-cli/packages/core/src/runtime/execution-state.ts | L2-B2 | +9 / -0 | +74 / -1 | 权限与 Plan 是已消费状态 |
| 6 | apps/zcode-cli/packages/core/src/runtime/helpers/turn-errors.ts | L2-B2 | +45 / -0 | +112 / -4 | TurnCancelled 属正常结束，不再无条件 emit TurnError |
| 7 | apps/zcode-cli/packages/core/src/tool/executor/permission-flow.ts | L1-A5 | +12 / -0 | +135 / -1 | 预览不能覆盖 Guarded 单次确认 |
| 8 | apps/zcode-cli/packages/core/src/tool/handlers/agent.ts | L2-B3 | +11 / -0 | +40 / -3 | 旧版英文分隔头注释 → 中文职责说明 |
| 9 | apps/zcode-cli/packages/core/src/tool/handlers/bash.ts | L2-B3 | +14 / -0 | +57 / -3 | 同上（Bash handler） |
| 10 | apps/zcode-cli/packages/core/src/tool/handlers/cron.ts | L2-B3 | +19 / -0 | +44 / -3 | 同上（Cron handlers） |
| 11 | apps/zcode-cli/packages/core/src/tool/handlers/edit.ts | L2-B3 | +13 / -0 | +86 / -4 | 同上 + `eslint-disable max-lines` 理由 |
| 12 | apps/zcode-cli/packages/core/src/tool/handlers/plan-mode.ts | L2-B4 | +120 / -0 | +140 / -3 | 同上（Plan Mode handlers） |
| 13 | apps/zcode-cli/packages/core/src/tool/handlers/read.ts | L2-B4 | +111 / -0 | +165 / -3 | 同上（Read handler） |
| 14 | apps/zcode-cli/packages/core/src/tool/handlers/workflow.ts | L2-B4 | +21 / -0 | +46 / -3 | 同上（Workflow handler） |
| 15 | apps/zcode-cli/packages/contracts/src/events/event-reducer-helpers.ts | L2-B5 | +15 / -0 | +85 / -3 | 英文分隔头 → 中文投影变换说明 |
| 16 | apps/zcode-cli/packages/contracts/src/events/event-reducer.ts | L2-B5 | +26 / -0 | +149 / -3 | 英文分隔头 → 中文状态投影说明 |
| 17 | apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts | L2-B7 | +46 / -0 | +152 / -7 | 三类事实分离 / 512 LRU 说明改写 |
| 18 | apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts | L2-B7 | +699 / -0 | +763 / -11 | 文件头职责与输入输出口径扩写 |
| 19 | apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/queue-auto-drain.ts | L2-B7 | +15 / -0 | +31 / -2 | 自动提升闸门 / fail-open 说明 |
| 20 | apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts | L2-B7 | +140 / -0 | +166 / -11 | reduce(transcript) ≡ reduce(events) 口径 |
| 21 | apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts | L2-B7 | +407 / -0 | +489 / -10 | 网关职责与 flushWindowMs 调度说明 |
| 22 | apps/zcode-cli/packages/core/src/context/builder.ts | L2-B9 | +63 / -0 | +119 / -14 | 拼装顺序 / 短前缀 identity 块说明 |
| 23 | apps/zcode-cli/packages/core/src/context/sections/cli-prefix.ts | L2-B9 | +6 / -0 | +16 / -3 | 英文分隔头 → 中文职责说明 |
| 24 | apps/zcode-cli/packages/core/src/context/sections/current-date.ts | L2-B9 | +6 / -0 | +21 / -3 | 同上 |
| 25 | apps/zcode-cli/packages/core/src/context/sections/env-info.ts | L2-B9 | +24 / -0 | +45 / -3 | 同上 |
| 26 | apps/zcode-cli/packages/core/src/context/sections/identity.ts | L2-B9 | +13 / -0 | +31 / -3 | 同上 |
| 27 | apps/zcode-cli/packages/core/src/context/sections/memory.ts | L2-B9 | +11 / -0 | +26 / -3 | 同上 |
| 28 | apps/zcode-cli/packages/core/src/context/sections/request-user-context.ts | L2-B9 | +30 / -0 | +49 / -3 | 同上 |
| 29 | apps/zcode-cli/packages/core/src/context/sections/workflow-actor.ts | L2-B9 | +17 / -0 | +34 / -5 | 同上 |

说明：表中“当前 HEAD 端被替换的旧注释”属于**基线快照之前**就已存在的注释改写（工作区里上一轮更早的注释成果），不是本次注释工作删除的；本次对每个文件只有新增行。

## 四、表 B1：仅注释改写、且由本次注释工作引入（0 个）

40 个文件的“基线 vs 当前工作区”删除列全部为 0，因此**没有任何一处删除/改写是本次注释工作造成的**。上一轮标注的“仅注释改写”实际是基线之前已存在的旧注释替换，已归入表 A。

## 五、表 B2：含真实代码改动（11 个，一律不提交）

| # | 文件 | 基线批次 | 基线 vs 当前 | HEAD vs 当前 | 代码改动摘要 | 是否本次注释引入 |
|---|---|---|---|---|---|---|
| 1 | apps/zcode-cli/packages/core/src/runtime/methods/turn.ts | L1-A1 | +39 / -0（其中 17 行为代码） | +232 / -7 | **471-489 新增注释 + 完整代码块，与 454-470 逐行完全相同（重复插入）**，事件名 `model.execution_selection.creation_fallback_unavailable` | **是（高度可疑，建议优先处理）** |
| 2 | apps/zcode-cli/packages/core/src/runtime/methods/file-rewind.ts | L1-A3 | +26 / -0 | +82 / +3 -8 | 129/333 行 traceContext 三行合并为一行；578 行 return 条件合并，无语义变化 | 否（既有多行格式化） |
| 3 | apps/zcode-cli/packages/core/src/runtime/methods/rewind.ts | L1-A3 | +30 / -0 | +79 / +7 -7 | 134-142 行代码块整体缩进变化（嵌套层级调整），无逻辑变化 | 否（既有改写） |
| 4 | apps/zcode-cli/packages/core/src/runtime/methods/background.ts | L1-A4 | +9 / -0 | +98 / +4 -12 | 42 行 import 类型合并；373 行 `&&` 条件合并；480/548 行函数签名合并 | 否（既有格式化） |
| 5 | apps/zcode-cli/packages/core/src/runtime/methods/target.ts | L1-A4 | +13 / -0 | +55 / +4 -2 | 274/283 行三元分支折叠并插入中文行内注释 | 否（既有重构） |
| 6 | apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts | L1-A5 | +34 / -0 | +151 / +39 -27 | 238-249、323-334、653-659、846 行 prettier 折行/展开，无逻辑变化 | 否（既有格式化） |
| 7 | apps/zcode-cli/packages/core/src/tool/scheduler.ts | L1-A5 | +11 / -0 | +99 / +4 -2 | prettier 折行 | 否（既有格式化） |
| 8 | apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts | L2-B6 | **0 / 0（与基线完全一致）** | +132 / +89 -21 | 新增 `onProgress` 的 try/catch、`migration` 初始化移出 acquire、多处多行展开；属独立重构 | 否（基线前已存在） |
| 9 | apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts | L2-B6 | **0 / 0（与基线完全一致）** | +88 / +17 -4 | `open` / `openStartup` 签名与调用折行 | 否（基线前已存在） |
| 10 | apps/zcode-cli/packages/core/src/context/dynamic-sections.ts | L2-B9 | +18 / -0 | +45 / +7 -2 | `buildSessionGuidanceSection` 签名折行、`lines.push` 拆行 | 否（既有格式化） |
| 11 | apps/zcode-cli/packages/core/src/context/sections/skills.ts | L2-B9 | +16 / -0 | +33 / +1 -4 | `lines` 数组字面量合并为一行 | 否（既有格式化） |

### 关于 turn.ts 的判断依据

- 基线副本创建时间 **2026-11-02 22:37:39**（内容为 10/31 版本），文件当前 mtime **2026-11-02 22:56:57**，即代码块是在基线快照之后新增的。
- 新增块 471-489 与既有 454-470 **完全重复**，且 471-472 的注释文风（“所有候选都失败:标记 …;失败处理:仅 warn 不抛错”）与本次中文注释风格一致。
- 因此判定为本次注释工作（或其并发编辑）引入的重复代码，属于必须人工回滚的项。未做任何改动，仅记录。

## 六、补提交记录

| commit | 说明 | 文件数 | 变更 |
|---|---|---|---|
| `bce5596a` | `docs(注释): 补齐被剔除的 runtime/tool 注释改写` | 14 | +1669 / -36 |
| `ee933d52` | `docs(注释): 补齐被剔除的 contracts/bootstrap-v4 注释改写` | 7 | +1835 / -47 |
| `013c4c5c` | `docs(注释): 补齐被剔除的 context 段落注释改写` | 8 | +341 / -37 |

删除行均为旧英文注释/旧中文注释被替换，已逐行校验无非注释行；未 push。

提交前均执行：
- `git diff --cached --numstat` 记录每个文件的增删列（删除列均为注释行）；
- `git diff --cached -U0` 逐行校验所有新增/删除行均为注释或空行，代码行计数为 0；
- 逐个指定路径 `git add`，未使用 `git add -A`，未 push、未 amend、未 rebase。

## 七、仍留在工作区待人工决定（11 个，B2）

见第五节表格 1-11，全部保持未暂存状态。其中 `turn.ts` 建议优先人工确认 471-489 是否应删除；其余 10 个需代码 owner 确认既有未提交改动的归属后再决定是否随代码提交。
