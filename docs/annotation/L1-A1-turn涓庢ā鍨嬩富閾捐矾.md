# L1-A1：Turn 与模型主链路（逐段密注索引）

> 批次范围：`apps/zcode-cli/packages/core/src/runtime/` 下 15 个文件（13 个在 `methods/`，2 个在 `runtime/`）。
> 目标：把文件头级地图升级为函数体内逐分支的中文注释，重点回答"为什么这样写 / 失败会怎样 / 维护哪条不变量"，不解释字面，不修改代码 token。

## 与大纲的对应

- 链路 0（入口与 Turn 生命周期）：`turn.ts` → `turn-loop.ts` → `turn-model-step.ts` → `turn-stop.ts`。
- 链路 1（模型请求与流式恢复）：`model.ts` → `streaming-recovery.ts` → `streaming-tool-coordinator.ts` → `streaming-tool-synthetic-result.ts`。
- 链路 2（工具执行器）：`tools.ts` → `turn-tools.ts` → `tool-result-settlement.ts`。
- 模型与执行态：`turn-model.ts` → `runtime-model.ts` → `model-selection.ts` → `execution-state.ts`。
- 不变量落点：#1（tool_call 配对结果）、#2（已提交内容不重放）、#3（权限只能收紧）、#5（单 active turn）、#7（latest 指针落库后更新）。

## 文件索引

| 文件 | 本次新增注释主题 | +行数 | 对应大纲链路 |
| --- | --- | --- | --- |
| `methods/turn.ts` | 模型创建失败回退链分流；TurnStarted 持久化顺序；turnRequestState.entries 唯一写入入口；catch 块错误归一化与队列状态翻转；不变量#5 | +39 | 链路 0 |
| `methods/turn-loop.ts` | drainPendingRuntimeCommands 消费失败收口；autoCompact 熔断不变量；ToolSearch 公告持久化与 latestConversationMessageId 指针；TurnMachine 纯状态推进；runModelBackedTurnStep 恢复链；不变量#7 | +10 | 链路 0 |
| `methods/turn-model-step.ts` | 恢复链优先级（selection fallback → stream recovery → off-peak → Start Plan）；off-peak 接管持久化；Start Plan busy 空 assistant discarded；取消快照持久化；不变量#2 | +9 | 链路 0 + 链路 1 |
| `methods/turn-stop.ts` | persistCompletedAssistantStep 回滚分支与 latest 指针恢复；step-finish part 与终态元数据写入顺序；不变量#7 | +6 | 链路 0 |
| `methods/model.ts` | 媒体投影失败不降级；tool_call 去重；error chunk 归一化抛出；contextExceeded 不走 stream recovery；不变量#1、#2 | +7 | 链路 1 |
| `methods/streaming-recovery.ts` | recoverPartialAssistantOutputFailure 的 discarded 标记与恢复锚点；不变量#2 | +4 | 链路 1 |
| `methods/streaming-tool-coordinator.ts` | synthetic 终态补齐 unknown_execution_state/not_executed；不变量#1 | +2 | 链路 1 |
| `methods/streaming-tool-synthetic-result.ts` | createSyntheticStreamedToolResult 的 reason 二选一语义；emitSyntheticStreamedToolError 早退；不变量#1 | +11 | 链路 1 |
| `methods/tools.ts` | readOnly 判定的 sideEffectScope 收紧；ToolBatchComplete 事件持久化顺序；resolvePermission 不放宽 deny；不变量#1、#3 | +8 | 链路 2 |
| `methods/turn-tools.ts` | 每个 tool 落 pending part 后才执行；不变量#1 | +2 | 链路 2 |
| `methods/tool-result-settlement.ts` | commitTurnRequestEntries 整批同步写入历史；persistPart 推进 tool part 终态；恢复锚点事件；不变量#1、#2 | +6 | 链路 2 + 链路 3 |
| `methods/turn-model.ts` | acceptSubmissionModelSelection 串行接纳去重；emitModelSelected 失败不阻断；applyRuntimeExecutionState 执行态写入；不变量#5 | +8 | 模型与执行态 |
| `methods/runtime-model.ts` | createRuntimeModel selection 空抛错；off-peak 绑定；withModelInvocationContext 递归 bind 与上下文合并顺序；modelRequestAdmission 闸门；不变量#5 | +10 | 模型与执行态 |
| `runtime/model-selection.ts` | cloneModelSelection 不变量（selection 独立副本，发布/持久化/回退互不污染） | +13 | 模型与执行态 |
| `runtime/execution-state.ts` | persistExecutionState 早退条件；applyRuntimeExecutionState 权限互斥/幂等/Plan-Goal 互斥/持久化顺序/事件；不变量#3 | +27 | 模型与执行态 |

合计：**+162 行（本轮）**；删除列均为 **0**；超 800 行文件 2 个（`turn.ts` 1361 行、`turn-model-step.ts` 1007 行）。

## 关键判定点落位（便于按图索骥）

- `turn.ts`：模型创建失败分两路——普通 turn 记下 creationFailure 交主链落库后抛错，/compact 直接写终态；appendTurnOutcomeEvent 是错误归一化统一出口，保证 turn 有且仅有一个终态事件。
- `turn-loop.ts`：latestConversationMessageId 必须在公告落库后更新（不变量#7），否则冷恢复会从已删除的消息开始投影。
- `model.ts`：contextExceeded 不抛流异常——若抛错会被通用 stream recovery 接管，绕过 turn 层的 reactive compact，导致无限重放同一超窗请求（不变量#2）。
- `streaming-tool-coordinator.ts`：synthetic 终态按 handles.has(id) 区分 unknown_execution_state（已启动）与 not_executed（未启动），保证取消/失败时每个已接受 tool call 都有配对结果（不变量#1）。
- `execution-state.ts`：Plan 与 active Goal 互斥校验在持久化之前，失败不留下半更新状态；先持久化 session entry 再改内存，避免 UI 显示与 durable 分裂。

## 校验

基线：`d:\code\_annot_baseline\L1-A1\`（编辑前快照，保持相对路径）。
零删除校验：对全部 15 个文件执行 `git --no-pager diff --no-index --numstat <基线> <当前>`，删除列均为 0。
