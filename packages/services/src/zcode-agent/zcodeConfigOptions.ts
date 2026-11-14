import type {
  ZCodeConfigOption,
  ZCodeMessageWithParts,
  ModelSelection,
  ZCodeSessionMode,
  ZCodeSessionSettingsState,
  ZCodeSessionStateSnapshot,
  ZCodeTaskModeInfo,
} from "@zcode/shared";
import {
  formatModelPickerValue as formatSharedModelSelection,
  getZCodeAgentAvailableModes as getSharedZCodeAgentAvailableModes,
  normalizeAvailableZCodeMode as normalizeSharedAvailableZCodeMode,
  zcodeSessionSettingsToZCodeConfigOptions,
} from "@zcode/shared";

// 三个 config id 是协议可见的稳定标识，UI 与 CLI 都按它们匹配，不能随意改名。
export const MODEL_CONFIG_ID = "model";
export const MODE_CONFIG_ID = "mode";
// 思考等级与模型/模式分开：它们是独立配置项，取值来源也不同。
export const THOUGHT_LEVEL_CONFIG_ID = "thought_level";

// service 层只做转发，格式化规则必须与 shared 保持同一实现。
export function formatModelPickerValue(ref: ModelSelection | undefined): string {
  return formatSharedModelSelection(ref);
}

// 逆序查找最近一条带 model 的消息：越新越接近真实使用状态。
function resolveLatestMessageModelSelection(
  messages: readonly ZCodeMessageWithParts[],
): ModelSelection | undefined {
// 从尾部向前扫，命中即返回，避免遍历整段历史。
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = messages[index]?.info.model;
    if (model) {
      return model;
    }
  }
// 全部消息都没带 model 时返回 undefined，由调用方决定兜底来源。
  return undefined;
}

function resolveTaskMetaModelSelectionFromSnapshot(
  snapshot: Pick<ZCodeSessionStateSnapshot, "messages" | "settings">,
): ModelSelection | undefined {
  // 历史 resume 曾经可能用 app 当前默认模型覆盖 settings.current，
  // 但消息 info.model 仍保留真实使用的模型。task meta 是历史恢复 hint，
  // 应优先记录最近消息实际使用的模型，避免错误 snapshot 继续污染 task index。
  return resolveLatestMessageModelSelection(snapshot.messages) ?? snapshot.settings.model.current;
}

// task meta 的模型值同样走上面这条优先链，保证历史恢复与展示一致。
export function formatTaskMetaModelSelectionFromSnapshot(
  snapshot: Pick<ZCodeSessionStateSnapshot, "messages" | "settings">,
): string {
  return formatModelPickerValue(resolveTaskMetaModelSelectionFromSnapshot(snapshot));
}

// 模式归一化只转发 shared：service 层不保留第二份映射表。
export function normalizeAvailableZCodeMode(mode: ZCodeSessionMode): string {
  return normalizeSharedAvailableZCodeMode(mode);
}

// 可用模式清单同样来自 shared，新增模式时只需改一处。
export function getZCodeAgentAvailableModes(): ZCodeTaskModeInfo[] {
  return getSharedZCodeAgentAvailableModes();
}

// settings 到 config options 的转换必须复用 shared 的事实源；
// 否则 service 侧白名单会随模式新增而过期，反过来覆盖 UI 菜单。
export function settingsToConfigOptions(settings: ZCodeSessionSettingsState): ZCodeConfigOption[] {
  // service 侧曾经维护了一份三项 mode 白名单，edit 模式上线后没有同步，
  // 切换模式时 mode_update 会把 UI 菜单覆盖成 build/plan/yolo。这里统一复用 shared 的事实源。
  return zcodeSessionSettingsToZCodeConfigOptions(settings);
}
