// bots/storageMigration.ts — 旧版 Bot 配置/运行态到 v3 的一次性迁移。
//
// INV-01 迁移只搬“用户意图”，不做可用性检查；候选为空时保留原选择，
//        不能把明确选择写空（历史 Bug）。
// INV-02 new 字段（modelSelection）存在时禁止回读旧 model/thoughtLevel，
//        否则旧档位会覆盖新选择。
// INV-03 只接受能解析出明确 providerId + modelId 的旧值；裸模型名不再猜测
//        供应商，无法确定时放弃迁移而不是猜。
// INV-04 返回值仍是 unknown，必须再经 schema 校验后落盘。
// [失败路径] 遇到不认识的形状原样返回，交由 schema 报错，迁移层不吞错。
import {
  decodeCustomModelValue,
  migrateLegacyModelProviderId,
  migrateLegacyOfficialGlmModelId,
  modelSelectionSchema,
  ZCODE_AGENT_PROVIDER,
  type ModelSelection,
} from "@zcode/shared";
import { normalizeBotCurrentOptions, normalizeBotDraftOptions } from "./config.js";

// 与 botConfigHelpers 的同名工具语义一致：仅探测对象形状。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只在 v3 文件不存在时调用；不是当前 Bot Options 的兼容读取器。 */
// 把旧 options 归一成 ModelSelection；无有效信息返回 undefined。
function migrateSelection(options: Record<string, unknown>): ModelSelection | undefined {
  if (Object.hasOwn(options, "modelSelection")) {
    // Bug 根因：旧 thoughtLevel 曾覆盖已保存的新档位；新字段存在时禁止回读旧字段。
    // 新字段优先且必须完整合法；非法时不回退旧字段（见 INV-02）。
    const parsed = modelSelectionSchema.safeParse(options.modelSelection);
    if (!parsed.success) return undefined;
    const selection = parsed.data;
    // 只有 builtin: 前缀需要做历史 id 映射，其余原样保留。
    if (!selection.providerId.startsWith("builtin:")) return selection;
    const providerId = migrateLegacyModelProviderId(selection.providerId);
    return providerId
      ? {
          ...selection,
          providerId,
          modelId: migrateLegacyOfficialGlmModelId(selection.providerId, selection.modelId),
        }
      : undefined;
  }
  // 旧格式：custom 编码值或 provider/model 形式。
  const value = typeof options.model === "string" ? options.model.trim() : "";
  const custom = decodeCustomModelValue(value);
  const separator = value.indexOf("/");
  // 先解 custom 编码，再退到斜杠分隔。
  const oldProviderId =
    custom?.providerId ?? (separator > 0 ? value.slice(0, separator) : undefined);
  const modelId = custom?.modelName ?? (separator > 0 ? value.slice(separator + 1) : undefined);
  // 信息不全就放弃迁移，由上层保留原配置。
  if (!oldProviderId || !modelId) return undefined;
  const providerId = migrateLegacyModelProviderId(oldProviderId);
  // 映射后仍无明确身份则放弃；不做名称匹配（见 INV-03）。
  // 仅接受明确身份，不再按模型名唯一匹配其他供应商，也不把裸模型名解释为 Agent Provider。
  // Bug 根因：候选为空时曾把明确旧选择永久写空到 v3；迁移只搬意图，不能检查当前可用性。
  if (!providerId) return undefined;
  // 旧 thoughtLevel 只在没有新字段时随迁移带过来。
  const reasoningLevel =
    typeof options.thoughtLevel === "string" ? options.thoughtLevel.trim() : "";
  return {
    providerId,
    modelId: migrateLegacyOfficialGlmModelId(oldProviderId, modelId),
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

// 配置迁移入口；保持 version 之外的其他顶层字段不变。
export function importLegacyBotConfig(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.bots)) return value;
  return {
    ...value,
    version: 3,
    bots: value.bots.map((bot) => {
      if (!isRecord(bot)) return bot;
      // 缺失或非法 currentOptions 视为空对象，不让单个 Bot 阻断整体迁移。
      const options = isRecord(bot.currentOptions) ? bot.currentOptions : {};
      return {
        ...bot,
        currentOptions: normalizeBotCurrentOptions({
          ...options,
          modelSelection: migrateSelection(options),
        }),
      };
    }),
  };
}

// 运行态迁移入口：只迁移 draftOptions，其他运行字段原样保留。
export function importLegacyBotState(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.bots)) return value;
  const bots = Object.entries(value.bots).map(([id, state]) => {
    if (!isRecord(state) || !isRecord(state.draftOptions)) return [id, state];
    // 草稿里只有旧 model/thoughtLevel/mode 需要解释。
    const options = state.draftOptions;
    return [
      id,
      {
        ...state,
        draftOptions: normalizeBotDraftOptions({
          // 旧状态没有 provider 概念，统一归到 Agent Provider。
          provider: ZCODE_AGENT_PROVIDER,
          modelSelection: migrateSelection(options),
          ...(typeof options.mode === "string" ? { mode: options.mode } : {}),
        }),
      },
    ];
  });
  return { ...value, version: 3, bots: Object.fromEntries(bots) };
}
