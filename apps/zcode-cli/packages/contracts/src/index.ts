// ============================================================
// Interface contracts exports
// ============================================================
//
// 【定位】@zcode/contracts 的唯一公共入口：core / adapters / bootstrap / tui 之间的
// 类型与运行时 schema 都从这里取，禁止跨层直接 import 包内深路径。本文件是纯 barrel，
// 不含任何运行时逻辑——所有值导出都来自下列模块，本层只负责"哪些模块属于公共契约"。
//
// 【分组】按领域分区（interfaces / events / compact / rewind / model / telemetry /
// errors / config / hooks / skills / commands / plugins / workflow / logging / tracing /
// time / path / network / tools）。分区顺序不代表导出优先级；同名导出冲突由 TypeScript
// 在编译期报出，不要靠调整顺序掩盖。
//
// 【尾部补充区】位于分组之后的具名转出与追加 export，是为"后加但不想打乱既有分组"的
// 模块保留的稳定落点：媒体预算错误码来自 @zcode/shared 的共用策略，本地 turn 准备
// 与完全访问 receipt 是后补的契约。新增条目请追加在对应分区或尾部，不要插入既有行，
// 以免下游 diff 噪声与潜在的重名顺序变化。
// ============================================================

// Interfaces
export * from "./interfaces/shared.js";
export * from "./interfaces/execution.port.js";
export * from "./interfaces/browser-control.port.js";
export * from "./interfaces/file-system.port.js";
export * from "./interfaces/context-source.port.js";
export * from "./interfaces/provider-endpoint-routing.port.js";
export * from "./interfaces/http-client.port.js";
export * from "./interfaces/image-processor.port.js";
export * from "./interfaces/pdf-document.port.js";
export * from "./interfaces/permission.port.js";
export * from "./interfaces/session.port.js";
export * from "./interfaces/session-mailbox.port.js";
export * from "./interfaces/session-store.port.js";
export * from "./interfaces/input-history.port.js";
export * from "./interfaces/tool-artifact-store.port.js";
export * from "./interfaces/subagent.port.js";
export * from "./interfaces/coordinator-response.port.js";
export * from "./interfaces/workflow.port.js";
export * from "./interfaces/workflow-submit.port.js";
export * from "./interfaces/workflow-escalate.port.js";
export * from "./interfaces/dynamic-workflow-run.port.js";
export * from "./interfaces/dynamic-workflow-snippet.port.js";
export * from "./interfaces/model-catalog.port.js";
export * from "./interfaces/automation.port.js";
export * from "./interfaces/off-peak.port.js";
export * from "./interfaces/topic-resource.port.js";
export * from "./interfaces/mcp.port.js";

export * from "./interfaces/runtime-input-presentation.js";

// Events
export * from "./events/session.events.js";
export * from "./events/stream-recovery.events.js";
export * from "./events/event-reducer.js";
export * from "./events/session-event-retention.js";
export * from "./events/in-memory-session-event-store.js";

// Compact
export * from "./compact/index.js";

// Rewind
export * from "./rewind/index.js";

// Model
export * from "./model/index.js";
export * from "./model/image-media.js";
export * from "./model/media-policy.js";

// Telemetry
export * from "./telemetry/index.js";

// Errors
export * from "./errors/index.js";

// Config
export * from "./config/index.js";

// Hooks
export * from "./hooks/index.js";

// Skills
export * from "./skills/index.js";

// Custom Commands
export * from "./commands/index.js";

// Plugins
export * from "./plugins/index.js";

// Workflow
export * from "./workflow/index.js";

// Logging
export * from "./logging/logger.js";

// Tracing
export * from "./tracing/tracer.js";

// Time
export * from "./time/local-date.js";

// Path
export * from "./path/index.js";

// Network
export * from "./network/public-egress-ip.js";

// Tools
export * from "./tools/index.js";
export * from "./tools/websearch.js";

// 媒体预算的四个上限/错误码属于 App 与 Agent 共用的策略常量（定义在 @zcode/shared），
// 由 Contracts 统一具名转出而不是 `export *`，目的是把可导出的白名单固定下来：
// 新增预算常量必须显式加到这里，避免 shared 的任意导出意外泄露成公共契约。
// 跨层取值一律走本入口，不要各自从 @zcode/shared 直接 import，否则版本升级时
// 各层可能拿到不同的上限。
// 媒体预算上限由 App/Agent 共用策略定义；Contracts 统一转出，避免 Core 各处跨层取值。
export {
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_IMAGE_TOO_LARGE_ERROR_CODE,
  MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE,
  VIDEO_INPUT_MAX_BYTES,
} from "@zcode/shared";

export * from "./tracing/local-turn-preparation.js";
export type { LocalTtftDetail } from "@zcode/shared";

export * from "./interfaces/permission-full-access.js";
