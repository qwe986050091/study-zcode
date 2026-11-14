// ==== model/request-security-edition/recovery.ts ====
// 定位：request-security edition 的 recovery 桩实现，关闭“请求校验失败重试”能力。
// 输入：RequestVerificationRetry 接收 request/model 但目前不读取；判定函数接收 error。
// 输出：extraAttempts 恒 0、claim 恒 false、空流错误判定恒 false/undefined。
// 副作用：无 IO、无网络、无状态修改。
// 失败语义：不抛错；所有判定都保守返回“不是可恢复的请求校验失败”。
// 不变量：该 edition 既不加试也不构造业务错误，调用方据此走原有失败链路。
import type { RequestVerificationReason } from "@zcode/shared";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "../runner-runtime.js";
import type { ProviderBusinessError, AiSdkProviderKind } from "../model-execution.js";
/**
 * 关闭态的重试策略占位对象。
 * 不读取构造参数，不累计任何状态；extraAttempts 为 0 表示不追加尝试，
 * takeReason 固定给出 model-request（仅用于标注来源），claim 永不认领错误。
 */
export class RequestVerificationRetry {
  constructor(_request: AiSdkModelTextRequest, _model: ResolvedAiSdkModel) {}
  /** 追加尝试次数恒为 0：此 edition 不启用请求校验失败重试。 */
  get extraAttempts(): number {
    return 0;
  }
  /** 失败归因固定为 model-request；仅作来源标记，不代表会触发重试。 */
  takeReason(): RequestVerificationReason {
    return "model-request";
  }
  /** 永不认领错误，返回 false 表示失败交给上层常规链路处理。 */
  claim(_error: unknown, _blocked = false): boolean {
    return false;
  }
}
/**
 * 判断错误是否为可重试的请求校验拒绝。
 * 关闭态下恒 false：不做错误结构探测，也不读取 headers / provider 信息。
 */
export function isRequestVerificationRejection(_error: unknown): boolean {
  return false;
}
/**
 * 构造“空流”业务错误；关闭态恒返回 undefined，表示不把空流升级为业务错误。
 * 输入字段口径：
 * - accountMode：账号模式，可空，仅用于真实实现选择判定策略。
 * - headers：响应头，可空；真实实现会读取其中的校验/限流信号。
 * - providerId：提供商标识，用于归因。
 * - providerKind：AiSdkProviderKind，区分 SDK 协议族。
 */
export function createRequestVerificationEmptyStreamError(_input: {
  accountMode?: string;
  headers: Record<string, string> | undefined;
  providerId: string;
  providerKind: AiSdkProviderKind;
}): ProviderBusinessError | undefined {
  return undefined;
}
