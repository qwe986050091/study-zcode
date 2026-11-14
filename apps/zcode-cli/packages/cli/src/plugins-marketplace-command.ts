// `zcode plugins marketplace ...` 子命令实现：add/list/remove/update 四个动作的分发与输出。
// 数据读写由插件服务负责，本层只做参数校验、调用与格式化；失败以退出码 1 + 诊断文本表达。
import { formatJson } from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import {
  formatDiagnosticJson,
  formatDiagnosticLines,
  formatHumanMarketplaceList,
  formatMarketplaceJson,
  writeWarnings,
} from "./plugins-command-format.js";
import {
  baseOptions,
  hasErrors,
  PluginsUsageError,
  requireOne,
  resolveDep,
  resolveScope,
  type PluginsCommandDependencies,
  type PluginsCommandFlags,
} from "./plugins-command-shared.js";

// 分发并执行 marketplace 子命令。
// 输入：args[0] 为动作名，其余为该动作的参数；flags 携带 --scope/--sparse 等共享开关。
// 输出：退出码 0 成功；1 表示存在 error 级诊断或动作失败；参数非法抛 PluginsUsageError 由上层统一打印 usage。
// 副作用：修改 marketplaces 配置（add/remove/update 会落盘），并写 stdout/stderr。
export async function runMarketplaceCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: PluginsCommandDependencies,
  flags: PluginsCommandFlags,
  args: string[],
): Promise<number> {
  const [action, ...rest] = args;
  const base = baseOptions(deps);
  switch (action) {
    case "add": {

      // marketplaces 只有 Host 级一份，这里仅校验拼写以保持参数面一致。
      resolveScope(flags.scope);
      const source = requireOne(rest);
      const summary = await (await resolveDep(deps, "addMarketplace"))({
        ...base,
        source,
        // 未给 --sparse 时不传该字段，避免用空数组覆盖默认的"全量拉取"语义。
        ...(flags.sparse?.length ? { sparsePaths: [...flags.sparse] } : {}),
      });
      ctx.stdout.write(
        options.json
          ? formatJson(formatMarketplaceJson(summary))
          : `Added marketplace ${summary.id} (${summary.pluginCount} plugins)\n`,
      );
      return 0;
    }
    case "list": {
      // list 不接受任何位置参数，多余输入一律按用法错误处理，而不是静默忽略。
      if (rest.length > 0) throw new PluginsUsageError();
      const overview = (await resolveDep(deps, "getPluginsOverview"))(base);
      ctx.stdout.write(
        options.json
          ? formatJson(overview.marketplaces.map(formatMarketplaceJson))
          : formatHumanMarketplaceList(overview.marketplaces),
      );
      return 0;
    }
    case "remove": {
      const marketplace = requireOne(rest);
      await (await resolveDep(deps, "removeMarketplace"))({ ...base, marketplace });
      ctx.stdout.write(
        options.json
          ? formatJson({ marketplace, removed: true })
          : `Removed marketplace ${marketplace}\n`,
      );
      return 0;
    }
    case "update": {
      // 省略 marketplace 表示刷新全部；空串等同省略（避免把空白名字当成具体市场）。
      if (rest.length > 1) throw new PluginsUsageError();
      const marketplace = rest[0]?.trim();
      const result = await (await resolveDep(deps, "updateMarketplace"))({
        ...base,
        ...(marketplace ? { marketplace } : {}),
      });
      const failed = hasErrors(result.diagnostics);
      if (options.json) {
        ctx.stdout.write(
          formatJson({
            ok: !failed,
            marketplaces: result.marketplaces.map(formatMarketplaceJson),
            diagnostics: result.diagnostics.map(formatDiagnosticJson),
          }),
        );
        return failed ? 1 : 0;
      }
      for (const summary of result.marketplaces) {
        ctx.stdout.write(`Updated marketplace ${summary.id} (${summary.pluginCount} plugins)\n`);
      }
      // 有 error 级诊断即整体判失败（退出码 1）；纯 warning 只提示但仍算成功。
      if (failed) {
        ctx.stderr.write(`Marketplace update failed\n${formatDiagnosticLines(result.diagnostics)}`);
        return 1;
      }
      writeWarnings(ctx, result.diagnostics);
      return 0;
    }
    default:
      throw new PluginsUsageError(
        action ? `Unknown marketplace command: ${action}` : "Missing marketplace command",
      );
  }
}
