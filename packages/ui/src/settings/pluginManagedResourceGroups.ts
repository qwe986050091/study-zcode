// [模块] 插件管理资源分组层：把 describe/list 下发的 components 与 MCP 状态快照投影成 UI 分组视图
// [模块] 全部为纯数据整形，不发起 RPC、不写 store，调用方负责订阅与刷新时机
// [模块] 入参 plugins/skills/commands/servers 一律只读对待，返回新数组与新对象
// [模块] 稳定输出顺序本身是契约，轮询刷新时列表不得跳动，否则用户会误点相邻条目
// INV-01 分组键必须是组件 kind 而非数组下标；守住位置：describeResultToDisplayGroups 的 byKind 写入；改错故障：某类组件增删后其余分组名称与数量整体错位
// INV-02 展示顺序固定为 agent 到 command 到 skill 到 hook 到 mcp；守住位置：COMPONENT_KIND_ORDER；改错故障：不同入口的同一插件分组顺序不一致，用户以为装了两份
// INV-03 空分组必须被省略而不是渲染为 0 项；守住位置：items.length === 0 的 early continue；改错故障：详情弹窗出现空标题块，看起来像加载失败
// INV-04 分组数量取 items.length 而非协议自带计数；守住位置：count 字段赋值处；改错故障：数量与实际条目不符，用户按数量核对时判定插件损坏
// INV-05 description 为空时必须省略该键而非写入空串；守住位置：条件展开分支；改错故障：空描述被渲染成占位符并引起行高抖动
// INV-06 同一 kind 重复下发时后写覆盖前写，不得累加；守住位置：byKind.set 覆盖语义；改错故障：CLI 重试导致条目翻倍，用户看到重复资源
// INV-07 describe 与 list 两条数据源必须产出同构分组；守住位置：两个 build/describe 函数体；改错故障：同一插件在插件页与详情页显示不同条目集合
// INV-08 list 的 components 缺失时按空数组处理而不是抛错；守住位置：plugin.components 的空值回退；改错故障：旧版 CLI 场景下整页白屏
// INV-09 已安装分组严禁回退到 skillCount 加名称 join；守住位置：buildInstalledPluginDisplayGroups；改错故障：停用插件整组消失、启用插件只有数字没有名称
// INV-10 MCP 按 pluginId 聚合，不得按 pluginName 聚合；守住位置：groupPluginMcpServersByPlugin 的 Map 键；改错故障：同名不同市场的插件被合并，条目互相串台
// INV-11 待授权或报错的 MCP 必须前置且保持组内原始相对顺序；守住位置：toSorted 的 attention 比较；改错故障：需处理的服务器被长列表淹没，用户找不到授权入口
// INV-12 组内排序必须是稳定排序，用原始 index 兜底；守住位置：left.index 与 right.index 相减；改错故障：状态轮询刷新后同等优先级条目互换位置
// INV-13 组间按 pluginName 忽略大小写排序，保证跨平台一致；守住位置：localeCompare 的 sensitivity base；改错故障：Windows 与 macOS 列表顺序不同，截图对不上
// INV-14 查询归一为 trim 加小写，空白查询等价于不过滤；守住位置：normalizedQueryMatches 的 keyword 判空；改错故障：输入空格后列表清空，用户以为数据丢失
// INV-15 查询字段缺失时跳过而不是拼成字符串 undefined；守住位置：value 的可选链小写化；改错故障：搜索 undefined 会命中全部条目
// INV-16 技能去重键是反斜杠归一后的 lowercase path；守住位置：groupSkillsByPlugin 的 seenPaths；改错故障：Windows 上同一技能出现两条
// INV-17 技能去重发生在查询过滤之前，命中与否都占位；守住位置：两处 continue 的先后次序；改错故障：切换查询词时去重结果漂移，同一技能时隐时现
// INV-18 命令分流先判用户命令再判插件命令，且 agentSource 必须匹配；守住位置：groupCommandsByPlugin 首个条件；改错故障：插件命令混入本地列表，执行时来源错标
// INV-19 本地 MCP 仅保留 zcodeagentmcp 来源；守住位置：filterLocalMcpServers 的 source 判断；改错故障：外部来源服务器出现在本地页并被错误地允许授权
import type {
  PluginCommand,
  McpServerStatus,
  SkillSummary,
  UserCommand,
  ZCodeCommand,
  ZCodeMcpServer,
  ZCodeMcpServerStatusSnapshot,
  ZCodePluginInfo,
  ZCodePluginComponentKind,
  ZCodePluginsDescribeResult,
} from "@zcode/shared";
import { isPluginCommand, isUserCommand, ZCODE_COMMAND_AGENT_SOURCE } from "@zcode/shared";
import type { PluginComponentDisplayGroup } from "@/settings/PluginComponentGroups.js";

