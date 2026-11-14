# apps 覆盖率审计（L2 中文注释）

> 审计时间：2026-11-03　范围：`d:\code\ZCode\apps` 下全部非测试 `.ts` / `.tsx` 文件。
> 判定口径（以文件实际内容为准，不依赖索引）：文件内中文注释行 ≥ 8，或存在含中文的 `/**` 块；否则视为未注。

## 一、总览

| 指标 | 数量 |
| --- | --- |
| 枚举文件总数（排除 \*.test.\* / \*.spec.\* / __tests__/ / fixtures/ / dist/ / node_modules/） | 2004 |
| 已注（达到 L2 阈值） | 1219 |
| 未注 | 785 |
| 其中：测试支撑 `tests/**` + 构建产物 `dist-types/**` | 322 |
| 其中：`bootstrap/src/**`（本任务不触碰，含 v4） | 29 |
| **本批待补齐（L2-B10 范围）** | 434 |
| 本批待补齐文件总行数 | 66427 |

说明：

- `apps/zcode-cli/packages/*/tests/**`、`dynamic-workflow/tests/**` 为测试支撑与图数据，按“非测试文件”口径不纳入补齐。
- `node-repl-host/dist-types/**` 为构建产物。
- `bootstrap/src/**` 由另一会话处理；其中 `zcode-protocol-v4/**` 已由 L2-B7 批完成，本任务不改动。

## 二、按目录聚合（全部目录）

