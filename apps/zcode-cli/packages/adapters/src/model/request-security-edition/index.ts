// ==== model/request-security-edition/index.ts ====
// 定位：request-security edition 的工厂入口，提供“不启用安全策略”的空实现。
// 输入：无；每次调用独立创建状态容器。
// 输出：ModelRequestSecurityState，createExecution 返回直通 transport 的执行上下文。
// 副作用：无 IO / 无网络 / 无日志。
// 失败语义：不抛错；protectTransport 恒等返回，take 恒返回空数组。
// 不变量：该 edition 不修改请求、不产生额外鉴权动作，调用方拿到的是零开销占位实现。
import type { ModelRequestSecurityState } from "../request-security.js";

/**
 * 创建空安全状态。
 * 执行上下文里的 protectTransport 是恒等函数（原样放行 transport），
 * take 永远返回空数组，表示没有需要回填的鉴权信息。
 * 该实现用于关闭安全策略的 edition，不做任何校验或重试。
 */
export function createModelRequestSecurityState(): ModelRequestSecurityState {
  return {
    createExecution: () => ({
      protectTransport: ({ transport }) => transport,
      take: () => [],
    }),
  };
}
