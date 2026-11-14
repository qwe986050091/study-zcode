// 插件 UI 沙箱登记桥的合约（Host ↔ Main）。
//
// 职责：定义 createPluginSandboxRegistrationBridge 必须实现的三个方法，供 Host 侧按
// requestId 关联「登记请求」与「Main 回传结果」。
// 输入输出：register 输入 PluginSandboxRegisterInput，输出 Promise<PluginSandboxHandle>；
// accept 输入 Main 回包（含 requestId / ok / error）；
// dispose 无输入输出，用于 Host 退出时收口。
// 副作用：不在本文件——实现在 index.ts；本文件只声明契约。
// 失败语义：register 以 Promise reject 表达失败；accept 对未知 requestId 静默忽略。
// 维护的不变量：本桥只拥有 pending 传输，不保存沙箱或会话事实（事实在 Main / services）。

import type { PluginSandboxHandle, PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";

/** Host 到 Main 的登记请求关联；只拥有 pending 传输，不保存沙箱或会话事实。 */
export interface PluginSandboxRegistrationBridge {
  register(input: PluginSandboxRegisterInput): Promise<PluginSandboxHandle>;
  accept(
    result: Partial<PluginSandboxHandle> & { requestId: string; ok: boolean; error?: string },
  ): void;
  dispose(): void;
}
