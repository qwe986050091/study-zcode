// INV-01 沙箱标识必须落在 CSP 允许的字符集内：守住位置 createId；改错故障 下划线导致整条 host-source 被忽略。
// INV-02 标识前缀固定，主体去掉随机 UUID 的短横线：守住位置 默认标识生成；改错故障 资源路径与 CSP 不匹配。
// INV-03 幂等键必须覆盖所有者、工作区、会话、内容类型与插件身份：守住位置 idempotencyKey；改错故障 不同插件互相覆盖 HTML。
// INV-04 工作区标识优先于路径：守住位置 幂等键中的工作区字段；改错故障 同一工作区因路径写法不同重复登记。
// INV-05 登记前必须先清理过期条目：守住位置 register 的 pruneExpired；改错故障 过期项占用配额。
// INV-06 命中幂等键时直接返回原句柄，不刷新过期时间：守住位置 已存在分支；改错故障 重复登记让沙箱永不过期。
// INV-07 配额只按条目总数判断：守住位置 maxEntries 检查；改错故障 超限后新插件无法打开。
// INV-08 被引用的条目不参与过期清理：守住位置 pinned 判断；改错故障 活跃页面中途被销毁。
// INV-09 内容类型必须与来源字段一致：守住位置 register 的两段校验；改错故障 缺来源的 MCP App 或带能力的 Gen UI 混入。
// INV-10 Gen UI 与 MCP App 使用不同分区规则：守住位置 partition 构造；改错故障 两类内容共享存储与权限。
// INV-11 CSP 必须由统一构造器生成：守住位置 cspHeader 字段；改错故障 放松策略绕过校验。
// INV-12 句柄只暴露登记输入声明过的呈现字段：守住位置 resourceMetaOf；改错故障 未声明的边框或高度被误启用。
// INV-13 读取必须刷新最近使用时间：守住位置 get；改错故障 活跃沙箱被当成闲置清理。
// INV-14 释放必须校验初始化代际：守住位置 dispose 的 initId 判断；改错故障 旧页面卸载误删新页面沙箱。
// INV-15 按所有者释放要覆盖该窗口全部条目：守住位置 disposeOwner；改错故障 窗口关闭后沙箱泄漏。
// INV-16 用户手势时间戳一次性消费：守住位置 consumeUserGesture；改错故障 一次点击可重复触发敏感能力。
// INV-17 手势有效期固定为五秒：守住位置 常量与新鲜度判断；改错故障 过期手势仍被接受。
// INV-18 关闭回调只在真正移除时触发：守住位置 remove 的 notify 参数；改错故障 重复通知导致端口被二次关闭。
//
// 模块职责：必须在 main 进程内登记、查询与回收插件 UI 沙箱，并维护幂等键、配额与用户手势状态。
// 状态所有权：条目表与幂等索引都由本注册表持有；沙箱内容与生命周期归 main 进程唯一管理。
// 阅读顺序：先看常量与选项，再读幂等键与清理工具，最后读注册、读取与释放接口。
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { randomUUID } from "node:crypto";
import type {
  PluginSandboxRecord,
  PluginSandboxRegisterInput,
  PluginSandboxRegistryPort,
} from "./contract.js";
import {
  PluginSandboxQuotaError,
  buildPluginSandboxPartition,
  buildPluginSandboxShellUrl,
} from "./contract.js";
import { buildPluginSandboxCsp } from "./csp.js";

// DEFAULT_TTL_MS 默认六小时，覆盖一次完整工作会话；DEFAULT_MAX_ENTRIES 默认六十四条，防止异常插件无限登记；两个值都必须可被选项覆盖，便于测试缩短时间。
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 64;
/** 与 HTML transient activation 一致：一次输入事件给 5 秒窗口，一次性消费。 */
export const PLUGIN_SANDBOX_USER_GESTURE_TTL_MS = 5_000;

export interface CreatePluginSandboxRegistryOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  createId?: () => string;
  /** dispose 时通知宿主收尾（关 ports；partition 持久且按可信 App 身份隔离，不撤 protocol、不清存储）。 */
  onDispose?: (record: PluginSandboxRecord) => void;
}

interface RegistryEntry {
  record: PluginSandboxRecord;
  expiresAt: number;
  lastUsedAt: number;
  gestureAt: number | null;
  /** 活 guest 数；> 0 时不参与 TTL 过期。 */
  pinned: number;
}

/**
 * 沙箱注册表：main 进程内插件 UI 沙箱内容与生命周期的唯一 owner。
 * 先例：`createLocalMediaPreviewPathRegistry`——同样是 host 校验后登记、按 TTL / maxEntries 清理。
 */
