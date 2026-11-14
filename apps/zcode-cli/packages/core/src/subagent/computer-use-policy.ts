import { relative, isAbsolute } from "node:path";
import {
  ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME as ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
} from "@zcode/shared";
import type { McpToolDescriptor, PluginReferenceCatalog, SkillMetadata } from "@zcode/contracts";
import { toMcpToolName, toModelVisibleMcpNamePart } from "../mcp/name.js";

// 子 agent 访问官方 Computer Use 能力时的稳定错误码与文案，供 MCP port 与 UI 共用。
// 错误码用于结构化判断，文案保证跨层一致；两者都不随具体 server 名变化。
export const SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE = "SUBAGENT_COMPUTER_USE_UNAVAILABLE" as const;
export const SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE =
  "Computer Use is not available in subagent" as const;

// 官方 CUA server 的规范前缀（保留 server 名里的连字符）。
const OFFICIAL_CUA_CANONICAL_PREFIX = "mcp__computer-use__";
// 官方 CUA 的兼容别名前缀（下划线写法），历史配置与提示词中仍可能出现。
const OFFICIAL_CUA_ALIAS_PREFIX = "mcp__computer_use__";
// 可接受的官方 CUA server 标识写法集合，用于 `mcp__<server>__*` 选择器匹配。
const OFFICIAL_CUA_SERVER_PARTS = new Set([
  "computer-use",
  "computer_use",
  toModelVisibleMcpNamePart(ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME),
]);

// 官方 Computer Use 的识别策略：子 agent 据此判断哪些 MCP 工具、server 选择器与
// Skill 属于“官方 CUA”，从而在子 agent 中统一拒绝，而不是按名称猜测。
export interface OfficialCuaPolicy {
  // 被认定为官方 CUA 的 MCP server 名集合（来自启动配置），只读。
  readonly serverNames: ReadonlySet<string>;
  // 判断某个工具全名是否指向官方 CUA；输入可为带空白的原始名称。
  isOfficialToolRequest(name: string): boolean;
  // 判断 `mcp__<server>__*` 形式的 server 选择器是否指向官方 CUA。
  isOfficialServerSelector(name: string): boolean;
  // 判断工具白名单中的 Skill 名是否指向官方 CUA（仅限 qualified 名称）。
  isOfficialSkillRequest(name: string): boolean;
  // 依据活体 Skill 元数据判定是否属于官方 CUA 插件，兼容无 qualifiedName 的旧数据。
  isOfficialSkill(metadata: SkillMetadata): boolean;
}