| 目录 | 文件数 | 已注 | 未注 | 本批待补 |
| --- | --- | --- | --- | --- |
| `apps/dev-docs` | 2 | 0 | 2 | 2 |
| `apps/dev-docs/src` | 3 | 0 | 3 | 3 |
| `apps/dev-docs/src/capability-map` | 12 | 0 | 12 | 12 |
| `apps/dev-docs/src/data` | 4 | 0 | 4 | 4 |
| `apps/dev-docs/src/feature-boundary-graph` | 2 | 0 | 2 | 2 |
| `apps/zcode-cli` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/.agents/skills/opentui` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/adapters/src` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/adapters/src/auth` | 9 | 8 | 1 | 1 |
| `apps/zcode-cli/packages/adapters/src/browser` | 8 | 8 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/commands` | 2 | 2 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/config` | 7 | 7 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/context` | 2 | 2 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/conversation-recording` | 6 | 5 | 1 | 1 |
| `apps/zcode-cli/packages/adapters/src/device` | 6 | 6 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/exec` | 24 | 22 | 2 | 2 |
| `apps/zcode-cli/packages/adapters/src/fs` | 3 | 3 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/http` | 3 | 3 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/image` | 5 | 5 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/logging` | 3 | 3 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/mailbox` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/mcp` | 20 | 20 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/model` | 59 | 58 | 1 | 1 |
| `apps/zcode-cli/packages/adapters/src/model/endpoint-routing-edition` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/model/request-security-edition` | 2 | 2 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/network` | 4 | 4 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/pdf` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/plugins` | 16 | 16 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/provider` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/adapters/src/skills` | 3 | 3 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/storage` | 5 | 4 | 1 | 1 |
| `apps/zcode-cli/packages/adapters/src/storage/session-store` | 9 | 7 | 2 | 2 |
| `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations` | 3 | 3 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories` | 20 | 20 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/src/tools` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/adapters/src/workflow` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/adapters/tests` | 3 | 0 | 3 | 0 |
| `apps/zcode-cli/packages/android-emulator-plugin/src/lib` | 3 | 0 | 3 | 3 |
| `apps/zcode-cli/packages/android-emulator-plugin/src/mcp` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/android-emulator-plugin/src/providers` | 12 | 0 | 12 | 12 |
| `apps/zcode-cli/packages/bootstrap/src` | 32 | 24 | 8 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app` | 108 | 107 | 1 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/conversation-recording` | 4 | 2 | 2 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/lib` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/runtime-subagents` | 4 | 3 | 1 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/session-execution` | 6 | 4 | 2 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol` | 53 | 42 | 11 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4` | 40 | 40 | 0 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands` | 7 | 6 | 1 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers` | 13 | 13 | 0 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui` | 15 | 12 | 3 | 0 |
| `apps/zcode-cli/packages/bootstrap/tests` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/bootstrap/tests/helpers` | 13 | 9 | 4 | 0 |
| `apps/zcode-cli/packages/browser-use-plugin/src` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/cli/src` | 56 | 17 | 39 | 39 |
| `apps/zcode-cli/packages/cli/src/argument-parsing` | 3 | 2 | 1 | 1 |
| `apps/zcode-cli/packages/cli/src/command-center` | 14 | 3 | 11 | 11 |
| `apps/zcode-cli/packages/cli/src/command-center/handlers` | 11 | 1 | 10 | 10 |
| `apps/zcode-cli/packages/cli/src/internal-search` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/cli/tests` | 1 | 0 | 1 | 0 |
| `apps/zcode-cli/packages/contracts/src` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/contracts/src/capabilities` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/contracts/src/commands` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/contracts/src/compact` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/contracts/src/config` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/contracts/src/errors` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/contracts/src/events` | 7 | 6 | 1 | 1 |
| `apps/zcode-cli/packages/contracts/src/hooks` | 3 | 3 | 0 | 0 |
| `apps/zcode-cli/packages/contracts/src/interfaces` | 34 | 33 | 1 | 1 |
| `apps/zcode-cli/packages/contracts/src/logging` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/contracts/src/model` | 6 | 5 | 1 | 1 |
| `apps/zcode-cli/packages/contracts/src/network` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/contracts/src/path` | 2 | 1 | 1 | 1 |
| `apps/zcode-cli/packages/contracts/src/plugins` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/contracts/src/rewind` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/contracts/src/skills` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/contracts/src/telemetry` | 2 | 2 | 0 | 0 |
| `apps/zcode-cli/packages/contracts/src/time` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/contracts/src/tools` | 50 | 50 | 0 | 0 |
| `apps/zcode-cli/packages/contracts/src/tracing` | 2 | 2 | 0 | 0 |
| `apps/zcode-cli/packages/contracts/src/workflow` | 2 | 2 | 0 | 0 |
| `apps/zcode-cli/packages/core/src` | 4 | 1 | 3 | 3 |
| `apps/zcode-cli/packages/core/src/agent` | 14 | 6 | 8 | 8 |
| `apps/zcode-cli/packages/core/src/browser-client` | 7 | 4 | 3 | 3 |
| `apps/zcode-cli/packages/core/src/compact` | 6 | 0 | 6 | 6 |
| `apps/zcode-cli/packages/core/src/context` | 5 | 4 | 1 | 1 |
| `apps/zcode-cli/packages/core/src/context/sections` | 9 | 9 | 0 | 0 |
| `apps/zcode-cli/packages/core/src/embedded-search` | 2 | 0 | 2 | 2 |
| `apps/zcode-cli/packages/core/src/errors` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/core/src/hooks` | 19 | 19 | 0 | 0 |
| `apps/zcode-cli/packages/core/src/mcp` | 4 | 3 | 1 | 1 |
| `apps/zcode-cli/packages/core/src/memory` | 9 | 9 | 0 | 0 |
| `apps/zcode-cli/packages/core/src/memory/recall` | 5 | 5 | 0 | 0 |
| `apps/zcode-cli/packages/core/src/model` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/core/src/permission` | 6 | 2 | 4 | 4 |
| `apps/zcode-cli/packages/core/src/plugin-reference` | 4 | 3 | 1 | 1 |
| `apps/zcode-cli/packages/core/src/repl` | 5 | 4 | 1 | 1 |
| `apps/zcode-cli/packages/core/src/runtime` | 13 | 13 | 0 | 0 |
| `apps/zcode-cli/packages/core/src/runtime-task` | 6 | 4 | 2 | 2 |
| `apps/zcode-cli/packages/core/src/runtime/helpers` | 58 | 58 | 0 | 0 |
| `apps/zcode-cli/packages/core/src/runtime/methods` | 106 | 103 | 3 | 3 |
| `apps/zcode-cli/packages/core/src/runtime/off-peak` | 4 | 4 | 0 | 0 |
| `apps/zcode-cli/packages/core/src/runtime/tool-result-settlement` | 3 | 3 | 0 | 0 |
| `apps/zcode-cli/packages/core/src/session-context` | 6 | 1 | 5 | 5 |
| `apps/zcode-cli/packages/core/src/subagent` | 22 | 2 | 20 | 20 |
| `apps/zcode-cli/packages/core/src/system-reminder` | 3 | 0 | 3 | 3 |
| `apps/zcode-cli/packages/core/src/telemetry` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/core/src/tool` | 25 | 23 | 2 | 2 |
| `apps/zcode-cli/packages/core/src/tool/channel-reply` | 3 | 3 | 0 | 0 |
| `apps/zcode-cli/packages/core/src/tool/executor` | 38 | 38 | 0 | 0 |
| `apps/zcode-cli/packages/core/src/tool/handlers` | 128 | 114 | 14 | 14 |
| `apps/zcode-cli/packages/core/src/tool/handlers/generated` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/core/src/tool/handlers/guarded` | 8 | 6 | 2 | 2 |
| `apps/zcode-cli/packages/core/src/tool/handlers/saved-workflows` | 4 | 3 | 1 | 1 |
| `apps/zcode-cli/packages/core/src/tool/search` | 5 | 5 | 0 | 0 |
| `apps/zcode-cli/packages/core/src/tool/workflow-entrypoints` | 3 | 2 | 1 | 1 |
| `apps/zcode-cli/packages/core/src/workflow` | 4 | 3 | 1 | 1 |
| `apps/zcode-cli/packages/core/src/workflow/expert` | 13 | 13 | 0 | 0 |
| `apps/zcode-cli/packages/core/src/workflow/expert/parsers` | 5 | 5 | 0 | 0 |
| `apps/zcode-cli/packages/core/src/workflow/scheduler` | 9 | 8 | 1 | 1 |
| `apps/zcode-cli/packages/core/tests` | 11 | 2 | 9 | 0 |
| `apps/zcode-cli/packages/debug` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/debug/scripts` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/debug/server` | 6 | 0 | 6 | 6 |
| `apps/zcode-cli/packages/debug/src` | 4 | 0 | 4 | 4 |
| `apps/zcode-cli/packages/dynamic-workflow-runtime/src` | 6 | 5 | 1 | 1 |
| `apps/zcode-cli/packages/dynamic-workflow-runtime/tests` | 2 | 2 | 0 | 0 |
| `apps/zcode-cli/packages/dynamic-workflow/src` | 2 | 1 | 1 | 1 |
| `apps/zcode-cli/packages/dynamic-workflow/src/analysis` | 57 | 25 | 32 | 32 |
| `apps/zcode-cli/packages/dynamic-workflow/src/compiler` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/dynamic-workflow/src/engine` | 32 | 31 | 1 | 1 |
| `apps/zcode-cli/packages/dynamic-workflow/src/facade` | 8 | 7 | 1 | 1 |
| `apps/zcode-cli/packages/dynamic-workflow/src/lowering` | 3 | 2 | 1 | 1 |
| `apps/zcode-cli/packages/dynamic-workflow/src/schema` | 7 | 6 | 1 | 1 |
| `apps/zcode-cli/packages/dynamic-workflow/src/testing` | 10 | 7 | 3 | 3 |
| `apps/zcode-cli/packages/dynamic-workflow/tests/engine` | 1 | 1 | 0 | 0 |
| `apps/zcode-cli/packages/dynamic-workflow/tests/graphs` | 258 | 1 | 257 | 0 |
| `apps/zcode-cli/packages/dynamic-workflow/tests/helpers` | 2 | 1 | 1 | 0 |
| `apps/zcode-cli/packages/dynamic-workflow/tests/lowering` | 10 | 0 | 10 | 0 |
| `apps/zcode-cli/packages/dynamic-workflow/tests/schema-errors` | 13 | 0 | 13 | 0 |
| `apps/zcode-cli/packages/dynamic-workflow/tests/schemas` | 7 | 0 | 7 | 0 |
| `apps/zcode-cli/packages/dynamic-workflow/tests/smoke` | 2 | 2 | 0 | 0 |
| `apps/zcode-cli/packages/dynamic-workflow/tests/workflows` | 12 | 2 | 10 | 0 |
| `apps/zcode-cli/packages/i18n/src` | 3 | 1 | 2 | 2 |
| `apps/zcode-cli/packages/i18n/src/locales` | 2 | 0 | 2 | 2 |
| `apps/zcode-cli/packages/ios-simulator-plugin/src/lib` | 3 | 0 | 3 | 3 |
| `apps/zcode-cli/packages/ios-simulator-plugin/src/mcp` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/ios-simulator-plugin/src/providers` | 7 | 0 | 7 | 7 |
| `apps/zcode-cli/packages/node-repl-host/dist-types` | 8 | 1 | 7 | 0 |
| `apps/zcode-cli/packages/node-repl-host/src` | 8 | 5 | 3 | 3 |
| `apps/zcode-cli/packages/office-runtime` | 5 | 1 | 4 | 4 |
| `apps/zcode-cli/packages/office-runtime/src` | 5 | 0 | 5 | 5 |
| `apps/zcode-cli/packages/office-runtime/src/adapters` | 5 | 0 | 5 | 5 |
| `apps/zcode-cli/packages/office-runtime/src/adapters/parse` | 6 | 0 | 6 | 6 |
| `apps/zcode-cli/packages/office-runtime/src/app` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/office-runtime/src/domain` | 4 | 1 | 3 | 3 |
| `apps/zcode-cli/packages/office-runtime/ui` | 12 | 3 | 9 | 9 |
| `apps/zcode-cli/packages/office-runtime/ui/shell` | 10 | 1 | 9 | 9 |
| `apps/zcode-cli/packages/office-runtime/ui/viewers` | 7 | 0 | 7 | 7 |
| `apps/zcode-cli/packages/shared-types/src` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/superpowers-plugin/skills/systematic-debugging` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/swift-bridge/src` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/telemetry/src` | 11 | 3 | 8 | 8 |
| `apps/zcode-cli/packages/telemetry/src/request-security-edition` | 1 | 0 | 1 | 1 |
| `apps/zcode-cli/packages/tui/src` | 85 | 9 | 76 | 76 |
| `apps/zcode-cli/packages/tui/src/theme` | 6 | 0 | 6 | 6 |
| `apps/zcode-cli/tools/prompt-trajectory/src` | 12 | 1 | 11 | 11 |

## 三、本批未注清单（按目录，供分批补齐）

### `apps/dev-docs`（2）

- `apps/dev-docs/vite.config.ts`（247 行，中文注释 0 行）
- `apps/dev-docs/vitest.config.ts`（14 行，中文注释 0 行）

### `apps/dev-docs/src`（3）

- `apps/dev-docs/src/App.tsx`（1605 行，中文注释 2 行）
- `apps/dev-docs/src/main.tsx`（10 行，中文注释 0 行）
- `apps/dev-docs/src/vite-env.d.ts`（8 行，中文注释 0 行）

### `apps/dev-docs/src/capability-map`（12）

- `apps/dev-docs/src/capability-map/CapabilityMapDetail.tsx`（242 行，中文注释 0 行）
- `apps/dev-docs/src/capability-map/CapabilityMapFlowElements.tsx`（232 行，中文注释 1 行）
- `apps/dev-docs/src/capability-map/capabilityMapGeometry.ts`（18 行，中文注释 2 行）
- `apps/dev-docs/src/capability-map/CapabilityMapGraph.tsx`（70 行，中文注释 1 行）
- `apps/dev-docs/src/capability-map/capabilityMapGroupOrder.ts`（128 行，中文注释 0 行）
- `apps/dev-docs/src/capability-map/capabilityMapLayout.ts`（344 行，中文注释 0 行）
- `apps/dev-docs/src/capability-map/capabilityMapSystemPlacement.ts`（60 行，中文注释 0 行）
- `apps/dev-docs/src/capability-map/CapabilityMapToolbar.tsx`（99 行，中文注释 0 行）
- `apps/dev-docs/src/capability-map/capabilityMapTypes.ts`（158 行，中文注释 0 行）
- `apps/dev-docs/src/capability-map/CapabilityMapView.tsx`（328 行，中文注释 2 行）
- `apps/dev-docs/src/capability-map/useCapabilityMapHighlight.ts`（61 行，中文注释 0 行）
- `apps/dev-docs/src/capability-map/useCapabilityMapLayout.ts`（30 行，中文注释 0 行）

### `apps/dev-docs/src/data`（4）

- `apps/dev-docs/src/data/featureBoundaryGraph.ts`（152 行，中文注释 0 行）
- `apps/dev-docs/src/data/featureBoundaryGraphSource.ts`（98 行，中文注释 0 行）
- `apps/dev-docs/src/data/productCapabilityMap.ts`（775 行，中文注释 2 行）
- `apps/dev-docs/src/data/protocolDocs.ts`（1283 行，中文注释 1 行）

### `apps/dev-docs/src/feature-boundary-graph`（2）

- `apps/dev-docs/src/feature-boundary-graph/featureBoundaryGraphLayout.ts`（81 行，中文注释 0 行）
- `apps/dev-docs/src/feature-boundary-graph/FeatureBoundaryGraphView.tsx`（616 行，中文注释 1 行）

### `apps/zcode-cli`（1）

- `apps/zcode-cli/vitest.config.ts`（13 行，中文注释 1 行）

### `apps/zcode-cli/.agents/skills/opentui`（1）

- `apps/zcode-cli/.agents/skills/opentui/config.ts`（22 行，中文注释 0 行）

### `apps/zcode-cli/packages/adapters/src`（1）

- `apps/zcode-cli/packages/adapters/src/index.ts`（21 行，中文注释 0 行）

### `apps/zcode-cli/packages/adapters/src/auth`（1）

- `apps/zcode-cli/packages/adapters/src/auth/index.ts`（7 行，中文注释 0 行）

### `apps/zcode-cli/packages/adapters/src/conversation-recording`（1）

- `apps/zcode-cli/packages/adapters/src/conversation-recording/index.ts`（3 行，中文注释 0 行）

### `apps/zcode-cli/packages/adapters/src/exec`（2）

- `apps/zcode-cli/packages/adapters/src/exec/index.ts`（11 行，中文注释 0 行）
- `apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter.ts`（20 行，中文注释 7 行）

### `apps/zcode-cli/packages/adapters/src/model`（1）

- `apps/zcode-cli/packages/adapters/src/model/index.ts`（14 行，中文注释 0 行）

### `apps/zcode-cli/packages/adapters/src/provider`（1）

- `apps/zcode-cli/packages/adapters/src/provider/index.ts`（2 行，中文注释 0 行）

### `apps/zcode-cli/packages/adapters/src/storage`（1）

- `apps/zcode-cli/packages/adapters/src/storage/session-store.ts`（38 行，中文注释 3 行）

### `apps/zcode-cli/packages/adapters/src/storage/session-store`（2）

- `apps/zcode-cli/packages/adapters/src/storage/session-store/json.ts`（18 行，中文注释 7 行）
- `apps/zcode-cli/packages/adapters/src/storage/session-store/paths.ts`（16 行，中文注释 6 行）

### `apps/zcode-cli/packages/adapters/src/tools`（1）

- `apps/zcode-cli/packages/adapters/src/tools/index.ts`（4 行，中文注释 0 行）

### `apps/zcode-cli/packages/android-emulator-plugin/src/lib`（3）

- `apps/zcode-cli/packages/android-emulator-plugin/src/lib/path.ts`（22 行，中文注释 0 行）
- `apps/zcode-cli/packages/android-emulator-plugin/src/lib/result.ts`（27 行，中文注释 0 行）
- `apps/zcode-cli/packages/android-emulator-plugin/src/lib/run.ts`（124 行，中文注释 0 行）

### `apps/zcode-cli/packages/android-emulator-plugin/src/mcp`（1）

- `apps/zcode-cli/packages/android-emulator-plugin/src/mcp/server.ts`（369 行，中文注释 0 行）

### `apps/zcode-cli/packages/android-emulator-plugin/src/providers`（12）

- `apps/zcode-cli/packages/android-emulator-plugin/src/providers/app.ts`（71 行，中文注释 0 行）
- `apps/zcode-cli/packages/android-emulator-plugin/src/providers/avd.ts`（220 行，中文注释 0 行）
- `apps/zcode-cli/packages/android-emulator-plugin/src/providers/build.ts`（162 行，中文注释 0 行）
- `apps/zcode-cli/packages/android-emulator-plugin/src/providers/config.ts`（38 行，中文注释 0 行）
- `apps/zcode-cli/packages/android-emulator-plugin/src/providers/device.ts`（103 行，中文注释 0 行）
- `apps/zcode-cli/packages/android-emulator-plugin/src/providers/logs.ts`（45 行，中文注释 0 行）
- `apps/zcode-cli/packages/android-emulator-plugin/src/providers/preflight.ts`（152 行，中文注释 0 行）
- `apps/zcode-cli/packages/android-emulator-plugin/src/providers/project-template.ts`（234 行，中文注释 0 行）
- `apps/zcode-cli/packages/android-emulator-plugin/src/providers/project.ts`（257 行，中文注释 0 行）
- `apps/zcode-cli/packages/android-emulator-plugin/src/providers/screenshot.ts`（87 行，中文注释 0 行）
- `apps/zcode-cli/packages/android-emulator-plugin/src/providers/sdk.ts`（203 行，中文注释 0 行）
- `apps/zcode-cli/packages/android-emulator-plugin/src/providers/ui.ts`（207 行，中文注释 0 行）

### `apps/zcode-cli/packages/browser-use-plugin/src`（1）

- `apps/zcode-cli/packages/browser-use-plugin/src/browser-client.ts`（17 行，中文注释 2 行）

### `apps/zcode-cli/packages/cli/src`（39）

- `apps/zcode-cli/packages/cli/src/bootstrap-loader.ts`（8 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/cli-types.ts`（145 行，中文注释 2 行）
- `apps/zcode-cli/packages/cli/src/clipboard-image.ts`（257 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/clipboard-text.ts`（148 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center-custom.ts`（104 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center.ts`（32 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/commands-command.ts`（242 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/custom-command-expand.ts`（109 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/cwd.ts`（34 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/env.ts`（139 行，中文注释 4 行）
- `apps/zcode-cli/packages/cli/src/headless-browser.ts`（20 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/help.ts`（9 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/hooks-trust-command.ts`（178 行，中文注释 1 行）
- `apps/zcode-cli/packages/cli/src/index.ts`（2 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/locale.ts`（25 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/login-command.ts`（154 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/plugins-command.ts`（400 行，中文注释 3 行）
- `apps/zcode-cli/packages/cli/src/plugins-marketplace-command.ts`（101 行，中文注释 1 行）
- `apps/zcode-cli/packages/cli/src/process-name.ts`（12 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/protocol-console.ts`（20 行，中文注释 4 行）
- `apps/zcode-cli/packages/cli/src/protocol-stderr.ts`（35 行，中文注释 3 行）
- `apps/zcode-cli/packages/cli/src/resume.ts`（30 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/runtime-warnings.ts`（132 行，中文注释 1 行）
- `apps/zcode-cli/packages/cli/src/sea-playwright-runtime.ts`（137 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/sea-runtime-tools.ts`（289 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/shutdown.ts`（141 行，中文注释 7 行）
- `apps/zcode-cli/packages/cli/src/skills-command.ts`（248 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/tui-auth.ts`（90 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/tui-command-data.ts`（80 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/tui-command-state.ts`（56 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/tui-command.ts`（128 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/tui-login-state.ts`（17 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/tui-prompt-handler-queries.ts`（78 行，中文注释 5 行）
- `apps/zcode-cli/packages/cli/src/tui-runtime-loader.ts`（143 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/tui-startup-locale.ts`（39 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/tui-stderr.ts`（91 行，中文注释 1 行）
- `apps/zcode-cli/packages/cli/src/tui-submit-metadata.ts`（20 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/tui-workspace-git.ts`（92 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/tui-workspace-paths.ts`（134 行，中文注释 0 行）

