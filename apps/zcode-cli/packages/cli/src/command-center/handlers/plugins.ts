// INV-01 list 与 status 共用同一面板出口：守住位置 分支合并；改错故障 两种展示口径漂移。
// INV-02 未知动作回落用法提示：守住位置 末尾返回；改错故障 拼错子命令被静默执行。
// INV-03 enable 与 disable 只接受一个插件名：守住位置 参数解构；改错故障 多余参数被忽略。
// INV-04 变更只对新会话生效且文案必须声明：守住位置 结果文案；改错故障 用户以为当前会话已生效。
// INV-05 变更成功后重新取列表刷新选择器：守住位置 二次调用；改错故障 面板停留在旧状态。
// INV-06 选择器命令按当前启用态生成 toggle：守住位置 命令拼接；改错故障 回车执行相反动作。
// INV-07 卸载必须显式 force 闸门：守住位置 确认分支；改错故障 一次输入即不可逆删除。
// INV-08 force 与短标志等价且不当作插件名：守住位置 参数过滤；改错故障 把标志当插件名。
// INV-09 卸载拒绝多余参数：守住位置 过滤后计数；改错故障 误删非目标插件。
// INV-10 卸载成功后重建选择器：守住位置 条件展开；改错故障 列表残留已删插件。
// INV-11 能力缺失统一回复并保留 mode：守住位置 unavailable；改错故障 前端模式与其他响应不一致。
// INV-12 选择器按 id 排序：守住位置 排序调用；改错故障 相同数据顺序抖动。
// INV-13 未命中时索引回退 0：守住位置 Math.max；改错故障 选择器落在非法位置。
// INV-14 关键字覆盖多个展示字段：守住位置 keywords 数组；改错故障 别名搜索不命中。
// INV-15 空列表给出明确空态文案：守住位置 空值分支；改错故障 面板空白无提示。
// INV-16 副标题固定六段且缺失有占位：守住位置 pluginMeta；改错故障 文案缺段产生歧义。
// INV-17 概要展示启用数与总数：守住位置 统计调用；改错故障 用户无法判断全局状态。
// INV-18 错误只转可读文本不向上抛：守住位置 两处捕获；改错故障 命令中心收到异常。
//
// 模块职责：实现 /plugins 的列表、启停与卸载子命令，并构造插件选择器。
// 状态所有权：无状态；插件事实来自 app 端口，本文件只做展示转换。
// 阅读顺序：先看主分派，再读卸载闸门，最后看选择器与文案格式化。
import type { TuiSelection, TuiSubmitPromptResult } from "@zcode/tui";
import { resolvePluginDisplayName } from "@zcode/shared";
import type {
  CommandCenterDeps,
  CommandCenterPluginListOutcome,
  CommandCenterPluginSetResult,
} from "../types.js";
import { splitArgs } from "../utils.js";

// /plugins 用法提示；动作为 list/status/enable/disable/uninstall，未知动作回落到该文案。
const PLUGINS_COMMAND_USAGE =
  "Usage: /plugins [list|enable <plugin>|disable <plugin>|uninstall <plugin> --force]";
// 选择器中的启用/禁用标记，分别对应可切换状态，保持列表视觉一致。
const ENABLED_MARK = "✓";
const DISABLED_MARK = "○";

