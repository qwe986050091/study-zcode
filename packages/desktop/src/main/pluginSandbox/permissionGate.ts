// INV-01 来源必须是登记过的沙箱来源：守住位置 记录解析；改错故障 任意页面可请求权限。
// INV-02 协议与主机名同时校验：守住位置 双重判断；改错故障 伪造主机绕过闸门。
// INV-03 来源地址必须与记录一致：守住位置 全等比较；改错故障 旧窗口继续持有权限。
// INV-04 请求方来源必须匹配实例：守住位置 拼串比较；改错故障 跨插件盗用权限。
// INV-05 解析异常一律拒绝：守住位置 捕获分支；改错故障 畸形地址带崩闸门。
// INV-06 异步确认前复核记录仍在注册表：守住位置 有效函数；改错故障 卸载后仍弹框。
// INV-07 撤销后立即失效：守住位置 二次校验；改错故障 页面已撤销仍拿到权限。
// INV-08 未声明权限直接拒绝：守住位置 决策分支；改错故障 插件越权拿到资源。
// INV-09 同一组合只弹一个框：守住位置 进行中映射；改错故障 并发请求弹出多个确认。
// INV-10 进行中承诺结算后移除：守住位置 收尾回调；改错故障 映射长期占位。
// INV-11 用户拒绝即拒绝：守住位置 结果合并；改错故障 拒绝被后续有效检查覆盖。
// INV-12 系统媒体授权逐个申请：守住位置 循环；改错故障 只申请第一个媒体类型。
// INV-13 未提供系统授权钩子视为允许：守住位置 早退判断；改错故障 非该平台无法使用媒体。
// INV-14 同意记录按分区隔离：守住位置 映射键；改错故障 不同服务器共享同意。
// INV-15 同意只在全部异步验证后写入：守住位置 写入位置；改错故障 撤销后残留授权。
// INV-16 检查路径只读不弹框：守住位置 检查实现；改错故障 渲染线程被阻塞。
// INV-17 空声明使用共享空集：守住位置 常量；改错故障 每次检查新建集合。
// INV-18 同意记录仅存内存：守住位置 存储位置；改错故障 重启后权限被静默继承。
//
// 模块职责：createPluginSandboxPermissionGate 是插件沙箱的权限闸门，必须负责来源校验、决策与同意记录。
// 状态所有权：inflight 进行中确认与 consented 同意记录都归闸门实例，按 partition 隔离。
// 阅读顺序：先看来源解析，再看系统授权，最后看请求与检查两条路径。
import type { McpAppsResourcePermission } from "@zcode/shared/mcp-apps";
import type { PluginSandboxRecord, PluginSandboxRegistryPort } from "./contract.js";
import {
  decidePluginSandboxPermission,
  isPluginSandboxPermissionGranted,
  resolvePluginSandboxCheckedPermission,
  resolvePluginSandboxRequestedPermissions,
  type PluginSandboxPromptedPermission,
} from "./permissions.js";

/**
 * 沙箱 partition 的权限闸门：Electron request / check handler 只把原始参数交给这里。
 * 来源必须是登记过的插件 origin；资源声明与同意记录决定放行；需要确认时同一 partition + 权限组合只弹一个框。
 * 同意记录只在内存（按 partition，即按 server）：本次运行期间有效，重启后再次询问。
 */
export interface PluginSandboxPermissionGate {
  request(input: {
    permission: string;
    guestUrl?: string;
    isCurrent?: () => boolean;
    requestingUrl?: string;
    mediaTypes?: readonly string[];
  }): Promise<boolean>;
  check(input: {
    guestUrl?: string;
    permission: string;
    requestingOrigin?: string;
    mediaType?: string;
  }): boolean;
}

const EMPTY: ReadonlySet<McpAppsResourcePermission> = new Set();

