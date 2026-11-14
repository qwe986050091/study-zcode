import type { ModelSelection } from "@zcode/shared";
import { parseProviderQualifiedModelSelection } from "../app/provider-registry-selection.js";

/** 协议表示：`providerId/modelId` 字符串（provider 为账号/官方 ID，不含凭据）。 */
export function formatProtocolModelSelection(ref: ModelSelection): string {
  return `${ref.providerId}/${ref.modelId}`;
}

/**
 * 解析 `providerId/modelId`；格式/提供方非法直接抛错（调用方负责转成业务错误）。
 * 只解析字符串口径，不校验 Registry 中是否存在该模型。
 */
export function modelSelectionFromString(input: string): ModelSelection {
  const selection = parseProviderQualifiedModelSelection(input);
  if (!selection) throw new Error(`Invalid provider-qualified model selection: ${input}`);
  return selection;
}

/** 未绑定 App 的 getModel() 返回空值；读取协议不能把合法的空状态重新变成恢复异常。 */
export function optionalModelSelectionFromString(input: string): ModelSelection | undefined {
  return input.trim() ? modelSelectionFromString(input) : undefined;
}
