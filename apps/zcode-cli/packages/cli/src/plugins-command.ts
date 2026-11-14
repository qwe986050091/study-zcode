// INV-01 缺省子命令必须是只读 list —— 守住位置：args 解构的默认值，改错故障：默认值换成 install 或 uninstall 会让手误产生真实磁盘删改。
// INV-02 子命令分发只此一处 —— 守住位置：runPluginsCommand 的 switch，改错故障：绕开它另开入口会让 usage 与真实命令集合漂移。
// INV-03 list 不接受位置参数 —— 守住位置：rest.length 检查，改错故障：多余参数被忽略后用户以为过滤生效，实际列出全量。
// INV-04 退出码由 error 级诊断唯一决定 —— 守住位置：hasErrors 折算点，改错故障：warning 被当失败会让正常安装返回 1，CI 误红。
// INV-05 孤儿诊断不得静默吞掉 —— 守住位置：orphaned 过滤与 stderr 写出，改错故障：市场索引损坏时脚本读到空列表却以为成功。
// INV-06 插件名歧义必须报错而非任选 —— 守住位置：matches.length 判定，改错故障：同名插件装错市场，用户排查成本极高。
// INV-07 install 的 scope 缺省回落 user —— 守住位置：resolveScope 结果与 user 兜底，改错故障：缺省层级随环境漂移，配置写进不可预期位置。
// INV-08 update 的 --scope 只做拼写校验 —— 守住位置：单独调用 resolveScope 后丢弃结果，改错故障：误把插件迁移到另一层级，旧目录残留。
// INV-09 uninstall 在非 TTY 且无 --force 时一律拒绝 —— 守住位置：isTTY 与 force 的联合判定，改错故障：管道或 CI 中静默删掉插件。
// INV-10 用户拒绝确认按成功退出 —— 守住位置：confirmed 为假的提前返回 0，改错故障：交互取消被脚本判为失败并触发告警。
// INV-11 --all 与位置参数、--scope 互斥 —— 守住位置：进入分支前的两道 usage 校验，改错故障：用户点名的插件被批量停用，语义相悖。
// INV-12 批量停用单条失败不中断 —— 守住位置：逐条 try 内的 catch，改错故障：一个坏条目使剩余插件保持启用，状态半新半旧。
// INV-13 停用是否成功以 effective 态复查 —— 守住位置：stillEnabled 的二次列举，改错故障：高优先级层强制启用的插件被谎报停用成功。
// INV-14 validate 严格只读 —— 守住位置：validatePluginPath 单一调用，改错故障：校验顺手写入缓存或配置，破坏只读契约。
// INV-15 本文件不持有业务状态 —— 守住位置：仅做参数收窄、确认交互与格式化，改错故障：状态出现第二个所有者，与服务层长期不一致。
// INV-16 所有副作用经 deps 注入 —— 守住位置：resolveDep 取服务而非直接读写磁盘，改错故障：绕过统一入口后无法审计、替换与测试。
// INV-17 只有 PluginsUsageError 走 usage 分支 —— 守住位置：instanceof 判定，改错故障：服务层异常被当成用法错误，丢失堆栈与 cause。
// INV-18 usage 文本必须与 switch 同步 —— 守住位置：PLUGINS_COMMAND_USAGE 常量，改错故障：帮助里列不出新命令，用户只能靠猜。
//
// 模块职责：plugins 子命令的入口、参数校验、确认交互与结果格式化，安装启停卸载的真实副作用全部委托 @zcode/bootstrap。
// 状态所有权：插件目录、启用配置与市场索引归服务层，本文件只读结果并折算退出码，不缓存任何跨调用状态。
// 阅读顺序：runPluginsCommand 分发 → list → install → update → reportInstallOutcome → set → disable → uninstall → validate。
// `zcode plugins` 命令实现：list/install/uninstall/enable/disable/update/validate 的分发与输出。
// 插件安装、启停与卸载的实际副作用由 @zcode/bootstrap 承担；本层负责参数校验、确认交互与结果格式化。
import { formatJson } from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import type { SetZCodePluginEnabledResult, ZCodePluginInstallData } from "@zcode/bootstrap";
import {
  formatAvailablePluginJson,
  formatDiagnosticJson,
  formatDiagnosticLines,
  formatHumanAvailableList,
  formatHumanPluginList,
  formatHumanPluginSet,
  formatHumanPluginUninstall,
  formatInstalledPluginJson,
  formatPluginJson,
  formatPluginSetJson,
  writeWarnings,
} from "./plugins-command-format.js";
import {
  ambiguousPluginError,
  baseOptions,
  confirmUninstall,
  hasErrors,
  type PluginListItem,
  PluginsUsageError,
  reportPluginsError,
  requireOne,
  resolveDep,
  resolveLoadedPluginId,
  resolveScope,
  splitPluginIdentifier,
  type PluginsCommandDependencies,
  type PluginsCommandFlags,
} from "./plugins-command-shared.js";
import { runMarketplaceCommand } from "./plugins-marketplace-command.js";

