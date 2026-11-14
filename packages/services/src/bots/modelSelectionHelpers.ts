// bots/modelSelectionHelpers.ts — Bot 任务模型选择的最小归一化工具。
//
// 口径：
// - "default" 是 UI 上的“跟随默认”占位值，不是真实模型 ID；透传给 runtime
//   会被当成未知模型，因此这里必须折叠为 undefined，由下游回落到默认选择。
// - 原生 provider id 统一加 native: 前缀，用于和账号托管 provider 区分；
//   前缀是持久化口径，改动会导致历史会话的 provider 归属失配。
import {
  type ZCodeProvider,
} from "@zcode/shared";

const BOT_NATIVE_MODEL_PROVIDER_PREFIX = "native:";

export function resolveTaskModel(model: string | undefined): string | undefined {
  return model && model !== "default" ? model : undefined;
}

export function getNativeModelProviderId(zcodeProvider: ZCodeProvider): string {
  return `${BOT_NATIVE_MODEL_PROVIDER_PREFIX}${zcodeProvider}`;
}