// 构建官方 CUA 识别策略。输入：官方 server 名集合、当前 MCP 工具描述符、插件目录
// （catalog 为 undefined 表示尚未加载插件信息，此时 Skill 判定降级为“非官方”）。
// 输出：纯判断函数集合，无 IO、无状态变更、无日志。
// 不变量：toolNames 只收录官方 server 的描述符；descriptor 数量为 0 时退化为前缀匹配，
// 收到描述符后收窄为精确集合，避免第三方同名工具被误判。
export function createOfficialCuaPolicy(
  officialServerNames: ReadonlySet<string>,
  descriptors: readonly McpToolDescriptor[],
  catalog: PluginReferenceCatalog | undefined,
): OfficialCuaPolicy {
  const toolNames = new Set<string>();
  // 0 表示“还没有官方描述符快照”，决定后续是否允许前缀兜底匹配。
  let officialDescriptorCount = 0;
  for (const descriptor of descriptors) {
    if (!officialServerNames.has(descriptor.serverName)) continue;
    officialDescriptorCount += 1;
    toolNames.add(toMcpToolName(descriptor));
    if (descriptor.serverName === ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME) {
      // 官方 server 额外登记 canonical/alias 两种历史前缀，兼容旧调用方写法。
      const suffix = toModelVisibleMcpNamePart(descriptor.toolName);
      toolNames.add(`${OFFICIAL_CUA_CANONICAL_PREFIX}${suffix}`);
      toolNames.add(`${OFFICIAL_CUA_ALIAS_PREFIX}${suffix}`);
    }
  }

  // 启动快照缺失时使用的前缀集合：按模型可见命名规则生成 `mcp__<server>__`。
  const officialToolPrefixes = new Set<string>();
  for (const serverName of officialServerNames) {
    officialToolPrefixes.add(`mcp__${toModelVisibleMcpNamePart(serverName)}__`);
  }
  if (officialServerNames.has(ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME)) {
    officialToolPrefixes.add(OFFICIAL_CUA_CANONICAL_PREFIX);
    officialToolPrefixes.add(OFFICIAL_CUA_ALIAS_PREFIX);
  }

  // server 选择器允许的 server 名称片段；官方 CUA 额外接受三种历史写法。
  const officialServerSelectorParts = new Set<string>();
  for (const serverName of officialServerNames) {
    if (serverName === ZCODE_CUA_OFFICIAL_MCP_SERVER_NAME) {
      for (const part of OFFICIAL_CUA_SERVER_PARTS) officialServerSelectorParts.add(part);
      continue;
    }
    officialServerSelectorParts.add(toModelVisibleMcpNamePart(serverName));
  }

  // 插件目录缺失或插件未安装时，以下均为空/undefined，Skill 判定统一返回 false。
  const officialPlugin = catalog?.plugins.find(
    (plugin) => plugin.pluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  );
  const skillQualifiedNames = new Set(officialPlugin?.skillQualifiedNames ?? []);
  // 由 qualified 名截取冒号后的裸名，用于兼容元数据缺 qualifiedName 的旧 Skill。
  const skillBareNames = new Set(
    [...skillQualifiedNames]
      .map((name) => name.slice(name.indexOf(":") + 1))
      .filter((name) => name.length > 0),
  );
  const officialRootPath = officialPlugin?.rootPath;
  const officialPluginName = officialPlugin?.name;

  return {
    serverNames: new Set(officialServerNames),
    isOfficialToolRequest(name) {
      const normalized = name.trim();
      if (toolNames.has(normalized)) return true;
      // Parent MCP 尚无启动快照时，只能依赖已认证 server 的 namespace；一旦收到
      // descriptor，就收窄为精确工具集合，避免第三方同名工具被误判成官方 CUA。
      if (officialDescriptorCount > 0 || officialToolPrefixes.size === 0) return false;
      return [...officialToolPrefixes].some(
        (prefix) => normalized.startsWith(prefix) && normalized.length > prefix.length,
      );
    },
    // 仅接受 `mcp__<server>__*` 通配选择器；无官方 server 时短路返回 false。
    isOfficialServerSelector(name) {
      const normalized = name.trim();
      if (officialServerNames.size === 0) return false;
      if (!normalized.startsWith("mcp__") || !normalized.endsWith("__*")) return false;
      const serverPart = normalized.slice("mcp__".length, -"__*".length);
      return officialServerSelectorParts.has(serverPart);
    },
    isOfficialSkillRequest(name) {
      const normalized = name.trim();
      // Bare names are resolved against live Skill metadata below. Treating a bare
      // name as official here would reject a third-party Skill with the same name.
      return skillQualifiedNames.has(normalized);
    },
    // 三重校验：来源必须是 plugin、插件名一致、且路径落在官方插件 root 之下；
    // 任一项缺失（官方插件未安装、路径为空）都判为非官方，宁可漏判也不误杀第三方 Skill。
    isOfficialSkill(metadata) {
      if (metadata.source !== "plugin") return false;
      if (!officialPluginName || !officialRootPath) return false;
      if (metadata.pluginName !== officialPluginName) return false;
      if (!isPathWithin(officialRootPath, metadata.rootPath)) return false;
      return metadata.qualifiedName !== undefined
        ? skillQualifiedNames.has(metadata.qualifiedName)
        : skillBareNames.has(metadata.name);
    },
  };
}

// 判断 candidatePath 是否位于 rootPath 内：相对路径为空表示同一路径；
// 以 ".." 开头或解析成绝对路径（跨盘符/不同根）都视为外部路径。
// 只做词法比较，不访问文件系统，也不解析符号链接。
function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
