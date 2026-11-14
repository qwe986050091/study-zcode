# 注释安全体检报告（语法 / 闭合风险 / 类型检查）

- 仓库：`d:\code\ZCode`，分支 `main`，工作区含大量未提交改动（未提交任何内容）
- 扫描范围：`apps/` 下全部非测试 `.ts/.tsx`，排除 `dist/`、`dist-types/`、`node_modules/`、`fixtures/`、`__tests__/`、`tests/`、`coverage/`、`build/`
- 扫描工具：TypeScript 6.0.2 `ts.createSourceFile(...).parseDiagnostics`；注释风险用逐行状态机（区分 `//` 行注释与 `/* */` 块注释）；类型检查用 `tsc --noEmit -p <package>`
- 样本量：主扫描 1659 个源文件；另单独扫描 2 个 `.d.ts`（0 诊断）

## 一、语法错误文件（修复前 2 → 修复后 0）

| # | 文件 | 修复前 | 首条诊断 | 根因 | 最小修复 |
|---|---|---|---|---|---|
| 1 | `apps/zcode-cli/packages/android-emulator-plugin/src/mcp/server.ts` | 2 error | `TS18026: '#!' can only be used at the start of a file.`（10,1） | 文件头 JSDoc 被插到 shebang 之前，`#!` 不在文件首行（HEAD 中即已存在） | 把 `#!/usr/bin/env node` 从第 10 行移到第 1 行，注释块整体下移；仅 1 行位移 |
| 2 | `apps/zcode-cli/packages/ios-simulator-plugin/src/mcp/server.ts` | 2 error | `TS18026: '#!' can only be used at the start of a file.`（10,1） | 本次未提交的注释改写把文件头 JSDoc 插到了 shebang 之前 | 同上，shebang 移回第 1 行 |

复验：两个文件 `parseDiagnostics=0`；全仓重扫 `syntaxErrorFiles=0`。两处修复均未删除代码行，仅移动一行。

## 二、注释闭合风险点（共 25 个，均为 `//` 行注释内，当前不报错、按要求只记录）

| # | 类型 | 文件:行 | 原文片段 |
|---|---|---|---|
| 1 | `//` 内出现 `*/` | `apps/dev-docs/vitest.config.ts:4` | `// dev-docs 的 Vitest 配置：node 环境运行 test/**/*.test.ts（…）` |
| 2 | `//` 内出现 `*/` | `apps/zcode-cli/packages/contracts/src/interfaces/browser-control.port.ts:112` | `// browser*/recording*/tab 生命周期命令由 manager 层处理。…` |
| 3 | `//` 内出现 `*/` | `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts:408` | `// workspace*/remoteSessionId/clientMode/deliveryKind/turnId 只用于 shared-host 隔离与` |
| 4 | `//` 内出现 `*/` | `apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts:73` | `// plugin_reference/bot_topic_context/rewind/selection_side_chat/subagent*/` |
| 5 | `//` 内出现 `*/` | `apps/zcode-cli/packages/contracts/src/workflow/script.ts:410` | `// - create*/update* 返回落库后的完整记录，…` |
| 6 | `//` 内出现 `*/` | `apps/zcode-cli/packages/core/src/tool/handlers/glob.ts:8` | `// 【输入口径】pattern（如 "**/*.ts"）、path（可选目录）。…` |
| 7 | `//` 内出现 `*/` | `apps/zcode-cli/packages/core/src/tool/handlers/saved-workflows/frontmatter.ts:11` | `//     */`（示例块注释的收尾行，故意保留） |
| 8 | `//` 内出现 `*/` | `apps/zcode-cli/packages/core/src/tool/handlers/webfetch-network.ts:346` | `// …；`*/*` 兜底避免 406。`（历史事故残留，现已在行注释内） |
| 9 | `//` 内反引号奇数配对 | `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-retune.ts:4` | `// …这是 `DynamicWorkflowRunPort.` |
| 10 | 同上 | `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-retune.ts:5` | `// retuneConcurrency` 的实现体，…` |
| 11 | 同上 | `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-workspace.ts:5` | `// …`kind ∈ {world-read,` |
| 12 | 同上 | `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-workspace.ts:6` | `// world-run}` 的 `dwf_node` 行：…` |
| 13 | 同上 | `apps/zcode-cli/packages/bootstrap/src/app/workflow-seat-gate.ts:13` | `// …：`activeAsks = working +` |
| 14 | 同上 | `apps/zcode-cli/packages/bootstrap/src/app/workflow-seat-gate.ts:14` | `//      parked`——…` |
| 15 | 同上 | `apps/zcode-cli/packages/bootstrap/src/custom-command-shell-expansion.ts:1` | ``// …（`!`cmd`` 与 ```! 围栏）。`` |
| 16 | 同上 | `apps/zcode-cli/packages/bootstrap/src/custom-command-shell-expansion.ts:91` | ``// …避免 ```! 被误判成行内片段；…`` |
| 17 | 同上 | `apps/zcode-cli/packages/contracts/src/commands/index.ts:180` | ``// …若正文含 `!` 内联或 ```! 围栏…`` |
| 18 | 同上 | `apps/zcode-cli/packages/contracts/src/commands/index.ts:309` | ``// …内联 `!`…`` 或 ```! 围栏代码块。`` |
| 19 | 同上 | `apps/zcode-cli/packages/core/src/runtime/methods/title-generation-sidecar.ts:351` | ``// …误把 ```json 清洗成标题。`` |
| 20 | 同上 | `apps/zcode-cli/packages/dynamic-workflow/src/analysis/causality-order-walk.ts:118` | `// …not — `{ [await` |
| 21 | 同上 | `apps/zcode-cli/packages/dynamic-workflow/src/analysis/causality-order-walk.ts:119` | `// agent(..).ask(..)]() {} }` evaluates …` |
| 22 | 同上 | `apps/zcode-cli/packages/dynamic-workflow/src/analysis/taint.ts:586` | `// …mixin CALL (`class D extends` |
| 23 | 同上 | `apps/zcode-cli/packages/dynamic-workflow/src/analysis/taint.ts:587` | `// mix(Base)`): …` |
| 24 | 同上 | `apps/zcode-cli/packages/dynamic-workflow/src/analysis/taint.ts:596` | `// …so `new Promise((resolve) =>` |
| 25 | 同上 | `apps/zcode-cli/packages/dynamic-workflow/src/analysis/taint.ts:597` | `// resolve(draft))` never let draft …` |

结论：
- 未发现「块注释正文内出现 `*/` 导致提前闭合」的现存形态（`block-comment-early-close` = 0）。
- 上述 25 个点全部位于 `//` 行注释，反引号是跨行内联代码的配对写法或 glob/通配符记法，当前不影响解析；按处理原则不改，仅登记为后续若改成 `/* */` 时的风险点。
- 历史三起事故现状：`agent-runtime.ts` 已改为安全写法 `persist*` / `appendEvent`；`microcompact.ts` 解析正常；`webfetch-network.ts` 的 `*/*` 现位于 `//` 注释（第 8 条）。

