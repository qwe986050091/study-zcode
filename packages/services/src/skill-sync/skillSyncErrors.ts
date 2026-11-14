// 职责边界：只定义技能同步超限错误的形状与构造入口，不决定上限阈值，也不决定重试策略。
// INV：code 恒等于 SKILL_SYNC_SIZE_LIMIT_ERROR_CODE，data 必须原样携带 phase 与实际字节数。
// INV：调用方只能经由 createSkillSyncSizeLimitError 构造，不得手写 code 或 data。
// 改错后果：丢失 code 或 phase 会让跨 RPC 的 UI 退化为不可区分的泛化错误，用户无法得知超限发生在哪个阶段。
import {
  SKILL_SYNC_SIZE_LIMIT_ERROR_CODE,
  type SkillSyncSizeLimitErrorData,
} from "@zcode/shared";

// 原始错误只携带字节数拼接文本，跨 RPC 后 UI 无法可靠区分导出内容、归档和解压阶段。
// 统一透传稳定 code 与结构化 data，让 UI 可以按当前语言展示可操作的错误。
export interface SkillSyncSizeLimitError extends Error {
  code: typeof SKILL_SYNC_SIZE_LIMIT_ERROR_CODE;
  data: SkillSyncSizeLimitErrorData;
}

export function createSkillSyncSizeLimitError(
  data: SkillSyncSizeLimitErrorData,
): SkillSyncSizeLimitError {
  const error = new Error(
    `skill sync size limit exceeded: ${data.actualBytes}/${data.maxBytes} (${data.phase})`,
  ) as SkillSyncSizeLimitError;
  error.name = "SkillSyncSizeLimitError";
  error.code = SKILL_SYNC_SIZE_LIMIT_ERROR_CODE;
  error.data = data;
  return error;
}
