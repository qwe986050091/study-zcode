# ZCode 阅读指南

前置知识：Node.js / TypeScript、`async` 与流式事件、SQLite 基础、WebSocket 与 JSON-RPC 的基本概念；不需要先懂 TUI 渲染。

## 一、从哪开始

先打开 `apps/zcode-cli/packages/cli/src/run.ts` 的 `run()` 与 `apps/zcode-cli/packages/cli/src/main.ts` 的 `main()`，看 `isTuiInvocation()` / `isProtocol` 如何分流；然后立刻进 `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts` 的 `AgentRuntime.admitPrompt()`（约 L612）。

从这里进的理由：`run()` / `main()` 决定这次进程是 TUI、headless 还是 protocol；`admitPrompt()` 则原子地决定一次用户提交是 **start / steer / queue**。后面所有 turn 都由这个判定驱动，先看它就不会把「排队」和「新开一轮」混在一起。

## 二、学习路线

按「CLI 分流 → 会话接纳 → 单轮生命周期 → 主循环 → 模型请求 → 工具执行」推进。

### 第 1 段：CLI 分流

- 入口：`apps/zcode-cli/packages/cli/src/index.ts` 的 `run` 导出 → `run.ts` 的 `run()` → `main.ts` 的 `main()`。
- 读到哪：`bootstrap-loader.ts` 为止，能说清 TUI、headless、protocol 三条入口与 stderr/stdout 边界。
- 读完应获得：为什么 TUI 要独占 stdout、headless 的默认权限模式为什么是 yolo、`--browser-executable` 为什么只在 headless 合法。
- 如何接上：三条入口最终都汇到 `AgentRuntime`，第 2 段从它开始。

### 第 2 段：会话接纳

- 入口：`apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts` 的 `AgentRuntime.admitPrompt()`。
- 读到哪：`runtime/methods/prompt-admission.ts` 与 `runtime/session-mode-port.ts`。
- 读完应获得：忙碌时是 steer 还是入队、control-only turn 在什么条件下产生、`AgentRuntime` 的 busy 真相由谁维护。
- 如何接上：接纳成功后进入第 3 段的 `executeTurn()`。

### 第 3 段：单轮生命周期

- 入口：`apps/zcode-cli/packages/core/src/runtime/methods/turn.ts` 的 `executeTurn()` / `executeTurnCommand()`。
- 读到哪：`apps/zcode-cli/packages/core/src/agent/turn-machine.ts` 与 `turn-state.ts`。
- 读完应获得：一轮从准入到收尾的状态迁移、持久化挂点、异常出口；知道哪些收尾是「无论如何都要跑」的。
- 如何接上：第 4 段的主循环由 `executeTurn()` 调起。

### 第 4 段：主循环

- 入口：`apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts` 的 `runRegularTurnLoop()`。
- 读到哪：`turn-loop-state.ts`、`turn-stop.ts`、`turn-step-finish.ts`。
- 读完应获得：模型步与工具步如何交替、停止条件有哪些、输出 token 续写与取消如何回到循环。
- 如何接上：模型步进第 5 段，工具步进第 6 段。

### 第 5 段：模型请求

- 入口：`apps/zcode-cli/packages/core/src/runtime/methods/model.ts` 的 `runModelTextRequest()`。
- 读到哪：`turn-model-step.ts`、`turn-model.ts`、`model-streaming-event.ts`，再到 `turn-model-step-usage.ts`。
- 读完应获得：流式事件如何转成消息与 `tool_use`、重试与 fallback 的边界、budget 在哪里扣减。
- 如何接上：产出的 tool_use 交给第 6 段。

### 第 6 段：工具执行

- 入口：`apps/zcode-cli/packages/core/src/runtime/methods/tools.ts` 的 `scheduleTools()` / `executeTools()`。
- 读到哪：`apps/zcode-cli/packages/core/src/tool/scheduler.ts` 的 `schedule()` / `canRunInParallel()`，再到 `tool/executor/call-runner.ts` 与 `permission-flow.ts`。
- 读完应获得：六级并发判定（完全未知→并行、具名但未知→串行）、拓扑分层与容量截断、权限询问与结果回填。
- 收束：到这里「一次提交 → 一轮 → 模型 → 工具 → 回填」闭环。

## 三、分支路线

- **只想懂工具并发调度**：先补第 4 段，再读 `core/src/tool/scheduler.ts` + `runtime/methods/tools.ts`；`scheduler.ts` 的六级短路可以从 `canRunInParallel()` 一处读通。
- **只想懂会话持久化**：先补第 3 段（知道写入时机），再读 `apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts` → `repositories/` → `migrations.ts`。
- **只想懂服务端与传输**：直接读 `packages/server/src/entry-http.ts` → `packages/server/src/http.ts`，可以不先读 turn。
- **只想懂 MCP 接入**：先补第 6 段，再读 `runtime/methods/mcp.ts` 与工具注册表。
- **只想懂压缩与上下文预算**：先补第 5 段，再读 `runtime/methods/compact*.ts`、`context*.ts`、`microcompact.ts`、`turn-model-step-usage.ts`。

## 四、可以跳过的部分

- 以模板句为主的段落：连续几屏只有「本文件负责……」套话、没有出现具体函数名、分支条件或不变量的，可以跳读；判断标准是能否从段落里抄出一个可验证的断言。
- 各插件包（`browser-use-plugin`、`pdf-plugin`、`presentations-plugin`、`office-runtime` 等）：除非做插件开发，否则只需知道它们通过工具注册表接入。
- TUI 渲染、i18n 文案、`packages/tui` 的布局细节：不影响主链路理解。
- 已有的 L1 分层注释可作二遍参考：`docs/annotation/L1-A1-turn与模型主链路.md`、`L1-A3-持久化与回退.md`、`L1-A5-工具执行器.md`。
- **不要跳过** `runtime/methods/turn.ts` 与 `runtime/methods/turn-loop.ts`：这两个文件的注释密度与断言质量高于多数开源仓，值得逐段细读，而不是按上面的「模板句」标准跳过。