## 三、各包 typecheck 结果（`tsc --noEmit -p <package>`）

有 `tsconfig.json` 的 19 个包：

| # | 包 | 结果 |
|---|---|---|
| 1 | adapters | 0 error |
| 2 | android-emulator-plugin | 0 error（修复后复跑） |
| 3 | bootstrap | 0 error |
| 4 | browser-use-plugin | 0 error |
| 5 | cli | 0 error |
| 6 | contracts | 0 error |
| 7 | core | 0 error |
| 8 | debug | 0 error |
| 9 | dynamic-workflow | 0 error |
| 10 | dynamic-workflow-runtime | 0 error |
| 11 | i18n | 0 error |
| 12 | ios-simulator-plugin | 0 error |
| 13 | node-repl-host | 0 error |
| 14 | office-runtime | 0 error |
| 15 | shared-types | 0 error |
| 16 | swift-bridge | 0 error |
| 17 | telemetry | 0 error |
| 18 | tui | 0 error |
| 19 | zcode-cua-plugin | `TS18003 No inputs were found`（tsconfig `include: ["src"]`，但包内无 `src/`、无 TS 源码；配置/布局问题，非代码错误） |

无 `tsconfig.json` 的 12 个包（无独立 tsc 工程，不进类型检查）：`bundled-skills`、`documents-plugin`、`image-search-plugin`、`pdf-plugin`、`plugin-creator-plugin`、`presentations-plugin`、`restore-legacy-sessions-plugin`、`skill-creator-plugin`、`spreadsheets-plugin`、`superpowers-plugin`、`visualize-plugin`、`zcode-guide-plugin`。其中 11 个包 TS 源文件数为 0，`superpowers-plugin` 有 1 个源文件，已纳入第一节的语法解析扫描。

## 四、附：非注释的等价改动（只报告，未修改）

对 396 个有 diff 的 `apps/` 文件按 hunk 扫描后，14 个文件含非注释行变化；逐个做结构化 AST 比对（忽略 JSDoc/注释/空白），差异均为**标点级等价改写**，无 `const current = currentGroup` 这类语义改动：

| 文件 | 差异性质 |
|---|---|
| `adapters/src/storage/session-store/migration-runner.ts` | 单行 try/catch 拆行 + 补尾随逗号 |
| `adapters/src/storage/session-store/sqlite-session-store.ts` | 参数/调用拆行 + 补尾随逗号 |
| `core/src/context/dynamic-sections.ts` | 参数补尾随逗号 |
| `core/src/context/sections/skills.ts` | 数组去掉尾随逗号 |
| `core/src/hooks/workspace-hook-trust-coordinator.ts` | import 去尾随逗号 |
| `core/src/runtime/methods/background.ts` | import/条件拆行、去尾随逗号 |
| `core/src/runtime/methods/file-rewind.ts` | 去掉 `return (a \|\| b)` 的多余括号 |
| `core/src/runtime/methods/model-streaming-event-queue.ts` | 调用参数去尾随逗号 |
| `core/src/tool/executor/background-tasks.ts` | 调用拆行、去尾随逗号 |
| `core/src/errors/error-payload.ts` | 拆行后等价 |
| `core/src/runtime/methods/target.ts` | 三元分支后插入注释，代码不变 |
| `core/src/tool/scheduler.ts` | 拆行后等价 |
| `ios-simulator-plugin/src/providers/logs.ts` | 正则常量补分号 |
| `android-emulator-plugin/src/mcp/server.ts` | 本次 shebang 位移修复 |

## 总结论

**全仓处于可编译状态**：语法解析 0 错误（修复前 2 个，均为 shebang 被文件头注释挤到非首行，已最小修复）；有 tsc 工程的 19 个包中 18 个 0 error，唯一未通过的 `zcode-cua-plugin` 是无 TS 源码导致的 `TS18003` 配置错误，不属于代码缺陷。注释闭合风险 25 点全部位于 `//` 行注释，无块注释提前闭合风险，当前无需修改。
