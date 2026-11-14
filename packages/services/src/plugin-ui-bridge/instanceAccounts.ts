// MCP App 账号绑定：把 Host 侧凭据 owner 的账号上下文绑定到沙箱实例的整个生命周期。
// 边界：账号只从 deps.readAccount 读取，绝不接收页面传入的账号或访问令牌。
// 不变量(INV)：revision 单调递增；open 前后两次校验必须相等，否则要关闭已开实例。
// 改错会怎样：漏掉二次校验会让换号后的页面继续复用旧账号实例，造成越权读取。
import type { McpAppInstance } from "@zcode/shared/mcp-apps";
import { createHash } from "node:crypto";
import type { PluginUiPluginScope, PluginUiPrepareSandboxParams } from "./contract.js";

/** Host 的账号上下文来自凭据 owner；不接收页面传入的账号或访问令牌。 */
export function createPluginUiAccountBindings(deps: {
  readAccount(): Promise<unknown>;
  open(params: PluginUiPrepareSandboxParams & { accountContext: string }): Promise<McpAppInstance>;
  close(params: PluginUiPluginScope): Promise<void>;
}) {
// 代际计数器：invalidate 递增即让所有在途 open 的 captured 失效，无需加锁。
  let revision = 0;
  const active = new Map<string, PluginUiPluginScope>();
// 先摘除记录再 await：即使 deps.close 抛错或挂起，本地也不会残留可被再次关闭的条目。
  const close = async (params: PluginUiPluginScope) => {
    active.delete(params.instance.token);
    await deps.close(params);
  };
  return {
// 在读账号前捕获代际，保证「读账号 → 哈希 → 开实例」整段处于同一代。
    async open(params: PluginUiPrepareSandboxParams) {
      const captured = revision;
      const accountContext = createHash("sha256")
        .update(JSON.stringify(await deps.readAccount()))
        .digest("hex");
      if (captured !== revision) throw new Error("MCP App account changed during initialization");
// 二次校验放在 open 之后：期间若账号被切换，必须立即关闭刚创建的实例，避免资源泄漏。
      const instance = await deps.open({ ...params, accountContext });
      const bound = { ...params, instance };
      if (captured !== revision) {
        await deps.close(bound);
        throw new Error("MCP App account changed during initialization");
      }
// 只有通过两次校验才登记；token 是后续关闭的唯一凭据，不能提前写入。
      active.set(instance.token, bound);
      return instance;
    },
    close,
// 先自增再清理：让在途 open 的二次校验失败，防止清理后又被写回 active。
    invalidate() {
      // 先使在途 open 失效；注销旧凭证只作用于它自己的 Agent 代际。
      revision++;
      for (const bound of active.values()) void deps.close(bound).catch(() => undefined);
      active.clear();
    },
  };
}
