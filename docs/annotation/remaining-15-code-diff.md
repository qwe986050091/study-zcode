# 剩余 15 个「含代码增删」文件改动摘要（只读分析）

- 仓库 / 基线：`d:\code\ZCode`，对比基准 `HEAD`（`e6ff6fab`），基线目录 `d:\code\_annot_baseline\`
- 生成时间：2026-11-04
- 结论先行：**15 个文件的代码改动全部是格式化类（①），没有 ②等价重构、③语义变更、④异常**。其中仅 1 处是注释工作留下的非注释改动（`logs.ts` 补了 1 个分号，语义无影响）。

## 判定方法

1. `git diff HEAD -U0` 抽取所有非注释增删行；
2. `git diff HEAD -w` 再抽一次，确认差异是否只是空白/换行；
3. 用 TypeScript 对 `HEAD` 版本与工作区版本分别 `transpileModule({ removeComments: true })`，压缩空白后逐 token 比对（分号由 emitter 归一化，故单独核对）；
4. 有基线副本的文件用 `git diff --no-index --numstat` 判断注释工作是否引入代码改动（删除列是否为 0）。

## 汇总表

| 文件 | +/- | 性质 | 一句话摘要 | 注释工作是否引入代码改动 |
| --- | --- | --- | --- | --- |
| `apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts` | +132 / -22 | ① 格式化 | 长参数列表/catch 块/三元表达式按 100 列折行，对象字面量补尾随逗号；注释保留原位（`catch { /* … */ }` 改为独立行注释） | 否（`L2-B6` 基线与当前字节一致，mtime 11/1 00:12；代码差异早于本轮注释） |
| `.../session-store/sqlite-session-store.ts` | +88 / -6 | ① 格式化 | `open/openStartup` 签名与 `runSqliteSessionMigrationsAsync` 调用折行，`try/catch` 展开 | 否（`L2-B6` 基线与当前字节一致，mtime 11/1 00:12） |
| `apps/zcode-cli/packages/core/src/context/dynamic-sections.ts` | +45 / -2 | ① 格式化 | `buildSessionGuidanceSection` 签名折行、`lines.push(...)` 长字符串折行 | 否（`L2-B9` 基线 18/0，删除列 0） |
| `apps/zcode-cli/packages/core/src/context/sections/skills.ts` | +33 / -7 | ① 格式化 | `const lines = [...]` 三行合并为一行 | 否（`L2-B9` 基线 16/0） |
| `apps/zcode-cli/packages/core/src/errors/error-payload.ts` | +49 / -8 | ① 格式化 | 两处三元展开改为单行、两处 `retryable` 换行合并 | 无基线；去注释 token 比对仅尾随逗号/换行差异 |
| `apps/zcode-cli/packages/core/src/hooks/workspace-hook-trust-coordinator.ts` | +31 / -5 | ① 格式化 | import 三行合并为一行（去掉尾随逗号）；`evaluateSnapshot` 参数类型折行 | 无基线；token 比对仅尾随逗号/换行差异 |
| `apps/zcode-cli/packages/core/src/runtime/methods/background.ts` | +98 / -12 | ① 格式化 | import 合并、`isTerminalBackgroundTaskInfoStatus` 签名合并、`&&` 条件合并、`toolCallId` 三元合并 | 否（`L1-A4` 基线 9/0） |
| `apps/zcode-cli/packages/core/src/runtime/methods/file-rewind.ts` | +82 / -8 | ① 格式化 | 两处 `traceContext` 赋值合并；`return (a \|\| b)` 去掉多余括号 | 否（`L1-A3` 基线 26/0） |
| `apps/zcode-cli/packages/core/src/runtime/methods/model-streaming-event-queue.ts` | +27 / -7 | ① 格式化 | `highWaterMark` 赋值与 `emitModelStreamingEvent` 调用合并为单行 | 无基线；token 比对仅换行差异 |
| `apps/zcode-cli/packages/core/src/runtime/methods/rewind.ts` | +79 / -7 | ① 格式化 | 嵌套 `await this.rewindWorkspaceToCheckpoint({...})` 块整体多缩进 2 空格，仅空白变化 | 否（`L1-A3` 基线 30/0） |
| `apps/zcode-cli/packages/core/src/runtime/methods/target.ts` | +55 / -2 | ① 仅注释 | 代码本身 0 改动；在两处三元分支的 `await` 前插入 3 行解释性注释 | 否（`L1-A4` 基线 13/0） |
| `apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts` | +151 / -32 | ① 格式化 | `Promise.resolve(...).catch(...)`、`logger.debug(...)`、`buildWorkflowNotificationOriginMeta(...)` 五参数调用、两处条件展开对象折行 | 否（`L1-A5` 基线 34/0） |
| `apps/zcode-cli/packages/core/src/tool/scheduler.ts` | +99 / -2 | ① 格式化 | 两处 `readOnly` 赋值三元折行 | 否（`L1-A5` 基线 11/0） |
| `apps/zcode-cli/packages/ios-simulator-plugin/src/providers/logs.ts` | +27 / -1 | ① 格式化 | 唯一代码改动：`const ID = /^[A-Za-z0-9_.-]+$/` 行尾补 `;`（第 24 行） | **是**（`L2-B10b` 基线 27/1：该分号随注释一起写入）。`L2-B10b-2` 基线与当前一致 |
| `packages/services/src/mcp-sync/mcpSyncService.ts` | +73 / -164 | ① 格式化 | 大量多行调用/三元/函数签名合并为单行，净减 91 行；另有两处多余括号移除 | 无基线；token 比对仅尾随逗号/括号/换行差异 |

> 表中 `+/-` 来自 `git diff HEAD --numstat`（含注释行）。

## ③语义变更逐条展开

无。全部 15 个文件在 `-w` 与「去注释 token 比对」后均只剩以下三类差异：

- 换行/缩进（如 `rewind.ts` 第 134–140 行整块多缩进、`migration-runner.ts` 多处 `try`/`catch` 展开）；
- 尾随逗号增删（`migration-runner.ts` 的 `progress(...)`、`emitWarning(...)`、`SqliteSessionMigrationError(...)`；`mcpSyncService.ts` 的 `Object.fromEntries(map(...))`）；
- 冗余括号移除（`file-rewind.ts` 的 `return (a || b)`、`mcpSyncService.ts` 的 `resolveUserHomeDir()`）。

`target.ts` 两处 `? // 注释` / `: // 注释` 只新增了注释行，`finishTargetRun` / `accountTargetUsage` 调用未变。