// [契约] 双桶结构把本地资源与插件资源分开，调用方无需再按 scope 自行过滤
// [不变量] 两桶元素顺序沿用入参顺序，UI 直接渲染即可保持稳定
// [权衡] 类型参数分离而非统一基类，允许 UserCommand 与 PluginCommand 各自保留判别字段
export interface ResourceGroups<TLocal, TPlugin> {
  local: TLocal[];
  plugin: TPlugin[];
}

/** 详情分组的展示顺序，与 describeResultToDisplayGroups / buildInstalledPluginDisplayGroups 一致。 */
// [不变量] 这是唯一顺序来源，新增 kind 必须在此登记，否则整类资源静默不可见
// [顺序] 与 describeResultToDisplayGroups、buildInstalledPluginDisplayGroups 共用同一常量
// [失败路径] 遗漏登记不会抛错只会丢组，需要测试断言分组数量兜底
const COMPONENT_KIND_ORDER: ZCodePluginComponentKind[] = [
  "agent",
  "command",
  "skill",
  "hook",
  "mcp",
];

/**
 * 把 plugins/describe 的按需结果映射为共享展示分组（名称+描述），并按固定顺序排序、
 * 省略空分组。数量取 items.length（describe 已是权威枚举）。
 */
// [契约] 输入是 plugins/describe 的权威枚举结果，数量语义以 items.length 为准
// [资源生命周期] 返回全新分组对象而不复用入参引用，避免调用方回写污染响应
// [性能] 单次遍历加一次定长映射，复杂度为条目数线性，可在每次打开详情时重算
export function describeResultToDisplayGroups(
  result: ZCodePluginsDescribeResult,
): PluginComponentDisplayGroup[] {
  const byKind = new Map<ZCodePluginComponentKind, PluginComponentDisplayGroup>();
  // [不变量] 空分组在此早退，后续映射不会产生 count 为 0 的占位项
  // [归一] 重复 kind 由 Map 覆盖语义收敛，等价于保留最后一次下发
  // [失败路径] items 缺失时直接抛错，宁可暴露协议违约也不静默兜底
  for (const group of result.components) {
    if (group.items.length === 0) continue;
    byKind.set(group.kind, {
      kind: group.kind,
      count: group.items.length,
      items: group.items.map((item) => ({
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      })),
    });
  }
  return COMPONENT_KIND_ORDER.map((kind) => byKind.get(kind)).filter(
    (group): group is PluginComponentDisplayGroup => group !== undefined,
  );
}

/**
 * 把 plugins/list 下发的权威 components（名称+描述）映射为共享展示分组，逻辑与
 * describeResultToDisplayGroups 一致：按固定顺序排序、省略空分组、数量取 items.length。
 *
 * 已安装详情弹窗过去用 buildPluginComponentGroups —— 数量取协议 skillCount、名称靠
 * UI 侧 join（skillsService 结果按 pluginName 过滤）。两数据源分离导致停用插件整组消失、
 * 启用插件只有数量没有名称。现在 CLI 已对插件根目录做权威枚举并随 list 下发 components，
 * 这里直接用它，彻底去掉脆弱的 join。
 */