// 时间来源、TTL、上限与标识生成都必须可注入。
// entries 必须保存完整记录与生命周期计数；idByIdempotencyKey 把稳定键映射到沙箱标识；返回值在端口之外额外暴露诊断用的 size 与 clear。
export function createPluginSandboxRegistry(
  options: CreatePluginSandboxRegistryOptions = {},
): PluginSandboxRegistryPort & {
  /** 幂等 key → sandboxId，供测试与诊断。 */
  size(): number;
  clear(): void;
} {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  // sandboxId 进入资源路径；origin 由可信 appIdentity 派生。历史 ID 仍保持合法 host 字符集。
  // CSP host-source 只允许 ALPHA / DIGIT / "-"：带下划线的 source 会被 Chromium 整条忽略，
  // frame-ancestors 退化为 'none'，插件 iframe 直接被 ERR_BLOCKED_BY_RESPONSE 拦成空白页。
  const createId = options.createId ?? (() => `sb-${randomUUID().replaceAll("-", "")}`);
  const entries = new Map<string, RegistryEntry>();
  const idByIdempotencyKey = new Map<string, string>();

  // 修复：不同插件可声明同名 surface，缺少 plugin/workspace 会复用并覆盖另一插件的 HTML。
  // 键由数组序列化，字段顺序固定。
  // workspaceId 优先，缺失才退回路径。
  // 内容类型缺省为 MCP App。
  // pluginId、scopeId、serverName 与 instance.token 必须共同区分来源。
  const idempotencyKey = (
    input: Pick<
      PluginSandboxRegisterInput,
      | "ownerWebContentsId"
      | "workspacePath"
      | "workspaceIdentity"
      | "sessionId"
      | "contentKind"
      | "pluginId"
      | "scopeId"
      | "serverName"
      | "instance"
    >,
  ) =>
    JSON.stringify([
      input.ownerWebContentsId,
      input.workspaceIdentity?.trim() || input.workspacePath || "",
      input.sessionId,
      input.contentKind ?? "mcp-app",
      input.pluginId,
      input.scopeId,
      input.serverName,
      input.instance.token,
    ]);

  // remove 遇到不存在时直接返回，保证重复释放安全；必须先删 entries 再删 idByIdempotencyKey，避免半删除状态；只有需要通知时才调用 options.onDispose。
  const remove = (sandboxId: string, notify: boolean) => {
    const entry = entries.get(sandboxId);
    if (!entry) return;
    entries.delete(sandboxId);
    idByIdempotencyKey.delete(idempotencyKey(entry.record));
    if (notify) options.onDispose?.(entry.record);
  };

  const pruneExpired = (observedAt: number) => {
    for (const [sandboxId, entry] of entries) {
      if (entry.pinned === 0 && entry.expiresAt <= observedAt) remove(sandboxId, true);
    }
  };

  // 句柄只带登记输入里声明过的呈现字段（host 桥已按"资源级优先、工具级兜底"合并）；prefersBorder 在
  // record 上缺省为 false，所以按输入而不是 record 判断"是否声明"。
  const resourceMetaOf = (
    input: Pick<
      PluginSandboxRegisterInput,
      "prefersBorder" | "heightHint" | "minFrameHeight" | "showInline" | "permissions"
    >,
  ): PluginSandboxHandle["resourceMeta"] => {
    const meta = {
      ...(input.permissions?.length ? { permissions: [...input.permissions] } : {}),
      ...(input.prefersBorder !== undefined ? { prefersBorder: input.prefersBorder } : {}),
      ...(input.heightHint !== undefined ? { heightHint: input.heightHint } : {}),
      ...(input.minFrameHeight !== undefined ? { minFrameHeight: input.minFrameHeight } : {}),
      ...(input.showInline !== undefined ? { showInline: input.showInline } : {}),
    };
    return Object.keys(meta).length > 0 ? meta : undefined;
  };

  const toHandle = (record: PluginSandboxRecord): PluginSandboxHandle => ({
    instance: record.instance,
    sandboxId: record.sandboxId,
    initId: record.initId,
    shellUrl: record.shellUrl,
    partition: record.partition,
    ...(record.resourceMeta ? { resourceMeta: record.resourceMeta } : {}),
  });

  return {
    // register 先校验 contentKind 与来源字段的组合合法性；登记前清理过期条目，再计算幂等键；命中已有条目时原样返回，不改变其生命周期；配额必须只在新登记时检查。
    // 构造记录时按内容类型选择分区并生成 CSP。
    register(input: PluginSandboxRegisterInput): PluginSandboxHandle {
      if (input.contentKind !== "gen-ui" && (!input.pluginId || !input.serverName))
        throw new Error("Missing MCP App provenance");
      if (
        input.contentKind === "gen-ui" &&
        (input.pluginId || input.serverName || input.permissions?.length)
      )
        throw new Error("Invalid Gen UI capabilities");
      const observedAt = now();
      pruneExpired(observedAt);
      const key = idempotencyKey(input);
      const existingId = idByIdempotencyKey.get(key);
      const existing = existingId ? entries.get(existingId) : undefined;
      if (existing) return toHandle(existing.record);
      // 未挂载的 prepare 也可能仍在传输；回收由页面 owner 完成，Main 不抢占其他窗口的登记。
      if (entries.size >= maxEntries) throw new PluginSandboxQuotaError(maxEntries);
      const sandboxId = createId();
      const record: PluginSandboxRecord = {
        instance: input.instance,
        sandboxId,
        initId: 1,
        shellUrl: buildPluginSandboxShellUrl(sandboxId, input.instance.appIdentity),
        partition:
          input.contentKind === "gen-ui"
            ? `gen-ui-${input.instance.appIdentity}`
            : buildPluginSandboxPartition({
                appIdentity: input.instance.appIdentity,
              }),
        ownerWebContentsId: input.ownerWebContentsId,
        ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        sessionId: input.sessionId,
        contentKind: input.contentKind,
        pluginId: input.pluginId,
        serverName: input.serverName,
        scopeId: input.scopeId,
        html: input.html,
        cspHeader: buildPluginSandboxCsp({
          csp: input.csp,
          cspRelaxations: input.cspRelaxations,
          sandboxId,
          appIdentity: input.instance.appIdentity,
        }),
        ...(input.cspRelaxations ? { cspRelaxations: input.cspRelaxations } : {}),
        ...(input.permissions?.length ? { permissions: [...input.permissions] } : {}),
        prefersBorder: input.prefersBorder ?? false,
        ...(resourceMetaOf(input) ? { resourceMeta: resourceMetaOf(input) } : {}),
      };
      entries.set(sandboxId, {
        record,
        expiresAt: observedAt + ttlMs,
        lastUsedAt: observedAt,
        gestureAt: null,
        pinned: 0,
      });
      idByIdempotencyKey.set(key, sandboxId);
      return toHandle(record);
    },
    get(sandboxId) {
      const observedAt = now();
      pruneExpired(observedAt);
      const entry = entries.get(sandboxId);
      if (!entry) return null;
      entry.lastUsedAt = observedAt;
      return entry.record;
    },
    dispose(sandboxId, initId) {
      if (initId !== undefined && entries.get(sandboxId)?.record.initId !== initId) return;
      remove(sandboxId, true);
    },
    disposeOwner(ownerWebContentsId) {
      for (const [sandboxId, entry] of entries) {
        if (entry.record.ownerWebContentsId === ownerWebContentsId) remove(sandboxId, true);
      }
    },
    pin(sandboxId) {
      const entry = entries.get(sandboxId);
      if (entry) entry.pinned += 1;
    },
    unpin(sandboxId) {
      const entry = entries.get(sandboxId);
      if (entry && entry.pinned > 0) entry.pinned -= 1;
    },
    markUserGesture(sandboxId) {
      const entry = entries.get(sandboxId);
      if (entry) entry.gestureAt = now();
    },
    // consumeUserGesture 在没有记录或没有手势时间时直接失败；新鲜度按 PLUGIN_SANDBOX_USER_GESTURE_TTL_MS 的五秒窗口判断；无论是否新鲜都必须清空时间戳，保证一次性。
    consumeUserGesture(sandboxId) {
      const entry = entries.get(sandboxId);
      if (!entry || entry.gestureAt === null) return false;
      const fresh = now() - entry.gestureAt <= PLUGIN_SANDBOX_USER_GESTURE_TTL_MS;
      entry.gestureAt = null;
      return fresh;
    },
    size: () => entries.size,
    // clear 必须逐项删除并通知宿主收尾；Map.forEach 中删除当前项是安全的；清空后 idByIdempotencyKey 与 entries 同时为空。
    clear() {
      // Map.forEach 中删除当前项是安全的，不需要先拷贝 key 列表。
      entries.forEach((_entry, sandboxId) => remove(sandboxId, true));
    },
  };
}