## ④疑似异常逐条展开

无重复插入、误删或缺失分隔符。两处需要备案但不是异常：

1. `apps/zcode-cli/packages/ios-simulator-plugin/src/providers/logs.ts:24` —— `const ID = /^[A-Za-z0-9_.-]+$/;` 由无分号补为有分号。相对 `L2-B10b` 基线是 1 行删除 + 1 行新增，属于**注释工作（B10b 批次）留下的唯一非注释改动**，对运行无影响，但会违反「注释提交不得混入代码行」的口径，需要人工决定：回退该分号，或单独走 `style` 提交。
2. `apps/zcode-cli/packages/core/src/runtime/methods/rewind.ts:134-140` —— 三元分支内的 `await ...` 块比相邻分支多缩进 2 空格，排版与上下文不一致。纯空白，无行为差异，但显得像手工误操作留下的痕迹。

## 归因说明（「由本次注释工作引入」的依据）

- 15 个文件的 mtime 均在 `2026-11-03 02:07` 之前（最晚的是 `logs.ts`），而本轮注释提交 `e6ff6fab`（desktop host）发生在 `2026-11-04 00:36`，文件时间与本轮注释批次无交集 → 本轮 0 处。
- 9 个文件有基线副本：8 个删除列为 0（只有注释新增）；`migration-runner.ts` / `sqlite-session-store.ts` 的 `L2-B6` 基线与当前字节完全一致（基线抓取时间晚于改动，不能作为「未引入」的直接证据，但其代码差异同为 token 等价）；`logs.ts` 为 27/1。
- 4 个文件无基线副本（`error-payload.ts`、`workspace-hook-trust-coordinator.ts`、`model-streaming-event-queue.ts`、`mcpSyncService.ts`）：用「去注释 token 比对」证明代码侧等价，仅格式化差异。

## 提交建议

按仓库 `AGENTS.md`「不要将无关的功能、重构、依赖更新和格式调整混在同一个提交中」：

- 这 15 个文件**不能**进入纯注释提交（存在非注释行增删）；
- 建议先人工确认是否接受这些格式化漂移：接受则单独一个 `style(...)` 提交（`git add` 逐文件），不接受则用 `git checkout HEAD -- <file>` 回退格式行、仅保留注释行后再进注释批次（回退前需重新应用该文件的注释，或核对基线）；
- `logs.ts` 的分号建议回退，避免唯一一处「注释带代码」的例外。

## 最需要人工看一眼的 3 个文件

1. `packages/services/src/mcp-sync/mcpSyncService.ts` —— 净减 91 行、164 行删除，且无基线副本；虽已验证为 token 等价，但视觉上像大规模重写，评审最容易漏读。
2. `apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts` —— 110 行代码重排、补尾随逗号，且基线副本与当前完全一致（无法用基线回证），涉及 SQLite 迁移事务/备份路径，风险敏感度高。
3. `apps/zcode-cli/packages/ios-simulator-plugin/src/providers/logs.ts` —— 唯一有「注释工作引入代码 token 改动」的文件（第 24 行补分号），需要决定回退或单独提交。