export type {
  PluginsCommandDependencies,
  PluginsCommandFlags,
  PluginsCommandOverrides,
} from "./plugins-command-shared.js";

// 帮助文本；子命令与选项变更时必须同步更新，PluginsUsageError 会原样打印这段内容。
const PLUGINS_COMMAND_USAGE = `Usage: zcode plugins <command> [options]

Commands:
  list [--json] [--available]                  List installed plugins; --available also lists the marketplace catalog
  install <plugin>[@marketplace] [-s <scope>]  Install a plugin from a known marketplace
  uninstall <plugin> [-s <scope>] [--keep-data] [--force]
                                               Uninstall a plugin (--keep-data keeps its data directory)
  enable <plugin> [-s <scope>]                 Enable a plugin
  disable [plugin] [-a|--all] [-s <scope>]     Disable a plugin, or every enabled plugin with --all
  update <plugin> [-s <scope>]                 Update a plugin to the latest marketplace version
  validate <path>                              Validate a plugin or marketplace manifest
  marketplace add <source> [--scope <scope>] [--sparse <path>]
                                               Add a marketplace from a URL, path, or GitHub repo
  marketplace list [--json]                    List configured marketplaces
  marketplace remove <name>                    Remove a configured marketplace
  marketplace update [name]                    Refresh one marketplace, or all when omitted

Scopes: user (default), project. \`zcode plugin\` is an alias of \`zcode plugins\`.`;

// 分发并执行 plugins 子命令。
// 输入：args[0] 为子命令（缺省 list），其余为参数；flags 携带 --scope/--all/--force 等共享开关。
// 输出：退出码 0 成功、1 失败；参数错误抛 PluginsUsageError 并在本层兜底打印 usage。
// 副作用：按子命令增删插件与配置（落盘），并写 stdout/stderr。
// 失败语义：只有 PluginsUsageError 走 usage 分支，其它异常交给 reportPluginsError 统一报告（含 --verbose 栈）。
export async function runPluginsCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  args: string[],
  flags: PluginsCommandFlags = {},
): Promise<number> {
  // 无参数时默认 list：只读动作作为缺省，避免用户手误触发安装或卸载。
  const [subcommand = "list", ...rest] = args;
  try {
    // 分发是唯一入口：每个 case 只收敛参数并立刻 return，不在 switch 内累积状态。
    // 新增子命令必须同时改 PLUGINS_COMMAND_USAGE 与本 switch，否则用户只能看到 Unknown plugins command。
    //
    // requireOne 把位置参数收敛成单个值，多传或漏传都以 usage 错误暴露，避免半个参数被服务层误解释。
    // default 分支不猜测意图而直接抛 usage：拼错的命令名若被当作插件名，可能触发误装。
    switch (subcommand) {
      case "list":
        if (rest.length > 0) throw new PluginsUsageError();
        return await runPluginsListCommand(ctx, options, deps, flags);
      case "install":
        return await runPluginsInstallCommand(ctx, options, deps, flags, requireOne(rest));
      case "uninstall":
        return await runPluginsUninstallCommand(ctx, options, deps, flags, requireOne(rest));
      case "enable":
        return await runPluginsSetCommand(ctx, options, deps, flags, requireOne(rest), true);
      case "disable":
        return await runPluginsDisableCommand(ctx, options, deps, flags, rest);
      case "update":
        return await runPluginsUpdateCommand(ctx, options, deps, flags, requireOne(rest));
      case "validate":
        return await runPluginsValidateCommand(ctx, options, deps, requireOne(rest));
      case "marketplace":
        return await runMarketplaceCommand(ctx, options, deps, flags, rest);
      default:
        throw new PluginsUsageError(`Unknown plugins command: ${subcommand}`);
    }
  } catch (error) {
    // 用法错误单独处理：附带完整 usage，便于用户直接照着改命令；其它错误保留各自上下文。
    // 错误边界只拦 usage 一类：usage 由本层补全命令帮助，用户可直接照抄修正后的命令。
    // 其余异常原样交给 reportPluginsError，保留 --verbose 下的堆栈与 cause 链，便于定位服务层问题。
    //
    // 这里返回数字退出码而不向上抛，保证 CLI 入口只做一次收口，同一错误不会被打印两遍。
    if (error instanceof PluginsUsageError) {
      ctx.stderr.write(`${error.message ? `${error.message}\n` : ""}${PLUGINS_COMMAND_USAGE}\n`);
      return 1;
    }
    return reportPluginsError(ctx, options, error);
  }
}