// inflight 按 partition 与权限组合去重；consented 按 partition 隔离；来源解析失败一律拒绝；check 路径只读不弹框。
export function createPluginSandboxPermissionGate(deps: {
  registry: Pick<PluginSandboxRegistryPort, "get">;
  /** 原生确认框；true = 用户允许。 */
  prompt(input: {
    record: PluginSandboxRecord;
    permissions: PluginSandboxPromptedPermission[];
  }): Promise<boolean>;
  /** macOS 系统级媒体授权（askForMediaAccess）；其他平台缺省视为允许。 */
  requestSystemMediaAccess?(kind: "camera" | "microphone"): Promise<boolean>;
  logger?: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
}): PluginSandboxPermissionGate {
  const inflight = new Map<string, Promise<boolean>>();
  const consented = new Map<string, Set<McpAppsResourcePermission>>();

  // url 或 guestUrl 缺失直接返回 null；协议与主机名都要匹配；来源地址必须与 record.shellUrl 一致；解析异常当作未登记。
  const recordFor = (
    url: string | undefined,
    guestUrl: string | undefined,
  ): PluginSandboxRecord | null => {
    try {
      if (!url || !guestUrl) return null;
      const guest = new URL(guestUrl);
      if (guest.protocol !== "zcode-sandbox:" || !guest.hostname.startsWith("shell-")) return null;
      const record = deps.registry.get(guest.pathname.split("/")[2] ?? "");
      if (
        !record ||
        guestUrl !== record.shellUrl ||
        `${new URL(url).protocol}//${new URL(url).host}` !==
          `zcode-sandbox://plugin-${record.instance.appIdentity}`
      )
        return null;
      return record;
    } catch {
      return null;
    }
  };

  const systemAccess = async (requested: readonly McpAppsResourcePermission[]) => {
    if (!deps.requestSystemMediaAccess) return true;
    for (const permission of requested) {
      if (permission !== "camera" && permission !== "microphone") continue;
      if (!(await deps.requestSystemMediaAccess(permission))) return false;
    }
    return true;
  };

  return {
    // 必须先经 recordFor 解析来源再解析权限；未声明权限直接拒绝；异步验证完成才写 consented。
    async request({ permission, requestingUrl, mediaTypes, guestUrl, isCurrent }) {
      const record = recordFor(requestingUrl, guestUrl);
      const requested = resolvePluginSandboxRequestedPermissions(permission, { mediaTypes });
      if (!record || !requested) {
        deps.logger?.warn(`[plugin-sandbox] permission blocked: ${permission}`);
        return false;
      }
      const valid = () =>
        deps.registry.get(record.sandboxId) === record && (isCurrent?.() ?? false);
      if (!valid()) return false;
      const declared = record.permissions ?? [];
      const { decision, pending } = decidePluginSandboxPermission({
        requested,
        declared,
        consented: consented.get(record.partition) ?? EMPTY,
      });
      if (decision === "deny") {
        deps.logger?.warn(
          `[plugin-sandbox] undeclared permission blocked: ${permission} sandbox=${record.sandboxId}`,
        );
        return false;
      }
      if (decision === "prompt") {
        const key = `${record.instance.token}|${[...pending].sort().join(",")}`;
        let flight = inflight.get(key);
        if (!flight) {
          flight = deps
            .prompt({ record, permissions: pending })
            .then((allowed) => {
              allowed = allowed && valid();
              deps.logger?.info?.("[plugin-sandbox] permission prompt settled", {
                sandboxId: record.sandboxId,
                serverName: record.serverName ?? "ZCode Gen UI",
                permissions: pending,
                allowed,
              });
              return allowed;
            })
            .finally(() => inflight.delete(key));
          inflight.set(key, flight);
        }
        if (!(await flight)) return false;
      }
      if (!(await systemAccess(requested)) || !valid()) return false;
      // 系统授权也可能晚于页面撤销；完成全部异步验证后才能保存同意记录。
      if (decision === "prompt") {
        const granted = consented.get(record.partition) ?? new Set();
        for (const item of pending) granted.add(item);
        consented.set(record.partition, granted);
      }
      return true;
    },
    check({ permission, requestingOrigin, mediaType, guestUrl }) {
      const record = recordFor(requestingOrigin, guestUrl);
      const checked = resolvePluginSandboxCheckedPermission(permission, { mediaType });
      if (!record || !checked) return false;
      return isPluginSandboxPermissionGranted({
        permission: checked,
        declared: record.permissions ?? [],
        consented: consented.get(record.partition) ?? EMPTY,
      });
    },
  };
}
