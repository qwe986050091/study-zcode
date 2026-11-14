// 官方 MCP 首次发放审计：进程内、有界且非持久化，重启后不会恢复上次的判定结果。
// 边界：不落盘、不跨进程共享，重启后重新计数，不能单独作为计费或安全审计依据。
// INV：键数量恒定有界，超限时必须按插入顺序淘汰最旧项，内存不随插件或工作区数量增长。
// 改错后果：误判 true 会重复发放并放大下游配额消耗，误判 false 会吞掉合法的首次发放。
export interface OfficialMcpIssuanceAudit {
  markFirst(pluginId: string, mcpKey: string, workspaceKey: string): boolean;
}

/** 进程内有界首次发放审计；返回 true 表示该三元组第一次出现。 */
export function createOfficialMcpIssuanceAudit(maxEntries = 256): OfficialMcpIssuanceAudit {
// 容量下限钳制为 1，防止非法上限导致永不淘汰或淘汰循环无法推进。
  const capacity = Math.max(1, Math.trunc(maxEntries));
  const keys = new Map<string, true>();
  return {
    markFirst(pluginId, mcpKey, workspaceKey) {
      const key = `${pluginId}\u0000${mcpKey}\u0000${workspaceKey}`;
      if (keys.has(key)) return false;
      keys.set(key, true);
// 按 Map 插入顺序淘汰，等价 FIFO；只在超限时触发，判定成本不随容量增长。
      while (keys.size > capacity) {
        const oldest = keys.keys().next();
        if (oldest.done) break;
        keys.delete(oldest.value);
      }
      return true;
    },
  };
}