### `apps/zcode-cli/packages/cli/src/argument-parsing`（1）

- `apps/zcode-cli/packages/cli/src/argument-parsing/module.ts`（10 行，中文注释 2 行）

### `apps/zcode-cli/packages/cli/src/command-center`（11）

- `apps/zcode-cli/packages/cli/src/command-center/create.ts`（402 行，中文注释 7 行）
- `apps/zcode-cli/packages/cli/src/command-center/effort-options.ts`（27 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center/formatters.ts`（16 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center/history.ts`（24 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center/login-flow.ts`（159 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center/metadata.ts`（22 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center/modes.ts`（18 行，中文注释 1 行）
- `apps/zcode-cli/packages/cli/src/command-center/selections.ts`（96 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center/slash-command-help.ts`（4 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center/slash-command-types.ts`（128 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center/utils.ts`（23 行，中文注释 0 行）

### `apps/zcode-cli/packages/cli/src/command-center/handlers`（10）

- `apps/zcode-cli/packages/cli/src/command-center/handlers/custom.ts`（17 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center/handlers/effort.ts`（91 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center/handlers/expert.ts`（134 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center/handlers/goal.ts`（142 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center/handlers/locale.ts`（84 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center/handlers/mcp.ts`（101 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center/handlers/mode.ts`（40 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center/handlers/model.ts`（112 行，中文注释 0 行）
- `apps/zcode-cli/packages/cli/src/command-center/handlers/plugins.ts`（206 行，中文注释 1 行）
- `apps/zcode-cli/packages/cli/src/command-center/handlers/skill.ts`（55 行，中文注释 0 行）

### `apps/zcode-cli/packages/cli/src/internal-search`（1）

- `apps/zcode-cli/packages/cli/src/internal-search/embedded-search-cli.ts`（338 行，中文注释 7 行）

### `apps/zcode-cli/packages/contracts/src/capabilities`（1）

- `apps/zcode-cli/packages/contracts/src/capabilities/index.ts`（8 行，中文注释 6 行）

### `apps/zcode-cli/packages/contracts/src/events`（1）

- `apps/zcode-cli/packages/contracts/src/events/index.ts`（6 行，中文注释 0 行）

### `apps/zcode-cli/packages/contracts/src/interfaces`（1）

- `apps/zcode-cli/packages/contracts/src/interfaces/index.ts`（28 行，中文注释 2 行）

### `apps/zcode-cli/packages/contracts/src/model`（1）

- `apps/zcode-cli/packages/contracts/src/model/content-protection.ts`（24 行，中文注释 7 行）

### `apps/zcode-cli/packages/contracts/src/path`（1）

- `apps/zcode-cli/packages/contracts/src/path/index.ts`（1 行，中文注释 0 行）

### `apps/zcode-cli/packages/contracts/src/time`（1）

- `apps/zcode-cli/packages/contracts/src/time/local-date.ts`（16 行，中文注释 6 行）

### `apps/zcode-cli/packages/core/src`（3）

- `apps/zcode-cli/packages/core/src/environment.ts`（14 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/output.ts`（21 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/runtime.ts`（40 行，中文注释 0 行）

### `apps/zcode-cli/packages/core/src/agent`（8）

- `apps/zcode-cli/packages/core/src/agent/compact-session.ts`（87 行，中文注释 3 行）
- `apps/zcode-cli/packages/core/src/agent/file-part-hydration.ts`（185 行，中文注释 6 行）
- `apps/zcode-cli/packages/core/src/agent/index.ts`（18 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/agent/message-history-usage.ts`（64 行，中文注释 2 行）
- `apps/zcode-cli/packages/core/src/agent/read-file-state-hydrator.ts`（200 行，中文注释 7 行）
- `apps/zcode-cli/packages/core/src/agent/tool-part-order.ts`（14 行，中文注释 4 行）
- `apps/zcode-cli/packages/core/src/agent/tool-search-hydration.ts`（29 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/agent/turn-machine.ts`（344 行，中文注释 0 行）

### `apps/zcode-cli/packages/core/src/browser-client`（3）

- `apps/zcode-cli/packages/core/src/browser-client/index.ts`（72 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/browser-client/playwright.ts`（789 行，中文注释 5 行）
- `apps/zcode-cli/packages/core/src/browser-client/result.ts`（54 行，中文注释 0 行）