// 列出已安装插件；--available 时额外合并市场目录。
// 输入：flags.available 控制是否附市场清单。
// 输出：0 成功；若存在"归不到任何已安装插件的 error 级诊断"则写 stderr 并返回 1。
// 副作用：仅读取插件与市场数据并输出，不修改任何持久化状态。
async function runPluginsListCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  flags: PluginsCommandFlags,
): Promise<number> {
  const base = baseOptions(deps);
  const outcome = (await resolveDep(deps, "listPlugins"))(base);
  const installed = outcome.plugins.map((plugin) => formatPluginJson(plugin, outcome.diagnostics));
  // 不带 --available 时走纯只读分支：只取已安装列表，不触碰市场目录，离线环境也不会多打一次网络。
  //
  // 格式化细节全部留在 plugins-command-format，本层只决定走 JSON 还是人类可读形态。
  // 两种形态共用同一份 outcome，保证 JSON 与文本看到的是同一批条目与诊断。
  // 差异仅在呈现，本分支不得顺手写入任何持久化状态。
  if (!flags.available) {

    ctx.stdout.write(
      options.json ? formatJson(installed) : formatHumanPluginList(outcome, options),
    );
    // 市场刷新失败这类诊断的 pluginId 是市场 id 或为空，归不到任何条目；error 级不能静默丢掉。
    const knownIds = new Set(outcome.plugins.map((plugin) => plugin.id));
    const orphaned = outcome.diagnostics.filter(
      (diagnostic) =>
        diagnostic.severity === "error" && !(diagnostic.pluginId && knownIds.has(diagnostic.pluginId)),
    );
    // 孤儿诊断仍要退出码 1：脚本只读 stdout 时否则会误判为全部成功。
    // 只有完全干净才返回 0：孤儿 error 诊断意味着市场或索引已损坏，静默成功会让脚本误判为全部正常。
    //
    // 已知 pluginId 的诊断已挂在对应条目上，这里只挑归不到条目的部分，避免同一问题刷两遍。
    // 判据是 severity 为 error 且 pluginId 缺失或不属于当前列表，只看已安装集合而不猜市场 id 的归属。
    if (orphaned.length === 0) return 0;
    ctx.stderr.write(formatDiagnosticLines(orphaned));
    return 1;
  }
  const overview = (await resolveDep(deps, "getPluginsOverview"))(base);
  if (options.json) {
    ctx.stdout.write(
      formatJson({
        installed,
        available: overview.availablePlugins.map(formatAvailablePluginJson),
        diagnostics: [...outcome.diagnostics, ...overview.diagnostics].map(formatDiagnosticJson),
      }),
    );
    return 0;
  }
  ctx.stdout.write(
    `${formatHumanPluginList(outcome, options)}\n${formatHumanAvailableList(overview.availablePlugins)}`,
  );
  return 0;
}

// 安装插件：`<name>` 或 `<name>@<marketplace>` 两种写法。
// 输入：identifier 单个位置参数；flags.scope 缺省为 user。
// 输出：复用 reportInstallOutcome 的退出码（0 成功，1 有 error 级诊断）。
// 副作用：写入插件目录与启用配置（由服务层完成）。
// 消歧义：未写 marketplace 时按名字在市场目录中查找，命中多个则报歧义错误而不是任选其一。
async function runPluginsInstallCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  flags: PluginsCommandFlags,
  identifier: string,
): Promise<number> {
  const scope = resolveScope(flags.scope) ?? "user";
  const base = baseOptions(deps);
  const { name } = splitPluginIdentifier(identifier);
  let { marketplace } = splitPluginIdentifier(identifier);
  if (!marketplace) {
    // 名字可能同名存在于多个市场；多命中必须显式报错，让用户补 @marketplace 而不是替其选择。
    const overview = (await resolveDep(deps, "getPluginsOverview"))(base);
    const matches = overview.availablePlugins.filter((plugin) => plugin.name === name);
    if (matches.length > 1) throw ambiguousPluginError(matches.map((plugin) => plugin.id));
    if (matches.length === 0 || !matches[0]) {
      throw new Error(`Plugin not found in any marketplace: ${name}`);
    }
    // 唯一命中才自动补全市场名：多命中时报歧义，把选择权交回用户而不是按顺序取第一个。
    //
    // 零命中抛普通 Error 而非 usage，因为命令写法合法，缺的是市场里的该插件。
    // 歧义错误带出全部候选 id，用户补 @marketplace 时无需再跑一次 list。
    // 这条规则同时固定了跨机器行为：同一标识解析到同一市场，安装结果可复现。
    marketplace = matches[0].marketplace;
  }
  const result = await (await resolveDep(deps, "installPlugin"))({
    ...base,
    marketplace,
    pluginName: name,
    scope,
  });
  return reportInstallOutcome(ctx, options, result, `${name}@${marketplace}`);
}

