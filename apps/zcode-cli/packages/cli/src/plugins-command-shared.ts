// INV-01 依赖按名注入、生产懒加载：守住位置 resolveDep；改错故障 轻命令把整个 bootstrap 图提前拉起。
// INV-02 依赖名与 bootstrap 导出名一一对应：守住位置 BOOTSTRAP_EXPORTS 的 satisfies；改错故障 改名后静默取到 undefined。
// INV-03 注入覆盖优先于真实实现：守住位置 override 判断；改错故障 测试假实现被生产实现顶掉。
// INV-04 单参数命令只接受一个非空值：守住位置 requireOne 的长度与 trim 双检；改错故障 多余参数被静默忽略。
// INV-05 scope 映射固定：user→user、project→workspace、local 拒绝；守住位置 resolveScope；改错故障 写到非预期作用域。
// INV-06 标识按最后一个 @ 拆分：守住位置 lastIndexOf；改错故障 名字本身含 @ 时被拆坏。
// INV-07 裸名必须唯一命中才放行：守住位置 resolveLoadedPluginId；改错故障 重名插件被随意选中。
// INV-08 带 marketplace 的标识原样透传：守住位置 早退；改错故障 多查一次列表且可能改写用户输入。
// INV-09 只看 severity=error：守住位置 hasErrors；改错故障 warning 被当成失败。
// INV-10 卸载确认默认拒绝：守住位置 ^y(es)?$ 正则；改错故障 直接回车就删除插件。
// INV-11 readline 必须关闭：守住位置 rl.close；改错故障 stdin 被占住，后续命令挂起。
// INV-12 失败写 stderr 且退出码 1：守住位置 reportPluginsError；改错故障 脚本把失败当成功。
// INV-13 堆栈只在 verbose 下输出：守住位置 条件分支；改错故障 普通用户看到内部路径。
//
// 模块职责：plugins 子命令共用的依赖解析、参数校验与错误输出。
// 阅读顺序：先看依赖名映射与懒加载，再看 scope/标识解析，最后看确认与错误报告。
import type { Logger } from "@zcode/contracts";
import type { listZCodePlugins } from "@zcode/bootstrap";
import { createInterface } from "node:readline";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import type { CliEnv } from "./env.js";

export type BootstrapModule = typeof import("@zcode/bootstrap");
export type PluginListOutcome = ReturnType<typeof listZCodePlugins>;
export type PluginListItem = PluginListOutcome["plugins"][number];
export type PluginDiagnostic = PluginListOutcome["diagnostics"][number];
export type PluginScope = "user" | "workspace";

/**
 * CLI 依赖名 → bootstrap 导出名。测试按依赖名注入假实现；生产路径按导出名懒加载 bootstrap，
 * 避免 `zcode plugins list` 这类轻命令把整个 bootstrap 图提前拉起来。
 */
// 左边是 CLI 依赖名（测试注入键），右边是 bootstrap 实际导出名。
// 两侧必须同时改：satisfies 让改名在编译期暴露，而不是运行时取到 undefined。
// 新增子命令时在这里登记，类型派生会自动覆盖 override 与 resolveDep。
export const BOOTSTRAP_EXPORTS = {
  addMarketplace: "addZCodePluginMarketplace",
  getPluginsOverview: "getZCodePluginsOverview",
  installPlugin: "installZCodeMarketplacePlugin",
  listPlugins: "listZCodePlugins",
  removeMarketplace: "removeZCodePluginMarketplace",
  setPluginEnabled: "setZCodePluginEnabled",
  uninstallPlugin: "uninstallZCodeMarketplacePlugin",
  updateMarketplace: "updateZCodePluginMarketplace",
  updatePlugin: "updateZCodeMarketplacePlugin",
  validatePluginPath: "validateZCodePluginPath",
} as const satisfies Record<string, keyof BootstrapModule>;

export type PluginDepName = keyof typeof BOOTSTRAP_EXPORTS;
export type PluginDepFn<K extends PluginDepName> =
  BootstrapModule[(typeof BOOTSTRAP_EXPORTS)[K]];

export type PluginsCommandOverrides = { [K in PluginDepName]?: PluginDepFn<K> };

export interface PluginsCommandDependencies extends PluginsCommandOverrides {
  cwd?: () => string;
  env?: CliEnv;
  logger?: Logger;
  loadBootstrapModule?: () => Promise<BootstrapModule>;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
}