// [契约] 与 describe 版本同构，保证详情弹窗与插件页复用同一渲染组件
// [权衡] 依赖 CLI 随 list 下发 components，放弃旧 join 换取停用插件也能列出名称
// [失败路径] components 缺失时退化为空列表而非回查 skillsService，避免二次请求与竞态
export function buildInstalledPluginDisplayGroups(
  plugin: ZCodePluginInfo,
): PluginComponentDisplayGroup[] {
  const byKind = new Map<ZCodePluginComponentKind, PluginComponentDisplayGroup>();
  // [不变量] 缺省值必须是空数组，null 与 undefined 走同一分支
  // [顺序] 遍历顺序不参与最终排序，输出顺序完全由 COMPONENT_KIND_ORDER 决定
  // [归一] 数量只数实际条目，不信任上层携带的聚合计数
  for (const group of plugin.components ?? []) {
    if (group.items.length === 0) continue;
    byKind.set(group.kind, {
      kind: group.kind,
      count: group.items.length,
      items: group.items.map((item) => ({
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      })),
    });
  }
  return COMPONENT_KIND_ORDER.map((kind) => byKind.get(kind)).filter(
    (group): group is PluginComponentDisplayGroup => group !== undefined,
  );
}

export interface PluginMcpServerItem {
  active: boolean;
  authorization?: ZCodeMcpServerStatusSnapshot["authorization"];
  error?: string;
  failureKind?: ZCodeMcpServerStatusSnapshot["failureKind"];
  id: string;
  hostProvided?: boolean;
  name: string;
  pluginEnabled: boolean;
  pluginId: string;
  pluginMarketplace: string;
  pluginName: string;
  runtimeServerName: string;
  serverRequestId?: string;
  status?: McpServerStatus;
  toolCount?: number;
}

export interface PluginMcpServerGroup {
  items: PluginMcpServerItem[];
  pluginId: string;
  pluginName: string;
}

// [契约] 组内先按需处理状态前置、组间按插件名排序，两层排序各自独立
// [资源生命周期] 只重排引用不复制 server 对象，下游比对引用即可判断是否同一实例
// [性能] 先聚合再排序，避免对全部条目做全局比较，复杂度为 n log n
// [失败路径] pluginName 缺失会产生空字符串键，组间排序退化为稳定插入序
export function groupPluginMcpServersByPlugin(
  items: readonly PluginMcpServerItem[],
): PluginMcpServerGroup[] {
  // [不变量] 键是 pluginId，同名但不同市场的插件因此不会被合并
  // [并发] 首次出现即建组回写，同键后续条目复用同一对象，组内顺序即入参顺序
  // [归一] 组名取首个条目的 pluginName，同组后续条目的同名字段被忽略
  const groups = new Map<string, PluginMcpServerGroup>();
  for (const item of items) {
    const group = groups.get(item.pluginId) ?? {
      items: [],
      pluginId: item.pluginId,
      pluginName: item.pluginName,
    };
    group.items.push(item);
    groups.set(item.pluginId, group);
  }
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      items: group.items
        .map((item, index) => ({ index, item }))
        .toSorted((left, right) => {
          const leftAttention = Boolean(
            left.item.authorization?.authorizationUrl || left.item.status === "error",
          );
          const rightAttention = Boolean(
            right.item.authorization?.authorizationUrl || right.item.status === "error",
          );
          return Number(rightAttention) - Number(leftAttention) || left.index - right.index;
        })
        .map(({ item }) => item),
    }))
    .toSorted((left, right) =>
      left.pluginName.localeCompare(right.pluginName, undefined, {
        sensitivity: "base",
      }),
    );
}

// [归一] 查询先 trim 再小写，前后空格与大小写都不影响命中
// [不变量] 空查询返回 true 表示不过滤，而不是匹配空串
// [失败路径] 字段为 undefined 时跳过，避免字面量 undefined 被当作关键词命中
function normalizedQueryMatches(query: string, values: readonly (string | undefined)[]): boolean {
  const keyword = query.trim().toLowerCase();
  if (!keyword) {
    return true;
  }
  return values.some((value) => value?.toLowerCase().includes(keyword));
}