// 把已安装插件更新到当前市场的最新版本。
// 输入：identifier 可为插件 id 或名字（由 resolveLoadedPluginId 归一）；scope 仅做拼写校验，更新沿用安装时的层级。
// 输出：0 成功（含"已是最新"）；1 表示存在 error 级诊断。
// 副作用：覆盖插件目录内容并更新版本记录；提示用户重启 zcode 才会生效。
async function runPluginsUpdateCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  flags: PluginsCommandFlags,
  identifier: string,
): Promise<number> {
  resolveScope(flags.scope);
  const pluginId = await resolveLoadedPluginId(deps, identifier);
  const result = await (await resolveDep(deps, "updatePlugin"))({
    ...baseOptions(deps),
    pluginId,
  });
  // 更新结果按 pluginId 回查条目：服务层可能重建目录，不能沿用入参携带的版本信息。
  //
  // 已是最新与真正升级共用成功退出码，只有 error 级诊断返回 1，避免重复 update 被脚本判为失败。
  // 文本分支区分两种措辞并统一提示重启 zcode，因为进程内已加载的插件代码不会被热替换。
  // warning 交给 writeWarnings 写到 stderr，不污染 stdout 的结构化结果。
  const current = result.installedPlugins.find((plugin) => plugin.id === pluginId);
  const failed = hasErrors(result.diagnostics);
  if (options.json) {
    ctx.stdout.write(
      formatJson({
        pluginId,
        ok: !failed,
        previousVersion: result.previousVersion,
        ...(current?.version ? { version: current.version } : {}),
        installed: result.installedPlugins.map(formatInstalledPluginJson),
        diagnostics: result.diagnostics.map(formatDiagnosticJson),
      }),
    );
    return failed ? 1 : 0;
  }
  if (failed) {
    ctx.stderr.write(
      `Failed to update plugin ${pluginId}\n${formatDiagnosticLines(result.diagnostics)}`,
    );
    return 1;
  }
  const version = current?.version ?? "";
  ctx.stdout.write(
    version && version === result.previousVersion
      ? `Plugin ${pluginId} is already up to date (${version}).\n`
      : `Updated plugin ${pluginId} from ${result.previousVersion || "unknown"} to ${version || "unknown"}. Restart zcode to apply.\n`,
  );
  writeWarnings(ctx, result.diagnostics);
  return 0;
}

// 统一输出安装结果并折算退出码。
// 输入：result 含已安装条目、依赖闭包与诊断；pluginId 为展示用的 `<name>@<marketplace>`。
// 输出：0 表示无 error 级诊断，1 表示存在 error（--json 时也带 ok:false 且照常输出）。
// 副作用：写 stdout（结果）与 stderr（失败信息 + 警告），不修改任何状态。
function reportInstallOutcome(
  ctx: RunContext,
  options: GlobalOptions,
  result: ZCodePluginInstallData,
  pluginId: string,
): number {
  const failed = hasErrors(result.diagnostics);
  if (options.json) {
    ctx.stdout.write(
      formatJson({
        pluginId,
        ok: !failed,
        installed: result.installedPlugins.map(formatInstalledPluginJson),
        dependencyClosure: result.dependencyClosure,
        diagnostics: result.diagnostics.map(formatDiagnosticJson),
      }),
    );
    return failed ? 1 : 0;
  }
  if (failed) {
    ctx.stderr.write(
      `Failed to install plugin ${pluginId}\n${formatDiagnosticLines(result.diagnostics)}`,
    );
    return 1;
  }
  for (const plugin of result.installedPlugins) {
    const version = plugin.version ? ` (${plugin.version})` : "";
    ctx.stdout.write(
      `Installed plugin ${plugin.id}${version} [${plugin.enabled ? "enabled" : "disabled"}]\n`,
    );
  }
  writeWarnings(ctx, result.diagnostics);
  return 0;
}