### `apps/zcode-cli/packages/core/src/compact`（6）

- `apps/zcode-cli/packages/core/src/compact/index.ts`（53 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/compact/manual.ts`（166 行，中文注释 7 行）
- `apps/zcode-cli/packages/core/src/compact/microcompact.ts`（291 行，中文注释 1 行）
- `apps/zcode-cli/packages/core/src/compact/policy.ts`（160 行，中文注释 5 行）
- `apps/zcode-cli/packages/core/src/compact/prompt.ts`（165 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/compact/rounds.ts`（35 行，中文注释 0 行）

### `apps/zcode-cli/packages/core/src/context`（1）

- `apps/zcode-cli/packages/core/src/context/index.ts`（25 行，中文注释 3 行）

### `apps/zcode-cli/packages/core/src/embedded-search`（2）

- `apps/zcode-cli/packages/core/src/embedded-search/capability.ts`（54 行，中文注释 2 行）
- `apps/zcode-cli/packages/core/src/embedded-search/shell.ts`（15 行，中文注释 2 行）

### `apps/zcode-cli/packages/core/src/mcp`（1）

- `apps/zcode-cli/packages/core/src/mcp/name.ts`（35 行，中文注释 0 行）

### `apps/zcode-cli/packages/core/src/model`（1）

- `apps/zcode-cli/packages/core/src/model/auxiliary-model-options.ts`（14 行，中文注释 2 行）

### `apps/zcode-cli/packages/core/src/permission`（4）

- `apps/zcode-cli/packages/core/src/permission/broker.ts`（173 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/permission/index.ts`（6 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/permission/plan-mode-policy.ts`（43 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/permission/rule-matching.ts`（22 行，中文注释 0 行）

### `apps/zcode-cli/packages/core/src/plugin-reference`（1）

- `apps/zcode-cli/packages/core/src/plugin-reference/index.ts`（25 行，中文注释 1 行）

### `apps/zcode-cli/packages/core/src/repl`（1）

- `apps/zcode-cli/packages/core/src/repl/browser-turn-state.ts`（80 行，中文注释 0 行）

### `apps/zcode-cli/packages/core/src/runtime-task`（2）

- `apps/zcode-cli/packages/core/src/runtime-task/index.ts`（2 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/runtime-task/notification-policy.ts`（18 行，中文注释 0 行）

### `apps/zcode-cli/packages/core/src/runtime/methods`（3）

- `apps/zcode-cli/packages/core/src/runtime/methods/compact-log-context.ts`（35 行，中文注释 7 行）
- `apps/zcode-cli/packages/core/src/runtime/methods/projection-anchor.ts`（45 行，中文注释 7 行）
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-step-finish.ts`（57 行，中文注释 6 行）

### `apps/zcode-cli/packages/core/src/session-context`（5）

- `apps/zcode-cli/packages/core/src/session-context/parts.ts`（104 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/session-context/read-session-context.ts`（382 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/session-context/references.ts`（25 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/session-context/topic-resource.ts`（150 行，中文注释 2 行）
- `apps/zcode-cli/packages/core/src/session-context/utils.ts`（13 行，中文注释 0 行）

### `apps/zcode-cli/packages/core/src/subagent`（20）

- `apps/zcode-cli/packages/core/src/subagent/borrowed-mcp-port.ts`（71 行，中文注释 2 行）
- `apps/zcode-cli/packages/core/src/subagent/completion-notification.ts`（60 行，中文注释 2 行）
- `apps/zcode-cli/packages/core/src/subagent/computer-use-policy.ts`（117 行，中文注释 2 行）
- `apps/zcode-cli/packages/core/src/subagent/context-builder.ts`（201 行，中文注释 4 行）
- `apps/zcode-cli/packages/core/src/subagent/coordinator-response.ts`（52 行，中文注释 1 行）
- `apps/zcode-cli/packages/core/src/subagent/explore-tools.ts`（68 行，中文注释 3 行）
- `apps/zcode-cli/packages/core/src/subagent/explore.ts`（72 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/subagent/general-purpose.ts`（24 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/subagent/index.ts`（14 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/subagent/interaction-origin.ts`（33 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/subagent/listing.ts`（70 行，中文注释 2 行）
- `apps/zcode-cli/packages/core/src/subagent/mcp-config.ts`（99 行，中文注释 3 行）
- `apps/zcode-cli/packages/core/src/subagent/message-steering.ts`（59 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/subagent/persistent-memory-prompt.ts`（169 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/subagent/persistent-memory.ts`（110 行，中文注释 1 行）
- `apps/zcode-cli/packages/core/src/subagent/profile.ts`（117 行，中文注释 2 行）
- `apps/zcode-cli/packages/core/src/subagent/runtime-task-registry.ts`（1 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/subagent/system-prompt.ts`（40 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/subagent/tool-event-mirror.ts`（186 行，中文注释 5 行）
- `apps/zcode-cli/packages/core/src/subagent/tool-policy.ts`（31 行，中文注释 2 行）

### `apps/zcode-cli/packages/core/src/system-reminder`（3）

- `apps/zcode-cli/packages/core/src/system-reminder/incoming-message.ts`（35 行，中文注释 0 行）
- `apps/zcode-cli/packages/core/src/system-reminder/prompt-attachment.ts`（170 行，中文注释 1 行）
- `apps/zcode-cli/packages/core/src/system-reminder/source.ts`（262 行，中文注释 6 行）

### `apps/zcode-cli/packages/core/src/tool`（2）

- `apps/zcode-cli/packages/core/src/tool/executor.ts`（5 行，中文注释 3 行）
- `apps/zcode-cli/packages/core/src/tool/index.ts`（12 行，中文注释 3 行）

### `apps/zcode-cli/packages/core/src/tool/handlers`（14）

- `apps/zcode-cli/packages/core/src/tool/handlers/bash-background-policy.ts`（17 行，中文注释 5 行）
- `apps/zcode-cli/packages/core/src/tool/handlers/bash-gh-rate-limit.ts`（26 行，中文注释 7 行）
- `apps/zcode-cli/packages/core/src/tool/handlers/bash-prompt.ts`（33 行，中文注释 7 行）
- `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-commands.ts`（32 行，中文注释 5 行）
- `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-flags-git.ts`（252 行，中文注释 6 行）
- `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-flags-process.ts`（332 行，中文注释 6 行）
- `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-flags-text.ts`（372 行，中文注释 7 行）
- `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-flags.ts`（11 行，中文注释 4 行）
- `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-git-subcommands-history.ts`（237 行，中文注释 6 行）
- `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-multiword-gh.ts`（354 行，中文注释 6 行）
- `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-types.ts`（20 行，中文注释 3 行）
- `apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy.ts`（12 行，中文注释 4 行）
- `apps/zcode-cli/packages/core/src/tool/handlers/eval-workflow-snippet-description.ts`（16 行，中文注释 6 行）
- `apps/zcode-cli/packages/core/src/tool/handlers/workflow-description.ts`（12 行，中文注释 7 行）

### `apps/zcode-cli/packages/core/src/tool/handlers/generated`（1）

- `apps/zcode-cli/packages/core/src/tool/handlers/generated/bash-command-registry.ts`（9 行，中文注释 1 行）

### `apps/zcode-cli/packages/core/src/tool/handlers/guarded`（2）

- `apps/zcode-cli/packages/core/src/tool/handlers/guarded/command.ts`（130 行，中文注释 5 行）
- `apps/zcode-cli/packages/core/src/tool/handlers/guarded/wrappers.ts`（35 行，中文注释 1 行）