/** `zcode plugins` 子命令专属旗标；由 run.ts 的全局解析器收集后原样透传。 */
export interface PluginsCommandFlags {
  all?: boolean;
  available?: boolean;
  keepData?: boolean;
  scope?: string;
  sparse?: readonly string[];
}

/** 参数用法错误：调用方打印 message + usage 并以 1 退出。 */
export class PluginsUsageError extends Error {}

export function requireOne(rest: string[]): string {
  const [value] = rest;
  if (rest.length !== 1 || !value || value.trim().length === 0) throw new PluginsUsageError();
  return value.trim();
}

// 覆盖优先，测试用它注入假 bootstrap，不触碰真实文件系统。
// 生产走动态 import，避免 plugins 这类轻命令把 bootstrap 图提前拉起。
export async function resolveDep<K extends PluginDepName>(
  deps: PluginsCommandDependencies,
  key: K,
): Promise<PluginDepFn<K>> {
  const override = deps[key] as PluginDepFn<K> | undefined;
  if (override) return override;
  const bootstrap = deps.loadBootstrapModule ?? (() => import("@zcode/bootstrap"));
  return (await bootstrap())[BOOTSTRAP_EXPORTS[key]] as PluginDepFn<K>;
}

// workingDirectory 每次调用即时求值，避免长进程里 cwd 变更后仍用旧值。
// 其余字段原样透传，undefined 表示交给 bootstrap 走默认解析。
export function baseOptions(deps: PluginsCommandDependencies) {
  return {
    env: deps.env ?? process.env,
    logger: deps.logger,
    projectConfigPath: deps.projectConfigPath,
    skipUserConfig: deps.skipUserConfig,
    userConfigPath: deps.userConfigPath,
    workingDirectory: (deps.cwd ?? process.cwd)(),
  };
}

// 未给 scope 时返回 undefined，由调用方决定默认值。
// project 在 CLI 语义下映射为 workspace，local 单独拒绝并给出可用值。
export function resolveScope(value: string | undefined): PluginScope | undefined {
  if (value === undefined) return undefined;
  if (value === "user") return "user";
  if (value === "project") return "workspace";
  if (value === "local") {
    throw new PluginsUsageError("Scope 'local' is not supported by zcode. Use: user, project");
  }
  throw new PluginsUsageError(`Invalid scope '${value}'. Use: user, project`);
}

// at<=0 或 at 在末位都按裸名处理，不构造空 marketplace。
// 只有中间位置的 @ 才拆成 name 与 marketplace 两段。
export function splitPluginIdentifier(value: string): { name: string; marketplace?: string } {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return { name: value };
  return { name: value.slice(0, at), marketplace: value.slice(at + 1) };
}

export function hasErrors(diagnostics: readonly PluginDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

/** 裸 name 在已加载插件（内置 + 已安装）里唯一匹配才放行；多个同名必须带 @marketplace。 */
// 带 marketplace 时无需查表，直接原样交给下游安装/卸载。
// 裸名零命中报 not found，多命中报歧义并列出全部候选 id 供用户改写。
// 只有唯一命中才返回真实 id，避免把用户输入的裸名直接当成 id 使用。
export async function resolveLoadedPluginId(
  deps: PluginsCommandDependencies,
  identifier: string,
): Promise<string> {
  if (splitPluginIdentifier(identifier).marketplace) return identifier;
  const outcome = (await resolveDep(deps, "listPlugins"))(baseOptions(deps));
  const matches = outcome.plugins.filter((plugin) => plugin.name === identifier);
  if (matches.length === 1 && matches[0]) return matches[0].id;
  if (matches.length > 1) throw ambiguousPluginError(matches.map((plugin) => plugin.id));
  throw new Error(`Plugin not found: ${identifier}`);
}

export function ambiguousPluginError(ids: string[]): Error {
  return new Error(`Plugin name is ambiguous, use <plugin>@<marketplace>: ${ids.join(", ")}`);
}

export function confirmUninstall(ctx: RunContext, pluginId: string): Promise<boolean> {
  return new Promise((resolvePrompt) => {
    const rl = createInterface({ input: ctx.stdin, output: ctx.stdout });
    rl.question(`Uninstall ${pluginId}? [y/N] `, (answer) => {
      rl.close();
      resolvePrompt(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export function reportPluginsError(
  ctx: RunContext,
  options: GlobalOptions,
  error: unknown,
): number {
  const message = error instanceof Error ? error.message : String(error);
  ctx.stderr.write(`Error: ${message}\n`);
  if (options.verbose && error instanceof Error && error.stack) {
    ctx.stderr.write(`${error.stack}\n`);
  }
  return 1;
}