// 启用或停用单个插件。
// 输入：plugin 为插件标识（名字或 id，由服务层解析）；enabled 为期望状态；scope 未指定时沿用服务默认层级。
// 输出：恒为 0 —— 服务层若不接受该变更会以抛错形式表达，交由上层 catch 转成退出码 1。
// 副作用：修改启用配置（落盘）。
async function runPluginsSetCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  flags: PluginsCommandFlags,
  plugin: string,
  enabled: boolean,
): Promise<number> {
  // 单个启停是幂等写入：下发期望状态而非切换指令，重放同一命令不会来回翻转。
  //
  // scope 为 undefined 时不下发该字段，交给服务层按配置层级取缺省值，CLI 不重复实现优先级。
  // 恒返回 0 表示命令已受理，真正的拒绝由服务层抛错并经上层 catch 折算退出码。
  const scope = resolveScope(flags.scope);
  const result = await (await resolveDep(deps, "setPluginEnabled"))({
    ...baseOptions(deps),
    enabled,
    plugin,
    ...(scope ? { scope } : {}),
  });
  ctx.stdout.write(options.json ? formatPluginSetJson(result) : formatHumanPluginSet(result));
  return 0;
}

// 停用插件：单个插件或 `--all` 全量停用。
// 输入：rest 为位置参数；flags.all/scope 决定模式。
// 输出：任一插件仍处于启用态（含被更高优先级层强制启用）即返回 1，否则 0。
// 副作用：批量修改启用配置；单个失败不中断其余插件的停用，最后统一汇总。
// 不变量：--all 与指定插件名互斥，--scope 与 --all 互斥，避免含义重叠。
async function runPluginsDisableCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  flags: PluginsCommandFlags,
  rest: string[],
): Promise<number> {
  // 先做互斥校验再进入分支：否则 --all 会把用户显式点名的插件也一并停用，与预期相反。
  if (flags.all && rest.length > 0) {
    throw new PluginsUsageError("Cannot use --all with a specific plugin");
  }
  if (!flags.all) {
    if (rest.length === 0) {
      throw new PluginsUsageError(
        "Please specify a plugin name or use --all to disable all plugins",
      );
    }
    return await runPluginsSetCommand(ctx, options, deps, flags, requireOne(rest), false);
  }
  if (flags.scope !== undefined) throw new PluginsUsageError("Cannot use --scope with --all");
  const base = baseOptions(deps);
  const listPlugins = await resolveDep(deps, "listPlugins");
  const setPluginEnabled = await resolveDep(deps, "setPluginEnabled");
  // entries 累积三类结果：成功、抛错、以及稍后按 effective 态复查出的失败。
  //
  // 列表只取一次快照，循环内不再重复列举，避免与并发写入交错出现不一致视图。
  // 单条失败只记录 message 而不中断后续插件，否则一个坏条目会让整批 --all 半途而废。
  // 循环跳过已停用条目，减少无意义的配置写入与 mtime 抖动。
  const entries: Array<{ plugin: PluginListItem; result?: SetZCodePluginEnabledResult; error?: string }> = [];
  // 只处理当前确实启用的条目，已停用的不必再写配置，避免制造无意义的文件变更。
  for (const plugin of listPlugins(base).plugins) {
    if (!plugin.enabled) continue;
    try {
      entries.push({ plugin, result: await setPluginEnabled({ ...base, enabled: false, plugin: plugin.id }) });
    } catch (error) {
      // 单条失败不中断批处理：记录原因后继续，最后统一汇总失败条目。
      entries.push({ plugin, error: error instanceof Error ? error.message : String(error) });
    }
  }
  // 写的是 user 层；workspace/project 层的 enabledPlugins=true 优先级更高、盖不掉，所以按 effective 态复查。
  // 写 user 层后再读一次 effective 态：project 或 workspace 层的 enabledPlugins 优先级更高，盖不掉。
  //
  // 因此写成功但依然启用也算失败，并提示改用 --scope project 到对应层关闭。
  // 复查基于新快照而非循环里的对象，服务层拒绝或规范化配置时才能如实反映。
  // 失败集合同时决定退出码与 stderr 文案，两处必须共用同一判定，避免输出与码值矛盾。
  // entries 为空时单独回 No enabled plugins 并返回 0，属于无事可做而非错误。
  const stillEnabled = new Set(listPlugins(base).plugins.filter((p) => p.enabled).map((p) => p.id));
  const failed = entries.filter((entry) => entry.error || stillEnabled.has(entry.plugin.id));
  if (options.json) {
    ctx.stdout.write(
      formatJson(
        entries.map((entry) => ({
          enabled: entry.result?.enabled ?? entry.plugin.enabled,
          effectiveEnabled: stillEnabled.has(entry.plugin.id),
          path: entry.result?.path ?? null,
          plugin: formatPluginJson(entry.result?.plugin ?? entry.plugin, []),
          ...(entry.error ? { error: entry.error } : {}),
        })),
      ),
    );
    return failed.length > 0 ? 1 : 0;
  }
  if (entries.length === 0) {
    ctx.stdout.write("No enabled plugins.\n");
    return 0;
  }
  for (const entry of entries) {
    if (entry.result && !failed.includes(entry)) ctx.stdout.write(formatHumanPluginSet(entry.result));
  }
  for (const entry of failed) {
    ctx.stderr.write(
      entry.error
        ? `Failed to disable plugin ${entry.plugin.id}: ${entry.error}\n`
        : `Warning: plugin ${entry.plugin.id} is still enabled by a higher-priority config layer (project/workspace); disable it there with --scope project.\n`,
    );
  }
  return failed.length > 0 ? 1 : 0;
}