### `apps/zcode-cli/packages/core/src/tool/handlers/saved-workflows`（1）

- `apps/zcode-cli/packages/core/src/tool/handlers/saved-workflows/index.ts`（33 行，中文注释 1 行）

### `apps/zcode-cli/packages/core/src/tool/workflow-entrypoints`（1）

- `apps/zcode-cli/packages/core/src/tool/workflow-entrypoints/module.ts`（20 行，中文注释 7 行）

### `apps/zcode-cli/packages/core/src/workflow`（1）

- `apps/zcode-cli/packages/core/src/workflow/expert.ts`（39 行，中文注释 6 行）

### `apps/zcode-cli/packages/core/src/workflow/scheduler`（1）

- `apps/zcode-cli/packages/core/src/workflow/scheduler/collection-runtime.ts`（16 行，中文注释 4 行）

### `apps/zcode-cli/packages/debug`（1）

- `apps/zcode-cli/packages/debug/vite.config.ts`（17 行，中文注释 0 行）

### `apps/zcode-cli/packages/debug/scripts`（1）

- `apps/zcode-cli/packages/debug/scripts/dev.ts`（42 行，中文注释 0 行）

### `apps/zcode-cli/packages/debug/server`（6）

- `apps/zcode-cli/packages/debug/server/analyzer.ts`（1504 行，中文注释 0 行）
- `apps/zcode-cli/packages/debug/server/index.ts`（199 行，中文注释 0 行）
- `apps/zcode-cli/packages/debug/server/network-capture.ts`（427 行，中文注释 0 行）
- `apps/zcode-cli/packages/debug/server/observation-events.ts`（260 行，中文注释 0 行）
- `apps/zcode-cli/packages/debug/server/sources.ts`（293 行，中文注释 0 行）
- `apps/zcode-cli/packages/debug/server/types.ts`（100 行，中文注释 0 行）

### `apps/zcode-cli/packages/debug/src`（4）

- `apps/zcode-cli/packages/debug/src/App.tsx`（1600 行，中文注释 0 行）
- `apps/zcode-cli/packages/debug/src/gantt-style.ts`（8 行，中文注释 0 行）
- `apps/zcode-cli/packages/debug/src/main.tsx`（10 行，中文注释 0 行）
- `apps/zcode-cli/packages/debug/src/shared.ts`（321 行，中文注释 0 行）

### `apps/zcode-cli/packages/dynamic-workflow-runtime/src`（1）

- `apps/zcode-cli/packages/dynamic-workflow-runtime/src/index.ts`（42 行，中文注释 5 行）

### `apps/zcode-cli/packages/dynamic-workflow/src`（1）

- `apps/zcode-cli/packages/dynamic-workflow/src/projections.ts`（110 行，中文注释 7 行）

### `apps/zcode-cli/packages/dynamic-workflow/src/analysis`（32）

- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/actor-graph.ts`（143 行，中文注释 0 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/array-methods.ts`（150 行，中文注释 0 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/artifact-types.ts`（156 行，中文注释 0 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/assign.ts`（288 行，中文注释 0 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/callbacks.ts`（203 行，中文注释 0 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/calls.ts`（581 行，中文注释 5 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/causality-graph-lanes.ts`（171 行，中文注释 6 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/causality-order-functions.ts`（133 行，中文注释 3 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/causality-order-loops.ts`（169 行，中文注释 4 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/causality-order-settle.ts`（290 行，中文注释 4 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/causality-order-strands.ts`（212 行，中文注释 5 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/causality-order-types.ts`（189 行，中文注释 4 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/causality-order-walk.ts`（313 行，中文注释 4 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/classes.ts`（260 行，中文注释 0 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/constants.ts`（51 行，中文注释 6 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/control-flow.ts`（128 行，中文注释 0 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/core.ts`（362 行，中文注释 7 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/domain.ts`（640 行，中文注释 4 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/facade-misuse.ts`（362 行，中文注释 3 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/flow-graph.ts`（552 行，中文注释 0 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/flow-phase.ts`（119 行，中文注释 0 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/flow-strands.ts`（78 行，中文注释 0 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/flow-tree.ts`（64 行，中文注释 0 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/graph.ts`（216 行，中文注释 1 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/heap-ops.ts`（73 行，中文注释 0 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/interpret.ts`（226 行，中文注释 3 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/literals.ts`（130 行，中文注释 0 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/mermaid.ts`（485 行，中文注释 1 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/patterns.ts`（114 行，中文注释 0 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/promise-ops.ts`（144 行，中文注释 0 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/relays.ts`（87 行，中文注释 0 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/analysis/taint.ts`（655 行，中文注释 0 行）

### `apps/zcode-cli/packages/dynamic-workflow/src/compiler`（1）

- `apps/zcode-cli/packages/dynamic-workflow/src/compiler/compile.ts`（217 行，中文注释 6 行）

### `apps/zcode-cli/packages/dynamic-workflow/src/engine`（1）

- `apps/zcode-cli/packages/dynamic-workflow/src/engine/index.ts`（91 行，中文注释 1 行）

### `apps/zcode-cli/packages/dynamic-workflow/src/facade`（1）

- `apps/zcode-cli/packages/dynamic-workflow/src/facade/dts-model.ts`（18 行，中文注释 6 行）

### `apps/zcode-cli/packages/dynamic-workflow/src/lowering`（1）

- `apps/zcode-cli/packages/dynamic-workflow/src/lowering/index.ts`（7 行，中文注释 0 行）

### `apps/zcode-cli/packages/dynamic-workflow/src/schema`（1）

- `apps/zcode-cli/packages/dynamic-workflow/src/schema/serialize.ts`（23 行，中文注释 3 行）

### `apps/zcode-cli/packages/dynamic-workflow/src/testing`（3）

- `apps/zcode-cli/packages/dynamic-workflow/src/testing/index.ts`（6 行，中文注释 2 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/testing/journal-contract-isolation.ts`（50 行，中文注释 4 行）
- `apps/zcode-cli/packages/dynamic-workflow/src/testing/journal-contract-script.ts`（92 行，中文注释 6 行）

### `apps/zcode-cli/packages/i18n/src`（2）

- `apps/zcode-cli/packages/i18n/src/index.ts`（32 行，中文注释 0 行）
- `apps/zcode-cli/packages/i18n/src/locale.ts`（80 行，中文注释 0 行）

### `apps/zcode-cli/packages/i18n/src/locales`（2）

- `apps/zcode-cli/packages/i18n/src/locales/en-US.ts`（367 行，中文注释 0 行）
- `apps/zcode-cli/packages/i18n/src/locales/zh-CN.ts`（364 行，中文注释 0 行）

### `apps/zcode-cli/packages/ios-simulator-plugin/src/lib`（3）

- `apps/zcode-cli/packages/ios-simulator-plugin/src/lib/path.ts`（22 行，中文注释 0 行）
- `apps/zcode-cli/packages/ios-simulator-plugin/src/lib/result.ts`（27 行，中文注释 0 行）
- `apps/zcode-cli/packages/ios-simulator-plugin/src/lib/run.ts`（100 行，中文注释 0 行）

### `apps/zcode-cli/packages/ios-simulator-plugin/src/mcp`（1）

- `apps/zcode-cli/packages/ios-simulator-plugin/src/mcp/server.ts`（376 行，中文注释 0 行）

### `apps/zcode-cli/packages/ios-simulator-plugin/src/providers`（7）

- `apps/zcode-cli/packages/ios-simulator-plugin/src/providers/build.ts`（135 行，中文注释 0 行）
- `apps/zcode-cli/packages/ios-simulator-plugin/src/providers/logs.ts`（35 行，中文注释 0 行）
- `apps/zcode-cli/packages/ios-simulator-plugin/src/providers/preflight.ts`（76 行，中文注释 0 行）
- `apps/zcode-cli/packages/ios-simulator-plugin/src/providers/project.ts`（304 行，中文注释 0 行）
- `apps/zcode-cli/packages/ios-simulator-plugin/src/providers/screenshot.ts`（40 行，中文注释 0 行）
- `apps/zcode-cli/packages/ios-simulator-plugin/src/providers/sim.ts`（114 行，中文注释 0 行）
- `apps/zcode-cli/packages/ios-simulator-plugin/src/providers/ui.ts`（103 行，中文注释 0 行）

### `apps/zcode-cli/packages/node-repl-host/src`（3）

- `apps/zcode-cli/packages/node-repl-host/src/browser-bridge.ts`（248 行，中文注释 1 行）
- `apps/zcode-cli/packages/node-repl-host/src/cua-broker.ts`（181 行，中文注释 2 行）
- `apps/zcode-cli/packages/node-repl-host/src/runtime-bridge.ts`（20 行，中文注释 0 行）

### `apps/zcode-cli/packages/office-runtime`（4）

- `apps/zcode-cli/packages/office-runtime/contract.example.ts`（11 行，中文注释 1 行）
- `apps/zcode-cli/packages/office-runtime/index.ts`（2 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/module.ts`（10 行，中文注释 2 行）
- `apps/zcode-cli/packages/office-runtime/vitest.config.ts`（8 行，中文注释 0 行）