// [契约] 先按路径去重再按查询过滤，去重结果不随查询词变化
// [并发] skills 由多次加载合并而来，重复路径视为同一技能且只保留首个
// [顺序] 两个桶都保持入参相对顺序，不额外排序，展示策略交给调用方
// [失败路径] scope 非 plugin 一律归入本地桶，未知 scope 不会静默丢失
export function groupSkillsByPlugin(
  skills: SkillSummary[],
  query: string,
): ResourceGroups<SkillSummary, SkillSummary> {
  // [归一] 路径先把反斜杠转正斜杠再转小写，Windows 与 POSIX 视为同一键
  // [资源生命周期] 集合仅在本函数内存活不跨调用缓存，避免陈旧路径导致误去重
  // [权衡] 按路径而非名称去重，同名但不同目录的技能都能保留
  const seenPaths = new Set<string>();
  const local: SkillSummary[] = [];
  const plugin: SkillSummary[] = [];
  for (const skill of skills) {
    const normalizedPath = skill.path.replaceAll("\\", "/").toLowerCase();
    if (seenPaths.has(normalizedPath)) {
      continue;
    }
    seenPaths.add(normalizedPath);
    if (!normalizedQueryMatches(query, [skill.name, skill.description, skill.pluginName])) {
      continue;
    }
    if (skill.scope === "plugin") {
      plugin.push(skill);
    } else {
      local.push(skill);
    }
  }
  return { local, plugin };
}

// [契约] 用户命令需同时满足类型判别与 agentSource 匹配，二者缺一即落选
// [顺序] 单次遍历完成分流，本地与插件两桶各自保持入参顺序
// [失败路径] 两类判别都不成立时该条目被丢弃，不进入任何桶
export function groupCommandsByPlugin(
  commands: ZCodeCommand[],
  query: string,
): ResourceGroups<UserCommand, PluginCommand> {
  const local: UserCommand[] = [];
  const plugin: PluginCommand[] = [];
  for (const command of commands) {
    if (
      isUserCommand(command) &&
      command.agentSource === ZCODE_COMMAND_AGENT_SOURCE &&
      normalizedQueryMatches(query, [command.name, command.description, command.prompt])
    ) {
      local.push(command);
      continue;
    }
    if (
      isPluginCommand(command) &&
      normalizedQueryMatches(query, [
        command.name,
        command.description,
        command.prompt,
        command.pluginName,
      ])
    ) {
      plugin.push(command);
    }
  }
  return { local, plugin };
}

// [不变量] 只放行 zcodeagentmcp 来源，其余来源即使名称匹配也不展示
// [失败路径] config 缺少 url 或 command 时仍参与匹配，靠可选链避免抛错
// [性能] 单次 filter 加字段拼装无中间数组，适合每次输入变化时实时调用
export function filterLocalMcpServers(servers: ZCodeMcpServer[], query: string): ZCodeMcpServer[] {
  return servers.filter((server) => {
    if (server.source !== "zcodeagentmcp") {
      return false;
    }
    return normalizedQueryMatches(query, [server.name, server.config.url, server.config.command]);
  });
}

// [契约] 每个插件展开为其 MCP 名并集，输出扁平数组供上层再按插件分组
// [归一] 状态快照缺省为空对象，插件未启用时不读 runtime 状态，避免展示陈旧错误
// [不变量] id 由 pluginId 与展示名拼成，保证跨插件全局唯一
export function buildPluginMcpServerItems(
  plugins: ZCodePluginInfo[],
  query: string,
  statusSnapshots: Record<string, ZCodeMcpServerStatusSnapshot> = {},
): PluginMcpServerItem[] {
  return plugins.flatMap((plugin) => {
    // [不变量] 宿主提供的 MCP 不参与插件前缀改写，runtime 名即展示名
    // [归一] 三类来源合并去重，声明名与运行时名映射到同一展示名
    // [失败路径] 声明名缺失时回退到 mcpServerNames，兼容旧版插件清单
    const hostNames = new Set(plugin.hostMcpServerNames ?? []);
    const activeNames = new Set(plugin.mcpServerNames);
    const activeDisplayNames = new Set(
      plugin.mcpServerNames.flatMap((serverName) => [
        serverName,
        toPluginMcpServerDisplayName(plugin, serverName),
      ]),
    );
    const declaredNames = (plugin.declaredMcpServerNames ?? plugin.mcpServerNames).map(
      (serverName) => toPluginMcpServerDisplayName(plugin, serverName),
    );
    // MCP 管理页要展示插件内置 MCP，即使插件当前未启用也应能看出来源。
    // mcpServerNames 仍表示 runtime 已注入的 MCP；declaredMcpServerNames 只用于只读展示。
    // 插件 MCP 注入 runtime 时会加 plugin:<插件名>: 前缀，展示层需要用声明名判定 active，避免误报“未加载”。
    const serverNames = Array.from(
      new Set([
        ...hostNames,
        ...declaredNames,
        ...plugin.mcpServerNames.map((serverName) =>
          toPluginMcpServerDisplayName(plugin, serverName),
        ),
      ]),
    );
    return serverNames
      .filter((serverName) => normalizedQueryMatches(query, [serverName, plugin.name, plugin.id]))
      .map((serverName) => {
        const hostProvided = hostNames.has(serverName);
        const runtimeServerName = hostProvided
          ? serverName
          : resolvePluginMcpRuntimeServerName(plugin, serverName);
        const mappedStatus =
          hostProvided || plugin.enabled
            ? mapPluginRuntimeStatus(statusSnapshots[runtimeServerName])
            : {};
        return {
          ...mappedStatus,
          active: hostProvided || activeNames.has(serverName) || activeDisplayNames.has(serverName),
          id: `${plugin.id}:${serverName}`,
          ...(hostProvided ? { hostProvided: true } : {}),
          name: serverName,
          pluginEnabled: plugin.enabled,
          pluginId: plugin.id,
          pluginMarketplace: plugin.marketplace,
          pluginName: plugin.name,
          runtimeServerName,
        };
      });
  });
}