// 卸载插件（破坏性操作）。
// 输入：identifier 为插件标识；flags.force 跳过确认，flags.keepData 保留数据目录。
// 输出：0 卸载成功或用户主动中止；1 非交互环境未带 --force、或服务层返回"未找到"。
// 副作用：删除插件目录与配置；--keep-data 时仅保留数据目录。
// 安全口径：非 TTY 且无 --force 一律拒绝执行，绝不静默清除。
async function runPluginsUninstallCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  flags: PluginsCommandFlags,
  identifier: string,
): Promise<number> {

  resolveScope(flags.scope);
  const target = await resolveLoadedPluginId(deps, identifier);
  // 卸载是破坏性的彻底清除：交互终端下询问确认；非交互(管道/CI)且未带 --force 时拒绝执行，不静默卸载。
  if (!options.force) {
    if (!ctx.stdin.isTTY) {
      ctx.stderr.write(
        `Refusing to uninstall ${target} without confirmation. Re-run with --force in a non-interactive shell.\n`,
      );
      return 1;
    }
    // 用户拒绝确认属于正常取消，返回 0 而不是失败，避免 CI/脚本把"用户说不"当成错误。
    const confirmed = await confirmUninstall(ctx, target);
    if (!confirmed) {
      ctx.stdout.write(`Aborted. ${target} was not uninstalled.\n`);
      return 0;
    }
  }

  const removed = await (await resolveDep(deps, "uninstallPlugin"))({
    ...baseOptions(deps),
    pluginId: target,
    ...(flags.keepData ? { keepData: true } : {}),
  });

  ctx.stdout.write(
    options.json
      ? formatJson({
          pluginId: removed?.id ?? target,
          removed: removed !== null,
          ...(flags.keepData ? { keptData: true } : {}),
          ...(removed ? { plugin: formatInstalledPluginJson(removed) } : {}),
        })
      : formatHumanPluginUninstall(removed, target),
  );
  return removed ? 0 : 1;
}

// 校验插件或市场 manifest 的结构与引用是否合法。
// 输入：path 为本地路径（相对路径按进程 cwd 解析）。
// 输出：0 合法，1 存在 error 级诊断；warning 只提示不影响退出码。
// 副作用：只读磁盘上的 manifest，不安装、不改配置。
async function runPluginsValidateCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  path: string,
): Promise<number> {
  const diagnostics = await (await resolveDep(deps, "validatePluginPath"))({
    ...baseOptions(deps),
    path,
  });
  const failed = hasErrors(diagnostics);
  if (options.json) {
    ctx.stdout.write(
      formatJson({ path, ok: !failed, diagnostics: diagnostics.map(formatDiagnosticJson) }),
    );
    return failed ? 1 : 0;
  }
  if (failed) {
    ctx.stderr.write(`Plugin manifest is invalid: ${path}\n${formatDiagnosticLines(diagnostics)}`);
    return 1;
  }
  ctx.stdout.write(`Plugin manifest is valid: ${path}\n`);
  writeWarnings(ctx, diagnostics);
  return 0;
}