### `apps/zcode-cli/packages/office-runtime/src`（5）

- `apps/zcode-cli/packages/office-runtime/src/contract.ts`（141 行，中文注释 1 行）
- `apps/zcode-cli/packages/office-runtime/src/kinds.ts`（6 行，中文注释 1 行）
- `apps/zcode-cli/packages/office-runtime/src/profile.ts`（22 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/src/types.d.ts`（2 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/src/wording.ts`（88 行，中文注释 0 行）

### `apps/zcode-cli/packages/office-runtime/src/adapters`（5）

- `apps/zcode-cli/packages/office-runtime/src/adapters/assets.ts`（10 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/src/adapters/files.ts`（292 行，中文注释 6 行）
- `apps/zcode-cli/packages/office-runtime/src/adapters/main.ts`（53 行，中文注释 2 行）
- `apps/zcode-cli/packages/office-runtime/src/adapters/parsers.ts`（22 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/src/adapters/server.ts`（551 行，中文注释 0 行）

### `apps/zcode-cli/packages/office-runtime/src/adapters/parse`（6）

- `apps/zcode-cli/packages/office-runtime/src/adapters/parse/docx.ts`（267 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/src/adapters/parse/dommatrix.ts`（113 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/src/adapters/parse/ooxml.ts`（166 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/src/adapters/parse/pdf.ts`（139 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/src/adapters/parse/pptx.ts`（248 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/src/adapters/parse/xlsx.ts`（223 行，中文注释 0 行）

### `apps/zcode-cli/packages/office-runtime/src/app`（1）

- `apps/zcode-cli/packages/office-runtime/src/app/documents.ts`（257 行，中文注释 2 行）

### `apps/zcode-cli/packages/office-runtime/src/domain`（3）

- `apps/zcode-cli/packages/office-runtime/src/domain/anchor.ts`（195 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/src/domain/model.ts`（116 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/src/domain/text.ts`（35 行，中文注释 0 行）

### `apps/zcode-cli/packages/office-runtime/ui`（9）

- `apps/zcode-cli/packages/office-runtime/ui/assets.ts`（59 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/ui/bootstrap.ts`（23 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/ui/cjkFontRuntime.ts`（77 行，中文注释 1 行）
- `apps/zcode-cli/packages/office-runtime/ui/dom.ts`（295 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/ui/host.ts`（178 行，中文注释 1 行）
- `apps/zcode-cli/packages/office-runtime/ui/icons.tsx`（72 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/ui/main.tsx`（798 行，中文注释 1 行）
- `apps/zcode-cli/packages/office-runtime/ui/raster.ts`（192 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/ui/windowStorage.ts`（47 行，中文注释 2 行）

### `apps/zcode-cli/packages/office-runtime/ui/shell`（9）

- `apps/zcode-cli/packages/office-runtime/ui/shell/float.ts`（87 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/ui/shell/inline.tsx`（76 行，中文注释 2 行）
- `apps/zcode-cli/packages/office-runtime/ui/shell/menus.tsx`（93 行，中文注释 1 行）
- `apps/zcode-cli/packages/office-runtime/ui/shell/panes.tsx`（343 行，中文注释 2 行）
- `apps/zcode-cli/packages/office-runtime/ui/shell/parts.tsx`（571 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/ui/shell/state.ts`（78 行，中文注释 1 行）
- `apps/zcode-cli/packages/office-runtime/ui/shell/useCaptureView.ts`（47 行，中文注释 2 行）
- `apps/zcode-cli/packages/office-runtime/ui/shell/useOffscreenTargets.ts`（59 行，中文注释 2 行）
- `apps/zcode-cli/packages/office-runtime/ui/shell/useShellKeys.ts`（105 行，中文注释 2 行）

### `apps/zcode-cli/packages/office-runtime/ui/viewers`（7）

- `apps/zcode-cli/packages/office-runtime/ui/viewers/align.ts`（80 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/ui/viewers/DocxView.tsx`（440 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/ui/viewers/PdfView.tsx`（725 行，中文注释 1 行）
- `apps/zcode-cli/packages/office-runtime/ui/viewers/PptxView.tsx`（430 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/ui/viewers/registry.ts`（23 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/ui/viewers/types.ts`（98 行，中文注释 0 行）
- `apps/zcode-cli/packages/office-runtime/ui/viewers/XlsxView.tsx`（470 行，中文注释 0 行）

### `apps/zcode-cli/packages/shared-types/src`（1）

- `apps/zcode-cli/packages/shared-types/src/index.ts`（53 行，中文注释 0 行）

### `apps/zcode-cli/packages/superpowers-plugin/skills/systematic-debugging`（1）

- `apps/zcode-cli/packages/superpowers-plugin/skills/systematic-debugging/condition-based-waiting-example.ts`（158 行，中文注释 0 行）

### `apps/zcode-cli/packages/swift-bridge/src`（1）

- `apps/zcode-cli/packages/swift-bridge/src/index.ts`（20 行，中文注释 0 行）

### `apps/zcode-cli/packages/telemetry/src`（8）

- `apps/zcode-cli/packages/telemetry/src/agent-metrics.ts`（245 行，中文注释 2 行）
- `apps/zcode-cli/packages/telemetry/src/agent-trace-runtime.ts`（1687 行，中文注释 6 行）
- `apps/zcode-cli/packages/telemetry/src/agent-trace-support.ts`（423 行，中文注释 6 行）
- `apps/zcode-cli/packages/telemetry/src/compatibility-adapters.ts`（88 行，中文注释 2 行）
- `apps/zcode-cli/packages/telemetry/src/index.ts`（5 行，中文注释 0 行）
- `apps/zcode-cli/packages/telemetry/src/model-api-recorder.ts`（451 行，中文注释 6 行）
- `apps/zcode-cli/packages/telemetry/src/provider-endpoint.ts`（99 行，中文注释 0 行）
- `apps/zcode-cli/packages/telemetry/src/request-observation-target.ts`（6 行，中文注释 0 行）

### `apps/zcode-cli/packages/telemetry/src/request-security-edition`（1）

- `apps/zcode-cli/packages/telemetry/src/request-security-edition/index.ts`（6 行，中文注释 0 行）

### `apps/zcode-cli/packages/tui/src`（76）

