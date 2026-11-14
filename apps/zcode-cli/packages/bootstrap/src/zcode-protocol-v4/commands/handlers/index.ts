// 原生 handler 注册表（每组加一行 spread）。
// 组文件命名 = 命令分组：session-flow / queue / session-mgmt /
// goal-compact / model-config / interaction-background / fork-edit-retry。
import { forkEditRetryHandlers } from "./fork-edit-retry.js";
import { fileRewindHandlers } from "./file-rewind.js";
import { goalCompactHandlers } from "./goal-compact.js";
import { interactionBackgroundHandlers } from "./interaction-background.js";
import { modelConfigHandlers } from "./model-config.js";
import { queueHandlers } from "./queue.js";
import { sessionFlowHandlers } from "./session-flow.js";
import { sessionMgmtHandlers } from "./session-mgmt.js";
import { selectionSideSessionHandlers } from "./selection-side-session.js";
import { assistantFeedbackHandlers } from "./assistant-feedback.js";
import { highspeedMetricsHandlers } from "./highspeed-metrics.js";

/**
 * 原生命令注册表：command type → handler(host, envelope)。
 * 每个组文件只导出本组 handler 对象，这里按组 spread 合并；顺序不参与裁决
 * （命令 type 唯一，重复注册会覆盖，必须保证组内不重复）。
 * 增删命令时同步更新 commandPayloadSchemas，否则 schema 校验先拒。
 */
export const NATIVE_HANDLERS = {
  ...sessionFlowHandlers,
  ...queueHandlers,
  ...sessionMgmtHandlers,
  ...selectionSideSessionHandlers,
  ...goalCompactHandlers,
  ...modelConfigHandlers,
  ...interactionBackgroundHandlers,
  ...forkEditRetryHandlers,
  ...fileRewindHandlers,
  ...assistantFeedbackHandlers,
  ...highspeedMetricsHandlers,
} as const;

/** 已原生化的命令 type 联合；binder/executor 以此判断是否回落旧桥。 */
export type NativeCommandType = keyof typeof NATIVE_HANDLERS;