// [归一] 仅剥离本插件自己的 plugin 前缀，其他前缀原样保留
// [不变量] 无前缀时原样返回，同一输入恒得同一输出
// [失败路径] 插件名含冒号时按最长字面前缀匹配，不会误切中间片段
function toPluginMcpServerDisplayName(plugin: ZCodePluginInfo, serverName: string): string {
  const namespacePrefix = `plugin:${plugin.name}:`;
  return serverName.startsWith(namespacePrefix)
    ? serverName.slice(namespacePrefix.length)
    : serverName;
}

// [契约] 优先返回 runtime 实际注入名，找不到时按约定拼接前缀
// [归一] 比较时同时接受原名与剥离前缀后的展示名，容忍上游两种写法
// [失败路径] 未命中会生成推测名，取不到快照时降级为无状态而非报错
function resolvePluginMcpRuntimeServerName(plugin: ZCodePluginInfo, displayName: string): string {
  const activeName = plugin.mcpServerNames.find(
    (serverName) =>
      serverName === displayName ||
      toPluginMcpServerDisplayName(plugin, serverName) === displayName,
  );
  return activeName ?? `plugin:${plugin.name}:${displayName}`;
}

// [契约] 把协议状态收敛为 UI 可渲染字段，未知状态返回空对象交调用方兜底
// [归一] failed 映射为 error 并补默认文案，disabled 与 untrusted 映射为 unknown
// [不变量] 显式字段挑选而非整体展开，防止协议新增字段泄漏进 UI 契约
function mapPluginRuntimeStatus(
  snapshot: ZCodeMcpServerStatusSnapshot | undefined,
): Pick<
  PluginMcpServerItem,
  "authorization" | "error" | "failureKind" | "serverRequestId" | "status" | "toolCount"
> {
  if (!snapshot) {
    return {};
  }

  switch (snapshot.status) {
    case "connected":
    case "connecting":
      return {
        authorization: snapshot.authorization,
        status: snapshot.status,
        toolCount: snapshot.toolCount,
      };
    case "disconnected":
      return {
        authorization: snapshot.authorization,
        error: snapshot.error,
        failureKind: snapshot.failureKind,
        serverRequestId: snapshot.serverRequestId,
        status: snapshot.status,
        toolCount: snapshot.toolCount,
      };
    case "failed":
      return {
        error: snapshot.error ?? "MCP server failed",
        failureKind: snapshot.failureKind ?? "connection_failed",
        serverRequestId: snapshot.serverRequestId,
        status: "error",
        toolCount: snapshot.toolCount,
      };
    case "disabled":
      return {
        error: snapshot.error,
        failureKind: snapshot.failureKind,
        serverRequestId: snapshot.serverRequestId,
        status: "unknown",
        toolCount: snapshot.toolCount,
      };
    case "untrusted":
      return {
        error: snapshot.error ?? "Project MCP server requires explicit connection before use.",
        failureKind: snapshot.failureKind ?? "status_unavailable",
        serverRequestId: snapshot.serverRequestId,
        status: "unknown",
        toolCount: snapshot.toolCount,
      };
  }
}