- `apps/zcode-cli/packages/tui/src/app-approval-panel.tsx`（161 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-approval.ts`（181 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-clipboard-image.ts`（103 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-compact-timeline.ts`（189 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-components.tsx`（259 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-copy.ts`（89 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-effort-command.ts`（45 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-effort-suggestion-panel.tsx`（200 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-empty-transcript.tsx`（81 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-event-data.ts`（137 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-events.ts`（415 行，中文注释 1 行）
- `apps/zcode-cli/packages/tui/src/app-file-mention-panel.tsx`（101 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-file-mentions.ts`（306 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-input-history.ts`（144 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-input-pane.tsx`（258 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-input-status.tsx`（298 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-input.ts`（327 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-keyboard-helpers.ts`（136 行，中文注释 4 行）
- `apps/zcode-cli/packages/tui/src/app-keyboard-suggestions.ts`（114 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-keyboard.ts`（423 行，中文注释 2 行）
- `apps/zcode-cli/packages/tui/src/app-locale.ts`（3 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-markdown-theme.ts`（68 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-markdown.tsx`（68 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-mcp-status.ts`（60 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-mode-command.ts`（101 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-mode-suggestion-panel.tsx`（226 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-mode.ts`（62 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-model-command.ts`（71 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-model-ref.ts`（37 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-model-streaming.ts`（86 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-model-suggestion-panel.tsx`（227 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-model.ts`（246 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-modified-files.ts`（85 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-motion.tsx`（211 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-network-events.ts`（115 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-question-panel.tsx`（113 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-question-state.ts`（356 行，中文注释 2 行）
- `apps/zcode-cli/packages/tui/src/app-queued-inputs.tsx`（164 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-result.ts`（103 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-selection-keyboard.ts`（312 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-selection-panel.tsx`（275 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-selection-state.ts`（14 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-shiki-diff-view.tsx`（380 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-shiki-highlighter.ts`（150 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-sidebar-api.tsx`（166 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-sidebar-keyboard.ts`（57 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-sidebar-layout.ts`（129 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-sidebar-mcp.tsx`（141 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-sidebar-modified-files.tsx`（117 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-sidebar-section-header.tsx`（46 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-sidebar-shortcut.ts`（82 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-sidebar-subagents.tsx`（147 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-sidebar.tsx`（390 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-startup.tsx`（31 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-subagent-events.ts`（37 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-subagent-transcript.ts`（135 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-subagent-view.tsx`（97 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-subagents.ts`（210 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-submit-controller.ts`（94 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-submit-resolver.ts`（27 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-submit.ts`（310 行，中文注释 6 行）
- `apps/zcode-cli/packages/tui/src/app-terminal-width.ts`（94 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-theme-sync.ts`（15 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-thought-components.tsx`（85 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-tool-components.tsx`（133 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-tool-diff-display.ts`（141 行，中文注释 1 行）
- `apps/zcode-cli/packages/tui/src/app-tool-path-display.ts`（40 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-tool-transcript.ts`（407 行，中文注释 1 行）
- `apps/zcode-cli/packages/tui/src/app-transcript-components.tsx`（254 行，中文注释 4 行）
- `apps/zcode-cli/packages/tui/src/app-transcript-errors.ts`（18 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-transcript-stream.ts`（197 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/app-view.tsx`（337 行，中文注释 1 行）
- `apps/zcode-cli/packages/tui/src/app.tsx`（419 行，中文注释 1 行）
- `apps/zcode-cli/packages/tui/src/index.ts`（39 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/state.ts`（72 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/tui.tsx`（166 行，中文注释 2 行）

### `apps/zcode-cli/packages/tui/src/theme`（6）

- `apps/zcode-cli/packages/tui/src/theme/defaults.ts`（126 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/theme/index.ts`（19 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/theme/legacy-palette.ts`（51 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/theme/state.ts`（30 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/theme/terminal.ts`（71 行，中文注释 0 行）
- `apps/zcode-cli/packages/tui/src/theme/types.ts`（76 行，中文注释 0 行）

### `apps/zcode-cli/tools/prompt-trajectory/src`（11）

- `apps/zcode-cli/tools/prompt-trajectory/src/cli.ts`（180 行，中文注释 0 行）
- `apps/zcode-cli/tools/prompt-trajectory/src/derive.ts`（396 行，中文注释 3 行）
- `apps/zcode-cli/tools/prompt-trajectory/src/fixture.ts`（156 行，中文注释 0 行）
- `apps/zcode-cli/tools/prompt-trajectory/src/message-continuity.ts`（83 行，中文注释 3 行）
- `apps/zcode-cli/tools/prompt-trajectory/src/message-ledger.ts`（116 行，中文注释 0 行）
- `apps/zcode-cli/tools/prompt-trajectory/src/model-io.ts`（378 行，中文注释 0 行）
- `apps/zcode-cli/tools/prompt-trajectory/src/openai-provider-proxy.ts`（427 行，中文注释 0 行）
- `apps/zcode-cli/tools/prompt-trajectory/src/openai-response-assembler.ts`（212 行，中文注释 0 行）
- `apps/zcode-cli/tools/prompt-trajectory/src/record.ts`（373 行，中文注释 0 行）
- `apps/zcode-cli/tools/prompt-trajectory/src/testcases.ts`（216 行，中文注释 0 行）
- `apps/zcode-cli/tools/prompt-trajectory/src/types.ts`（48 行，中文注释 0 行）

## 四、不计入本批的未注文件（测试支撑 / 构建产物 / bootstrap 待办）

### `apps/zcode-cli/packages/adapters/tests`（3）

- `apps/zcode-cli/packages/adapters/tests/test-adapter-model.ts`
- `apps/zcode-cli/packages/adapters/tests/test-model-format.ts`
- `apps/zcode-cli/packages/adapters/tests/test-provider-config.ts`

### `apps/zcode-cli/packages/bootstrap/src`（8）

- `apps/zcode-cli/packages/bootstrap/src/auth-login-abort.ts`
- `apps/zcode-cli/packages/bootstrap/src/index.ts`
- `apps/zcode-cli/packages/bootstrap/src/log-retention.ts`
- `apps/zcode-cli/packages/bootstrap/src/sessions.ts`
- `apps/zcode-cli/packages/bootstrap/src/skill-command-overrides.ts`
- `apps/zcode-cli/packages/bootstrap/src/startup-logging.ts`
- `apps/zcode-cli/packages/bootstrap/src/telemetry-bootstrap.ts`
- `apps/zcode-cli/packages/bootstrap/src/tool-call-product-visibility.ts`

### `apps/zcode-cli/packages/bootstrap/src/app`（1）

- `apps/zcode-cli/packages/bootstrap/src/app/locale-selection.ts`

### `apps/zcode-cli/packages/bootstrap/src/conversation-recording`（2）

- `apps/zcode-cli/packages/bootstrap/src/conversation-recording/contract.example.ts`
- `apps/zcode-cli/packages/bootstrap/src/conversation-recording/module.ts`

### `apps/zcode-cli/packages/bootstrap/src/runtime-subagents`（1）

- `apps/zcode-cli/packages/bootstrap/src/runtime-subagents/module.ts`

### `apps/zcode-cli/packages/bootstrap/src/session-execution`（2）

- `apps/zcode-cli/packages/bootstrap/src/session-execution/index.ts`
- `apps/zcode-cli/packages/bootstrap/src/session-execution/module.ts`

### `apps/zcode-cli/packages/bootstrap/src/zcode-protocol`（11）

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-preferences.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mapper.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-execution.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-io-preferences.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/off-peak-tool-policy.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/permission-options.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/plugin-ui-surfaces.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/process-child-processes.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/protocol-mcp-config.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/runtime-cleanup.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace.ts`

### `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands`（1）

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/record-access.ts`

### `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui`（3）

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/module.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/samplingProtocol.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/sessionAccess.ts`

### `apps/zcode-cli/packages/bootstrap/tests/helpers`（4）

- `apps/zcode-cli/packages/bootstrap/tests/helpers/fake-zcode-app.ts`
- `apps/zcode-cli/packages/bootstrap/tests/helpers/pdf-provider-fixture.ts`
- `apps/zcode-cli/packages/bootstrap/tests/helpers/registry-backed-test-app.ts`
- `apps/zcode-cli/packages/bootstrap/tests/helpers/subagents.ts`

### `apps/zcode-cli/packages/cli/tests`（1）

- `apps/zcode-cli/packages/cli/tests/internal-search.node-test.ts`

### `apps/zcode-cli/packages/core/tests`（9）

- `apps/zcode-cli/packages/core/tests/memory-test-utils.ts`
- `apps/zcode-cli/packages/core/tests/runtime-output-token-continuation-test-helpers.ts`
- `apps/zcode-cli/packages/core/tests/subagent-profile-scenario.ts`
- `apps/zcode-cli/packages/core/tests/subagent-test-store.ts`
- `apps/zcode-cli/packages/core/tests/test-event-store.ts`
- `apps/zcode-cli/packages/core/tests/test-image-artifact-store.ts`
- `apps/zcode-cli/packages/core/tests/test-model-selection.ts`
- `apps/zcode-cli/packages/core/tests/test-runtime-model.ts`
- `apps/zcode-cli/packages/core/tests/tool-contract-assertions.ts`

### `apps/zcode-cli/packages/dynamic-workflow/tests/graphs`（257）

- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/actor-agent-to-workspace.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/actor-dead-code-after-return.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/actor-may-pick-inside-fanout.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/actor-nested-inline-fanout-family.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/actor-nonsingleton-lane-computed.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/actor-or-aggregation-and-context-dissolve.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/actor-relay-chain-connectivity.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/agent-array-indexed-selection.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/alias-write.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/all-catch.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/array-from-mapper.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/array-push-all.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/array-spread-shared.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/async-promise-allsettled-value.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/async-promise-custom-thenable.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/async-promise-double-await-mutate.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/async-promise-executor-launder.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/async-promise-executor-reject-param.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/async-promise-for-await-of.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/async-promise-join-in-ternary.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/async-promise-nested-join-destructure.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/async-promise-node-field-alias-await.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/async-promise-race-any.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/async-promise-reject-try-catch.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/async-promise-then-both-callbacks.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/async-promise-then-destructured-param.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/callback-array-from-phased.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/callback-dead-function-sweep.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/callback-multi-target-dispatch.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/callback-named-map-phased.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/callback-promise-executor.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/callback-then-in-phase.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/callback-through-param.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/chained-assign.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/circular-ref.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/class-extends-method.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/class-field-initializer-ask.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/class-field-method.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/class-getter-taint.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/class-static-block-ask.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/class-this-write-method.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/classes-2-class-accessors.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/classes-2-class-alias-ctor-effect.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/classes-2-class-expr-in-field.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/classes-2-computed-method-name.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/classes-2-cross-instance-conflation.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/classes-2-extends-mixin-call.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/classes-2-extracted-method-bare-call.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/classes-2-new-in-fanout.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/classes-2-param-property.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/classes-2-private-field.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/classes-2-static-method-static-field.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/classes-2-super-method-arg.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/classes-2-super-method-return.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/compound-assign-loop.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/compound-assign.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/computed-callee.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/computed-index.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/conditional-receiver-may-set.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/context-sharing.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-comma-alias-write.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-comma-incrementor.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-do-while-self-loop.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-for-await.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-forin-key-taint.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-forof-assign-form.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-if-no-else-skip.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-in-operator.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-labeled-break-nested.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-loop-condition-step.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-optional-calls.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-optional-chain-read.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-optional-fn-call.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-recursive-helper.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-return-in-fanout-callback.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-return-in-helper.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-shadowed-names.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-switch-fallthrough.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-throw-in-catch.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/control-flow-try-finally-return.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/curry.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/cyclic-nodes-through-fanout-map.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/default-param.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/destructure-alias.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/destructuring-assign.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/element-field-write.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-computed-elem-read-ask.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-computed-elem-write-key-taint.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-computed-key-ask.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-computed-method-name-obj.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-conditional-condition-ask.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-dedupe-exact-or.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-empty-join-into-ask.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-fanout-map-wrap-aggregate.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-fanout-ordinal-skip.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-join-destructure-element-write.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-join-in-object-literal.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-join-index-write-original.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-join-shorthand-wrapped-element.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-may-receiver-overlap-context.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-port-subsumption.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-return-shorthand-object.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-same-actor-self-edge.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-untracked-join-pruned.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-workspace-aggregation.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/emission-graph-worldread-return-only.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/extracted-alias.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/facade-siting-optional-chain.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/facade-siting-pick-receiver.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/facade-siting-spread-receiver.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/fanout-over-join.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/files-read.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/flatmap-inline-two-asks.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/functions-summaries-apply-shift.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/functions-summaries-arguments-object.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/functions-summaries-bind-merge-alignment.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/functions-summaries-bind-partial.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/functions-summaries-bind-self-rebind.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/functions-summaries-call-shift.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/functions-summaries-closure-reassigned.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/functions-summaries-curry-call.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/functions-summaries-default-param-earlier.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/functions-summaries-fn-through-param.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/functions-summaries-iife.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/functions-summaries-mutual-recursion.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/functions-summaries-reflect-apply.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/functions-summaries-rest-call.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/functions-summaries-spread-actuals.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/game-planner-reviewer.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/generator-forof.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/getter-field.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/git-world-reads.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/glob-fanout.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/grep-fanout.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/handoff-earth-v5.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/handoff-family-self-carry.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/handoff-family-to-family.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/handoff-literal-members.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/handoff-mayset-two-cards.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/handoff-pushed-array-many.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/handoff-unphased-baton.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/heap-aliasing-chained-ternary-alias-write.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/heap-aliasing-cyclic-self.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/heap-aliasing-delete-survives.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/heap-aliasing-depth-cap.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/heap-aliasing-index-assign-adopt.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/heap-aliasing-late-alias-loop.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/heap-aliasing-literal-capture-mutate.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/heap-aliasing-map-agent-context.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/heap-aliasing-map-roundtrip.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/heap-aliasing-nested-ternary-alias-write.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/heap-aliasing-param-literal-wrap.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/heap-aliasing-ternary-alias-write.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/heap-aliasing-ternary-condition-ask.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/heap-aliasing-two-names-push-join.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/heap-literal-arg-writeback.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/heap-weak-update.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/helper-flow-through.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/helper-recursive.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/higher-order.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/hole-filled-no-phases.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/hole-filled-two-phases.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/hole-in-for-of.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/hole-in-helper.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/hole-in-loop.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/hole-nested-filled.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/hole-nested.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/hole-open-mid-script.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/hole-tail.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/interpolated-actor-name.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/iterated-object-method-call.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/iteration-fanout-callback-array-param.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/iteration-fanout-destructured-element-param.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/iteration-fanout-element-mutation.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/iteration-fanout-empty-body-no-promote.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/iteration-fanout-foreach-push-join.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/iteration-fanout-forof-entries.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/iteration-fanout-generator-of-asks.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/iteration-fanout-join-in-object-literal.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/iteration-fanout-reduce-no-initial.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/iteration-fanout-reduce-seed-mutation.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/iteration-fanout-unknown-chain.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/iteration-fanout-while-shift.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/join-array-literal.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/join-conditional-element-write-through.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/join-element-alias-write-through.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/join-ports.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/json-roundtrip-clone.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/json-roundtrip-sound.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/linear-chain.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/map-set.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/may-set-branch-form-parity.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/may-set-fifo-against-fixed-lane.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/may-set-loop-alternating-receiver.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/may-set-oneshot-ternary.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/may-set-over-cap.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/method-shorthand.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/named-callback-map.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/nested-fanout-reach.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/nested-heap-write.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/nested-helper.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/objassign-shared-subobject.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/object-assign.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-control-guarded-ask.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-derived-guard-control.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-dynamic-promise-await.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-forof-sequential.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-helper-ask-two-call-sites.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-implicit-flow-guard.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-loop-carries-nothing.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-loop-head-await-tail-issue.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-loop-two-steps-carry.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-loop-unawaited-fixed-actor.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-loop-unawaited-fresh-actor.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-map-concurrent.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-mixed-join-stored-promise.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-promise-into-helper.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-shared-helper-residual-cycle.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-stored-promise-late-await.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-unawaited-one-actor.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/order-unawaited-two-actors.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/param-mutation.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/phase-admission-carryover.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/phase-empty-phase.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/phase-jsonl-db.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/phase-merge-fallback.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/phase-provenance-fanout.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/phase-scope-block.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/phase-self-loop.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/planner-reviewer.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/promise-all-map.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/reduce-accumulator.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/reentrant-then-composition.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/replace-fn.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/report-progressive.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/rest-param.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/review-launder-chain.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/setter-field.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/spread-shared-subobject.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/strand-async-helper-awaited.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/strand-async-helper-unawaited.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/strand-deferred-recursive.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/strand-fanout-awaited-per-phase.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/strand-fanout-two-phases-join.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/strand-fire-and-forget.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/strand-overlap-chain.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/strand-then-internal-await.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/stream-pipeline.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/tagged-template.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/then-callback.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/this-field-read-in-method.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/throw-catch.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/types-join-port-refinement.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/types-producer-labels.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/unary-operand-facade-call.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/user-defined-ask.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/graphs/within-fanout.ts`

### `apps/zcode-cli/packages/dynamic-workflow/tests/helpers`（1）

- `apps/zcode-cli/packages/dynamic-workflow/tests/helpers/markers.ts`

### `apps/zcode-cli/packages/dynamic-workflow/tests/lowering`（10）

- `apps/zcode-cli/packages/dynamic-workflow/tests/lowering/chained-inline-ask.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/lowering/channel-future.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/lowering/files-read-glob.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/lowering/git-and-grep.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/lowering/helper-asks.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/lowering/holes.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/lowering/log-only.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/lowering/no-facade.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/lowering/phase-markers.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/lowering/report-and-log.ts`

### `apps/zcode-cli/packages/dynamic-workflow/tests/schema-errors`（13）

- `apps/zcode-cli/packages/dynamic-workflow/tests/schema-errors/any.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schema-errors/class-instance.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schema-errors/date.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schema-errors/function-type.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schema-errors/map-set.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schema-errors/never.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schema-errors/promise.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schema-errors/report-class-instance.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schema-errors/report-date.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schema-errors/report-function.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schema-errors/report-json-shapes.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schema-errors/symbol-bigint.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schema-errors/undefined-member.ts`

### `apps/zcode-cli/packages/dynamic-workflow/tests/schemas`（7）

- `apps/zcode-cli/packages/dynamic-workflow/tests/schemas/collections.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schemas/jsdoc.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schemas/objects.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schemas/primitives.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schemas/recursive.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schemas/unions-intersections.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/schemas/unknown-permissive.ts`

### `apps/zcode-cli/packages/dynamic-workflow/tests/workflows`（10）

- `apps/zcode-cli/packages/dynamic-workflow/tests/workflows/actor-names.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/workflows/artifact-typo.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/workflows/es-lib-globals.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/workflows/facade-misuse.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/workflows/files-no-write.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/workflows/git-log-vs-log.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/workflows/glob-fanout.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/workflows/phase-markers.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/workflows/purity-ambient-apis.ts`
- `apps/zcode-cli/packages/dynamic-workflow/tests/workflows/two-errors-one-line.ts`

### `apps/zcode-cli/packages/node-repl-host/dist-types`（7）

- `apps/zcode-cli/packages/node-repl-host/dist-types/browser-bridge.d.ts`
- `apps/zcode-cli/packages/node-repl-host/dist-types/cua-broker.d.ts`
- `apps/zcode-cli/packages/node-repl-host/dist-types/process-lifecycle.d.ts`
- `apps/zcode-cli/packages/node-repl-host/dist-types/result.d.ts`
- `apps/zcode-cli/packages/node-repl-host/dist-types/runtime-bridge.d.ts`
- `apps/zcode-cli/packages/node-repl-host/dist-types/server.d.ts`
- `apps/zcode-cli/packages/node-repl-host/dist-types/tool-contract.d.ts`

## 五、已知缺口

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/record-access.ts`：L2-B7 批遗漏（中文注释 6 行，未达阈值）。按约束本任务不动 `bootstrap/src/**`，留待 v4 批次补。
- `apps/zcode-cli/packages/bootstrap/src/**`（非 v4）：另一会话进行中，未纳入本批。
- `apps/zcode-cli/packages/*/tests/**`、`dynamic-workflow/tests/**`：测试数据/支撑，未纳入。
- `apps/zcode-cli/packages/node-repl-host/dist-types/**`：构建产物，未纳入。
