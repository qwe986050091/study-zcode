// INV-01 先判断是否需要运行时：守住位置 入口早退；改错故障 帮助命令也触发配置准备。
// INV-02 显式变量最高优先：守住位置 环境读取；改错故障 用户配置被内置路径覆盖。
// INV-03 两个变量都显式才直返：守住位置 双条件；改错故障 只配一半时另一边被清空。
// INV-04 数据根目录三级回退：守住位置 空值合并；改错故障 未设变量时写入错误目录。
// INV-05 单文件模式先取资产：守住位置 资产读取；改错故障 打包后找不到随包配置。
// INV-06 入口路径取真实路径：守住位置 解析软链接；改错故障 全局命令定位到错误目录。
// INV-07 候选路径按序查找：守住位置 数组查找；改错故障 开发态与发布态配置混淆。
// INV-08 资产只读取出即释放：守住位置 收尾释放；改错故障 文件句柄泄漏。
// INV-09 入口只准备资源：守住位置 不启动下载；改错故障 短命令拉起长生命周期任务。
// INV-10 缓存路径集中解析：守住位置 统一函数；改错故障 版本升级后读到旧缓存。
// INV-11 个人配置固定文件名：守住位置 共享常量；改错故障 与主程序读写不同文件。
// INV-12 平台解析可注入：守住位置 选项字段；改错故障 单测绑定当前系统。
// INV-13 版本号可注入：守住位置 选项字段；改错故障 缓存键在测试中漂移。
// INV-14 端点来源统一解析：守住位置 共享函数；改错故障 内置配置指向错误环境。
// INV-15 刷新成功才默认留痕：守住位置 结果判断；改错故障 每次启动都刷日志。
// INV-16 日志不输出查询参数：守住位置 固定字段；改错故障 CDN 令牌进入日志。
// INV-17 非生产环境放宽日志：守住位置 环境判断；改错故障 调试时看不到刷新结果。
// INV-18 返回值为纯字符串映射：守住位置 返回类型；改错故障 调用方拿到可变环境对象。
//
// 模块职责：为 CLI 入口准备 Provider 配置相关的环境变量。
// 状态所有权：本模块不持有全局状态，资源在函数内创建并释放。
// 阅读顺序：先看入口判定，再看路径解析，最后看随包配置定位与日志上报。
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  materializeZCodeBuiltinProviderConfig,
  NodeZCodeBuiltinProviderConfigSource,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  resolveZCodeBuiltinCachePaths,
  resolveZCodeBuiltinClientPlatform,
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
  type ZCodeBuiltinRefreshEvent,
} from "@zcode/provider-node";
import { resolveRuntimeZCodeEndpointOrigin, ZCODE_VERSION } from "@zcode/shared";
import type { CliEnv } from "./env.js";

export const SEA_ZCODE_BUILTIN_PROVIDER_CONFIG_ASSET_KEY = "zcode-provider/zcode-builtin.json";

