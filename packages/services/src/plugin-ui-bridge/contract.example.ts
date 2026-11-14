// 示例契约用法：演示 IPluginUiBridgeService 的调用形态，仅作文档与类型参考，不参与运行时。
// 其中的 pluginId / serverName / scopeId 都是形如真实值的占位串，禁止被当作契约常量复用。
// 不变量：prepareSandbox 返回的 handle 三件套（shellUrl / partition / initId）必须整体透传给 webview，
// 缺失任一项会导致面板白屏或会话隔离失效，示例故意整体返回，提示调用方不要拆开单独使用。
import type { IPluginUiBridgeService } from "./contract.js";

// 示例一：prepareSandbox 只负责申请沙箱与句柄，不做资源加载，失败直接抛出而不返回半成品。
// workspacePath 与 sessionId 共同决定沙箱归属，sessionId 变化必须重新 prepare，不能复用旧句柄。
/** UI 侧典型用法：先准备沙箱拿句柄，再把句柄交给 webview 挂载；面板作用域用 `surface:<id>`。 */
export async function examplePrepareAndMount(bridge: IPluginUiBridgeService) {
  const handle = await bridge.prepareSandbox({
    workspacePath: "/repo",
    sessionId: "session_1",
    pluginId: "example-plugin@example-marketplace",
    serverName: "plugin:example-plugin:widget",
    scopeId: "tool:call_1",
    resourceUri: "ui://example-plugin/widget.html",
    ownerWebContentsId: 1,
  });
  return { src: handle.shellUrl, partition: handle.partition, initId: handle.initId };
}

// 示例二：instance 是页面身份凭据，token 与 generation 必须来自同一代运行时；
// 旧 generation 会被拒绝，示例因此写死固定值，避免读者误以为这些字段可省略。
/** 页面 `resources/read` 经桥读取同插件服务器的二进制资源；结果与 MCP 同形。 */
export async function exampleReadBlob(bridge: IPluginUiBridgeService) {
  const result = await bridge.readResource({
    instance: {
      runtimeId: "test-agent",
      generation: 1,
      token: "test-token",
      appIdentity: "a".repeat(64),
    },
    workspacePath: "/repo",
    sessionId: "session_1",
    pluginId: "example-plugin@example-marketplace",
    serverName: "plugin:example-plugin:widget",
    uri: "ui://example-plugin/model.glb",
  });
  return result.contents[0]?.blob ?? null;
}

// 示例三：scope 必须由调用方注入，桥自身不缓存插件作用域，防止跨插件串用；
// operationId 只用于去重与结果关联，重试时复用它才能命中幂等语义。
/** sampling 绑定已有页面身份，历史由 App 提交，结果只返回 App。 */
export function exampleSample(
  service: import("./samplingContract.js").IPluginUiSamplingService,
  scope: import("./contract.js").PluginUiPluginScope,
) {
  return service.sample({
    ...scope,
    operationId: "sample-1",
    request: {
      messages: [{ role: "user", content: { type: "text", text: "Explain 1/2" } }],
      maxTokens: 128,
    },
  });
}
