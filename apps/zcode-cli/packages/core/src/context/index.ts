/**
 * ============================================================================
 * context/index.ts —— context 模块公开出口（barrel）
 * ============================================================================
 * 导出类型、builder、token 估算与各 section builder（后者主要供测试与
 * 定制组装使用）。调用方只经此入口依赖 context 模块，内部文件拆分可变化。
 * ============================================================================
 */
// ============================================================
// Context Builder exports
// ============================================================

export * from "./types.js";
export * from "./builder.js";
export * from "./utils.js";

// Section builders (for testing)
export { buildCliPrefixSection } from "./sections/cli-prefix.js";
export { buildIdentitySection } from "./sections/identity.js";
export { buildWorkflowActorIdentitySection } from "./sections/workflow-actor.js";
export { buildEnvInfoSection, buildGitSystemContextSection } from "./sections/env-info.js";
export { buildSkillsSection } from "./sections/skills.js";
export { buildCurrentDateSection } from "./sections/current-date.js";
export { buildMemorySection } from "./sections/memory.js";
export { buildDesktopContextSection } from "./sections/desktop.js";