// stderr 可注入，便于单测捕获输出。
// onBuiltinRefreshError 固定写一行失败日志。
// result 为 updated 或非 production 才写。
// NODE_ENV 非 production 时放宽为全量。
// 日志只带 result 与 revision，不带查询参数。
export function createCliProviderRefreshReporter(
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
) {
  return {
    onBuiltinRefreshError(error: unknown) {
      stderr.write(
        `ZCode Built-in 刷新失败: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    },
    onBuiltinRefreshResult(event: ZCodeBuiltinRefreshEvent) {
      // TTL 检查不是生产事件；成功更新才默认留痕，不能输出 CDN URL 查询参数或内容。
      if (event.result === "updated" || process.env.NODE_ENV !== "production") {
        stderr.write(
          `ZCode Built-in ${event.result}${event.reason ? ` (${event.reason})` : ""}${event.revision === undefined ? "" : ` revision=${event.revision} source=CDN`}\n`,
        );
      }
    },
  };
}

type SeaProviderConfigAssets = Pick<typeof import("node:sea"), "getAsset" | "isSea">;

interface PrepareCliProviderRuntimeEnvOptions {
  readonly argv: readonly string[];
  readonly env: CliEnv;
  readonly dataBaseDir?: string;
  readonly entrypoint?: string;
  readonly sea?: SeaProviderConfigAssets;
  readonly appVersion?: string;
  readonly platform?: string;
}

/** 为运行 Core 或写入模型选择的 CLI Entry 定位同一 Environment 的 Provider Config。 */
// requiresProviderRuntime 为假时返回空对象。
// explicitZCodeBuiltin 与 explicitPersonal 都非空时原样透传。
// explicitZCodeBuiltin 或 explicitPersonal 缺一侧时该侧走路径解析。
// dataBaseDir 按 options 与 env 三级回退。
// 返回三个固定环境变量键。
export async function prepareCliProviderRuntimeEnv(
  options: PrepareCliProviderRuntimeEnvOptions,
): Promise<Record<string, string>> {
  if (!requiresProviderRuntime(options.argv)) return {};

  const explicitZCodeBuiltin = options.env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const explicitPersonal = options.env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const dataBaseDir = options.dataBaseDir ?? options.env.ZCODE_DATA_BASE_DIR?.trim() ?? homedir();
  if (explicitZCodeBuiltin && explicitPersonal) {
    return {
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: explicitZCodeBuiltin,
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: explicitPersonal,
    };
  }

  const zcodeBuiltinFilePath =
    explicitZCodeBuiltin ??
    (await resolveBundledZCodeBuiltinProviderConfig({
      dataBaseDir,
      entrypoint: options.entrypoint ?? process.argv[1],
      sea: options.sea ?? getSeaProviderConfigAssets(),
    }));
  const personalFilePath =
    explicitPersonal ?? join(dataBaseDir, ".zcode", "v2", PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  const appVersion = options.appVersion ?? ZCODE_VERSION;
  const platform = options.platform ?? resolveZCodeBuiltinClientPlatform();
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(options.env);
  const cachePaths = resolveZCodeBuiltinCachePaths({
    environmentConfigRoot: join(dataBaseDir, ".zcode", "v2"),
    platform,
    appVersion,
    zcodeEndpointOrigin,
  });
  const source = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: zcodeBuiltinFilePath,
    activeFilePath: cachePaths.activeFilePath,
    watch: false,
  });
  // 入口只准备资源和路径；下载由 Prompt/TUI 长生命周期 Runtime 持有并取消。
  try {
    await source.read();
  } finally {
    source.dispose();
  }

  return {
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: cachePaths.activeFilePath,
    [ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]: zcodeBuiltinFilePath,
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
  };
}

// --help 与 -v 等参数让 requiresProviderRuntime 返回 false。
// --prompt 与 --target 一律返回 true。
// command 为 undefined 时按需要处理。
// command 以连字符开头也按需要处理。
// 其余按 tui 等白名单命令判断。
function requiresProviderRuntime(argv: readonly string[]): boolean {
  if (argv.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v")) {
    return false;
  }
  if (
    argv.some(
      (arg) =>
        arg === "--prompt" ||
        arg.startsWith("--prompt=") ||
        arg === "--target" ||
        arg.startsWith("--target="),
    )
  ) {
    return true;
  }

  const command = argv[0];
  if (command === undefined || command.startsWith("-")) return true;
  return (
    command === "tui" ||
    command === "app-server" ||
    command === "agent-server" ||
    command === "login" ||
    command === "logout"
  );
}

// sea.isSea() 为真时走 getAsset 分支。
// materializeZCodeBuiltinProviderConfig 把内容写入配置根。
// entrypoint 缺失时抛错。
// realpathSync 先解析软链接。
// candidates 两个路径按序 existsSync 查找。
async function resolveBundledZCodeBuiltinProviderConfig(input: {
  readonly dataBaseDir: string;
  readonly entrypoint: string | undefined;
  readonly sea: SeaProviderConfigAssets | undefined;
}): Promise<string> {
  if (input.sea?.isSea()) {
    const content = input.sea.getAsset(SEA_ZCODE_BUILTIN_PROVIDER_CONFIG_ASSET_KEY, "utf8");
    return materializeZCodeBuiltinProviderConfig({
      environmentConfigRoot: join(input.dataBaseDir, ".zcode", "v2"),
      content,
    });
  }

  const entrypoint = input.entrypoint?.trim();
  if (!entrypoint) throw new Error("无法定位 CLI ZCode Built-in Provider Config：缺少入口路径");
  // 全局 bin 可以是软链接，随包配置必须相对真实入口定位。
  const entryDirectory = dirname(realpathSync(resolve(entrypoint)));
  const candidates = [
    join(entryDirectory, "provider", "zcode-builtin.json"),
    resolve(entryDirectory, "../../../../../config/provider/zcode-builtin.json"),
  ];
  const candidate = candidates.find((filePath) => existsSync(filePath));
  if (candidate) return candidate;
  throw new Error(`无法定位 CLI ZCode Built-in Provider Config：${candidates.join(", ")}`);
}

function getSeaProviderConfigAssets(): SeaProviderConfigAssets | undefined {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: "node:sea") => typeof import("node:sea"))
    | undefined;
  return getBuiltinModule?.("node:sea");
}
