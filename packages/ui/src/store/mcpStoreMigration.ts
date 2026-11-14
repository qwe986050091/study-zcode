// INV-01 只认 zcode agent 用户级来源：守住位置 三条件判断；改错故障 把别的来源当成已迁移。
// INV-02 位置缺省时按自家来源处理：守住位置 可选链判断；改错故障 旧记录被漏掉。
// INV-03 空输入直接完成：守住位置 计数早退；改错故障 空迁移被报告为失败。
// INV-04 已存在同名则跳过：守住位置 名称集合；改错故障 覆盖用户现有配置。
// INV-05 逐个写入互不影响：守住位置 循环内捕获；改错故障 一个失败丢掉已迁移结果。
// INV-06 写入失败即停止并报告：守住位置 返回完成标记；改错故障 继续写入造成半迁移。
// INV-07 停写时保留已完成计数：守住位置 返回字段；改错故障 调用方重复迁移已写条目。
// INV-08 成功后才登记名称：守住位置 集合写入时机；改错故障 同名条目被写两次。
// INV-09 变更标记由导入数推导：守住位置 布尔表达式；改错故障 无变更也触发重读。
// INV-10 无旧数据直接返回原表：守住位置 空对象判断；改错故障 每次启动都走迁移。
// INV-11 迁移原因写入来源路径：守住位置 常量参数；改错故障 日志无法定位数据来源。
// INV-12 仅完成才清理旧数据：守住位置 完成判断；改错故障 无桌面桥接时丢配置。
// INV-13 未变更不重新拉取：守住位置 变更判断；改错故障 启动多一次服务调用。
// INV-14 有变更才记信息日志：守住位置 日志位置；改错故障 日志噪音掩盖真实迁移。
// INV-15 迁移后重新读取权威列表：守住位置 返回调用；改错故障 界面显示旧列表。
// INV-16 工作区路径原样透传：守住位置 查询参数；改错故障 迁移结果只含全局服务器。
// INV-17 失败不抛出到调用方：守住位置 捕获分支；改错故障 迁移异常阻断启动。
// INV-18 结果对象字段齐全：守住位置 两个返回分支；改错故障 调用方读到未定义计数。
//
// 模块职责：把旧版存在本地存储的通用 MCP 配置迁移到 zcode agent 用户目录。
// 状态所有权：旧数据真值在浏览器存储，新数据真值在用户目录，本模块只做一次性搬运。
// 阅读顺序：先看来源判定，再看逐个导入与失败分支，最后看迁移入口的清理与重读。
import type { McpServerConfig, NativeMcpServerRecord } from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  fetchNativeMcpServers,
  persistCliMcpToUserDirectory,
  type McpPlatformService,
  type MigrateLegacyResult,
} from "@/store/mcpStoreDesktop.js";
import {
  clearLegacyCommonMcpServers,
  readLegacyCommonMcpServers,
} from "@/store/mcpStoreHelpers.js";

interface CommonMcpMigrationResult extends MigrateLegacyResult {
  completed: boolean;
  changed: boolean;
}

// 来源必须是自家 agent 配置。
// isZCodeAgentUserServer 要求 scope === "user"。
// location 缺省时视为 source === "zcode" 的自家条目。
// source、scope、location 三者同时满足才返回 true，任一不符即排除。
function isZCodeAgentUserServer(server: NativeMcpServerRecord): boolean {
  return (
    server.source === "zcodeagentmcp" &&
    server.scope === "user" &&
    (!server.location || server.location.source === "zcode")
  );
}

// legacyServers 为空时返回 completed=true、changed=false。
// existingNames 只收集 isZCodeAgentUserServer 命中的 name。
// skippedCount 记录同名跳过数，随结果返回给调用方。
export async function importLegacyCommonServersToZCodeAgent(
  platform: McpPlatformService | null,
  legacyServers: Record<string, McpServerConfig>,
  nativeServers: NativeMcpServerRecord[],
  sourcePath?: string,
): Promise<CommonMcpMigrationResult> {
  const entries = Object.entries(legacyServers);
  const totalCount = entries.length;
  if (totalCount === 0) {
    return {
      totalCount: 0,
      importedCount: 0,
      skippedCount: 0,
      sourcePath,
      completed: true,
      changed: false,
    };
  }

  const existingNames = new Set(
    nativeServers.filter(isZCodeAgentUserServer).map((server) => server.name),
  );
  let importedCount = 0;
  let skippedCount = 0;

  // existingNames 命中即 skippedCount += 1 并 continue。
  // persistCliMcpToUserDirectory 返回 false 时保留 importedCount 并立即返回。
  // 写入成功后才 existingNames.add(name)，失败不污染已登记集合。
  for (const [name, config] of entries) {
    if (existingNames.has(name)) {
      skippedCount += 1;
      continue;
    }

    try {
      const persisted = await persistCliMcpToUserDirectory(platform, {
        action: "upsert",
        source: "zcodeagentmcp",
        name,
        config,
      });
      if (!persisted) {
        return {
          totalCount,
          importedCount,
          skippedCount,
          sourcePath,
          completed: false,
          changed: importedCount > 0,
        };
      }
    } catch (error) {
      logger.warn(`[mcpStore] migrate legacy common MCP ${name} failed`, String(error));
      return {
        totalCount,
        importedCount,
        skippedCount,
        sourcePath,
        completed: false,
        changed: importedCount > 0,
      };
    }

    existingNames.add(name);
    importedCount += 1;
  }

  return {
    totalCount,
    importedCount,
    skippedCount,
    sourcePath,
    completed: true,
    changed: importedCount > 0,
  };
}

// nativeServers 为空时直接返回原表，不写存储。
// completed 为真才清理旧存储，失败保留原数据。
// changed 为真时重新读取权威列表并写回 store。
export async function migrateStoredCommonMcpToZCodeAgent(
  platform: McpPlatformService | null,
  nativeServers: NativeMcpServerRecord[],
  workspacePath?: string,
): Promise<NativeMcpServerRecord[]> {
  const legacyServers = readLegacyCommonMcpServers();
  if (Object.keys(legacyServers).length === 0) {
    return nativeServers;
  }

  // 旧通用 MCP 保存在 localStorage，不迁移就直接去掉 common 读取会让用户配置从设置页和运行时消失。
  const migration = await importLegacyCommonServersToZCodeAgent(
    platform,
    legacyServers,
    nativeServers,
    "localStorage:zcode-mcp-config",
  );
  if (migration.completed) {
    // 只有确认写入 zcode agent 目录后才清理旧数据，避免 Web 端没有 desktop bridge 时丢配置。
    clearLegacyCommonMcpServers();
  }
  if (!migration.changed) {
    return nativeServers;
  }

  logger.info(
    `[mcpStore] migrated ${migration.importedCount} legacy common MCP servers to zcode agent config`,
  );
  return fetchNativeMcpServers(platform, { workspacePath });
}
