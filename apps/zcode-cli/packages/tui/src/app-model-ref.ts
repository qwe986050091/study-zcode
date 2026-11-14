// 模型标识的纯展示工具。
// 职责：把 "provider/model" 字符串拆成展示片段，并生成候选展示值。
// 边界：不校验 provider 注册表、不做大小写归一，不参与命令解析。
// 副作用：无，均为纯函数；不读取全局状态。
// 降级：空串或缺失片段统一回落到占位符 "-"。

import type { TuiModelOption } from "./types.js";

const MODEL_REF_SEPARATOR = "/";

// 模型字段缺失时的展示占位符，避免界面上出现空串或 undefined。
export const UNKNOWN_MODEL_FIELD = "-";

// 模型标识拆出的展示片段：provider 与 model 各为一段，缺失时统一用 UNKNOWN_MODEL_FIELD。
type ModelDisplayParts = {
  model: string;
  provider: string;
};

// 把 "provider/model" 形式的模型标识拆成两段用于展示，仅做字符串切分，不校验真伪。
// 输入：任意字符串；空串/仅空白时两段都返回占位符。
// 规则：以第一个 "/" 为界；分隔符在首位（无 provider）时整串视为 model 且 provider 为占位符；
// 各段 trim 后为空同样回落占位符。
// 副作用：无，纯函数；不访问 provider 注册表，不做大小写归一。
export function modelDisplayParts(modelSelection: string): ModelDisplayParts {
  const value = modelSelection.trim();
  if (!value) {
    return {
      model: UNKNOWN_MODEL_FIELD,
      provider: UNKNOWN_MODEL_FIELD,
    };
  }

  const separatorIndex = value.indexOf(MODEL_REF_SEPARATOR);
  if (separatorIndex <= 0) {
    return {
      model: value,
      provider: UNKNOWN_MODEL_FIELD,
    };
  }

  return {
    model: value.slice(separatorIndex + MODEL_REF_SEPARATOR.length).trim() || UNKNOWN_MODEL_FIELD,
    provider: value.slice(0, separatorIndex).trim() || UNKNOWN_MODEL_FIELD,
  };
}

// 返回值是展示与比较用的稳定字符串，格式固定，不随 locale 或自定义显示名变化。
// ref 字段为空串时会原样拼出 "/model" 或 "provider/"，不做占位替换（调用方保证字段完整）。
// 生成模型候选的展示值，固定为 "providerId/modelId"。
// 仅用于展示与 current 比较；命令提交直接携带 ref，不反向解析该字符串。
// 副作用：无，纯函数；调用方保证 ref 字段完整。
/** Display only; model commands carry ref directly instead of parsing this value. */
export function modelOptionValue(model: TuiModelOption): string {
  return `${model.ref.providerId}/${model.ref.modelId}`;
}