// 处理 /plugins：list/status 展示插件面板；enable/disable 切换启用状态并刷新面板；
// uninstall 需显式 --force 确认（斜杠命令无法交互 y/N）。
// 所有变更仅对「新会话」生效（已运行会话持有旧配置快照）；失败返回可读文本，不抛出。
// 先取 app，再解析子命令。
// 缺省动作是 list。
// list 与 status 走同一分支。
// enable 与 disable 共用一个切换流程。
// uninstall 单独校验确认闸门。
export async function handlePluginsCommand(
  args: string,
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  const tokens = splitArgs(args);
  const action = tokens[0] ?? "list";

  // list/status 分支先查 app.listPlugins：能力缺失时 unavailable(deps) 统一保留 deps.getMode?.()，
  // 前端才能把错误和自己的模式对齐；outcome 同时喂给 formatPluginsPanelResponse 与 buildPluginsSelection，
  // 一次请求生成文本与选择器，避免两处口径漂移；selectedPluginId 传 undefined，选择器按 Math.max(0,-1) 落到第 0 项。
  if (action === "list" || action === "status") {
    if (!app.listPlugins) {
      return unavailable(deps);
    }
    const outcome = await app.listPlugins();
    return {
      mode: deps.getMode?.(),
      response: formatPluginsPanelResponse(outcome),
      selection: buildPluginsSelection(outcome, undefined, deps.getLocale?.() ?? "en-US"),
    };
  }

  if (action === "enable" || action === "disable") {
    const [, plugin, extra] = tokens;
    if (!plugin || extra) {
      return {
        mode: deps.getMode?.(),
        response: PLUGINS_COMMAND_USAGE,
      };
    }
    if (!app.setPluginEnabled || !app.listPlugins) {
      return unavailable(deps);
    }
    try {
      const result = await app.setPluginEnabled(plugin, action === "enable");
      const outcome = await app.listPlugins();
      return {
        mode: deps.getMode?.(),
        response: formatPluginSetResult(result),
        selection: buildPluginsSelection(
          outcome,
          result.plugin.id,
          deps.getLocale?.() ?? "en-US",
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        mode: deps.getMode?.(),
        response: `Unable to update plugin ${plugin}: ${message}`,
      };
    }
  }

  if (action === "uninstall") {
    return await handlePluginsUninstall(tokens, deps, app);
  }

  return {
    mode: deps.getMode?.(),
    response: PLUGINS_COMMAND_USAGE,
  };
}

// 处理 uninstall 子命令：解析 --force/-f 与插件名，拒绝多余参数；
// 无 --force 时只返回确认指引，避免一次输入即不可逆删除缓存、数据与配置。
// handlePluginsUninstall 把 tokens.slice(1) 后的首个非 --force/-f 参数当作 plugin，其余全部计入 extras：
// !plugin || extras.length > 0 都回用法，防止误删非目标插件；force 只认 --force 与 -f 两种写法，
// 二者既参与判定又被 find/filter 排除，所以不会被当成插件名；无 force 时只返回确认指引，不触碰 uninstallPlugin。
async function handlePluginsUninstall(
  tokens: string[],
  deps: CommandCenterDeps,
  app: Awaited<ReturnType<CommandCenterDeps["getApp"]>>,
): Promise<TuiSubmitPromptResult> {
  const rest = tokens.slice(1);
  const force = rest.includes("--force") || rest.includes("-f");
  const plugin = rest.find((token) => token !== "--force" && token !== "-f");
  const extras = rest.filter(
    (token) => token !== "--force" && token !== "-f" && token !== plugin,
  );
  if (!plugin || extras.length > 0) {
    return {
      mode: deps.getMode?.(),
      response: PLUGINS_COMMAND_USAGE,
    };
  }
  if (!app.uninstallPlugin) {
    return unavailable(deps);
  }
  // 斜杠命令是无状态的，无法做交互式 y/N；卸载这种破坏性操作改用显式 --force 作为确认闸门。
  if (!force) {
    return {
      mode: deps.getMode?.(),
      response: `Uninstalling ${plugin} removes its cache, data, and saved config. Re-run with: /plugins uninstall ${plugin} --force`,
    };
  }
  try {
    const result = await app.uninstallPlugin(plugin);
    const outcome = await app.listPlugins?.();
    return {
      mode: deps.getMode?.(),
      response: result.removed
        ? `Uninstalled plugin ${result.removed.id}. Changes apply to new sessions.`
        : `Plugin not installed: ${plugin}`,
      ...(outcome
        ? {
            selection: buildPluginsSelection(
              outcome,
              undefined,
              deps.getLocale?.() ?? "en-US",
            ),
          }
        : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: deps.getMode?.(),
      response: `Unable to uninstall plugin ${plugin}: ${message}`,
    };
  }
}

// 能力缺失时的统一响应：保持 mode 字段以便前端同步当前模式。
function unavailable(deps: CommandCenterDeps): TuiSubmitPromptResult {
  return {
    mode: deps.getMode?.(),
    response: "Plugin management is not available in this client.",
  };
}

// 构造插件选择器：按 id 排序保证稳定；每项 command 依据当前状态生成 toggle 动作，
// keywords 覆盖 id/名称/展示名/市场/来源/描述/MCP 名以提升模糊匹配命中率。
// selectedPluginId 未命中时回退索引 0（Math.max 防 -1），避免选择器落在非法位置。
// 先按 `id` 排序，保证相同输入产生相同顺序。
// 每项 `command` 按当前启用态生成 toggle 动作，不缓存构造期快照。
// `keywords` 覆盖 `id` 与各展示字段，所以模糊匹配能命中别名。
// pending 文案与实际动作一致。
// 未命中时回退到第一项。
function buildPluginsSelection(
  outcome: CommandCenterPluginListOutcome,
  selectedPluginId?: string,
  locale = "en-US",
): TuiSelection {
  const plugins = [...outcome.plugins].sort((left, right) => left.id.localeCompare(right.id));
  return {
    emptyMessage: "No plugins found.",
    help: "Type to filter, Up/Down choose, Enter toggles, Esc closes",
    items: plugins.map((plugin) => {
      const displayName = resolvePluginDisplayName(
        {
          name: plugin.name,
          listing: outcome.pluginListingsById?.[plugin.id],
        },
        locale,
      );
      return {
        command: `/plugins ${plugin.enabled ? "disable" : "enable"} ${plugin.id}`,
        id: plugin.id,
        keywords: [
          plugin.id,
          plugin.name,
          displayName,
          plugin.marketplace,
          plugin.source,
          plugin.description ?? "",
          ...plugin.mcpServerNames,
        ],
        meta: pluginMeta(plugin),
        pending: {
          primary: `${plugin.enabled ? "Disabling" : "Enabling"} ${displayName}`,
          secondary: plugin.id,
          status: `${plugin.enabled ? "Disabling" : "Enabling"} plugin...`,
        },
        primary: `${plugin.enabled ? ENABLED_MARK : DISABLED_MARK} ${displayName}`,
        secondary: plugin.id,
      };
    }),
    placement: "composer",
    prompt: "Choose a plugin to toggle.",
    selectedIndex: Math.max(0, plugins.findIndex((plugin) => plugin.id === selectedPluginId)),
    title: "Plugins",
  };
}

// 插件副标题元信息：启用态、来源/市场、版本（无版本显示 unversioned）、技能/命令数量与 MCP 名。
// 版本缺失显示 unversioned。
// MCP 名称以逗号连接。
// 无 MCP 时显示 no mcp。
// 六段固定顺序用竖线连接。
function pluginMeta(plugin: CommandCenterPluginListOutcome["plugins"][number]): string {
  const version = plugin.version ? `v${plugin.version}` : "unversioned";
  const mcp = plugin.mcpServerNames.length > 0 ? plugin.mcpServerNames.join(",") : "no mcp";
  return [
    plugin.enabled ? "enabled" : "disabled",
    `${plugin.source}/${plugin.marketplace}`,
    version,
    `${plugin.skillCount} skill`,
    `${plugin.commandRootCount} command`,
    mcp,
  ].join(" | ");
}

// 面板概要：空列表明确提示；否则给出「启用数/总数」并说明变更只对新会话生效。
function formatPluginsPanelResponse(outcome: CommandCenterPluginListOutcome): string {
  if (outcome.plugins.length === 0) return "No plugins found.";
  const enabledCount = outcome.plugins.filter((plugin) => plugin.enabled).length;
  return `Plugins: ${enabledCount}/${outcome.plugins.length} enabled. Changes apply to new sessions.`;
}

// 切换结果文本：按 result.enabled 选择动词，并提示配置在下一个会话生效。
function formatPluginSetResult(result: CommandCenterPluginSetResult): string {
  const verb = result.enabled ? "Enabled" : "Disabled";
  return `${verb} plugin ${result.plugin.id}. Changes apply to new sessions.`;
}
