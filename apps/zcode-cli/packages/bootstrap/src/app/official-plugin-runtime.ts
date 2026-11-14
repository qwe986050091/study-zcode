import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
  ZCODE_PLUGIN_HOST_COMMAND,
  type McpServerConfig,
} from "@zcode/contracts";
import { ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared";
import {
  createOfficialPluginCacheRetryBudget,
  type OfficialPluginCacheRetryBudget,
  writeTextFileAtomicallyWithRetry,
} from "./official-plugin-cache-fs.js";

type SeaModule = typeof import("node:sea");

const MCP_SERVER_RELATIVE_PATH = ["dist", "mcp", "server.js"] as const;

/**
 * 为内置官方插件生成一条 stdio MCP server 配置（不落盘，只给 runtime 用）。
 *
 * 输出 `command = process.execPath`，args 为宿主前缀 + 插件根下的 `dist/mcp/server.js`，并强制
 * `ELECTRON_RUN_AS_NODE=1`（桌面打包态 execPath 是 ZCode Helper，缺它会把 MCP server 误跑进
 * Electron main）。宿主前缀取决于运行形态：SEA 二进制只需 `ZCODE_PLUGIN_HOST_COMMAND`，普通
 * Node 运行则是 `execArgv + 入口脚本 + 命令`。拿不到前缀（无 argv[1]）时回 `undefined`，调用方
 * 应视为“该插件没有可用的内嵌入口”，而不是拼一条坏命令。
 */
export function createBundledMcpRuntimeConfig(input: {
  cwd: string;
  env?: Record<string, string>;
  relativeServerPath?: readonly string[];
  rootPath: string;
  timeoutMs?: number;
}): McpServerConfig | undefined {
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return undefined;
  return {
    args: [
      ...hostPrefixArgs,
      join(input.rootPath, ...(input.relativeServerPath ?? MCP_SERVER_RELATIVE_PATH)),
    ],
    command: process.execPath,
    cwd: input.cwd,
    env: {
      ...input.env,
      // 桌面打包态 process.execPath 是 ZCode Helper；缺少 Node 模式会误进 Electron main。
      ELECTRON_RUN_AS_NODE: "1",
    },
    timeoutMs: input.timeoutMs,
    type: "stdio",
  };
}

/**
 * 为 seed 到缓存目录的官方插件重写 `.zcode-plugin/plugin.json`。
 *
 * 输入：`sourceManifestContents` 是内置原始 manifest；缺席时读缓存里的当前文件作为基准
 * （升级路径可能已被旧客户端改写过）。`pluginName` 用于写入不可伪造的
 * `pluginName@官方市场` 身份；`retryBudget` 供 Windows 文件占用重试共用。
 * 输出：void，文件字节不变时**不触碰文件**（避免无意义的 rename 放大杀毒占用）。
 *
 * 只重写 `mcpServers` 里的 stdio 条目：command 统一为当前 execPath，args 换成宿主前缀 +
 * 替换过 `${ZCODE_PLUGIN_ROOT}` 的原参数，env 强制 Node 模式并覆盖插件身份。HTTP/SSE 条目
 * 原样跳过；`skill-only` / `command-only` 插件没有 mcpServers，直接返回而不是抛错。
 * 失败语义：manifest 非法或 stdio args 非字符串数组时抛错，交由 seed 流程整体失败。
 */
interface OfficialRuntimeManifestInput {
  /** 内置原始 plugin.json 内容；存在时以它为基准，否则以缓存里的当前文件为基准。 */
  sourceManifestContents?: string;
  /** 本地 plugin registry 里的插件名，与官方市场拼成不可伪造的 identity。 */
  pluginName: string;
  /** 与 seed 其余写入共享的重试预算；缺席时自建一份。 */
  retryBudget?: OfficialPluginCacheRetryBudget;
  /** 插件缓存根目录；`.zcode-plugin/plugin.json` 与 `${ZCODE_PLUGIN_ROOT}` 都相对它解析。 */
  rootPath: string;
}

/**
 * 把 seed 到缓存目录的官方插件 manifest 重写成“当前进程可执行”的形态。
 *
 * 只动 `mcpServers` 里的 stdio 条目：command 换 execPath，args 换成宿主前缀 + 展开
 * `${ZCODE_PLUGIN_ROOT}` 的原参数，env 强制 Node 模式并写入不可伪造的插件身份；HTTP / SSE
 * 条目原样跳过。没有 mcpServers 的 skill-only / command-only 插件直接返回。
 * 字节没变时不写文件（避免无谓 rename 触发杀毒占用）；`retryBudget` 缺席时自建一份。
 * 失败语义：manifest 非法、stdio args 非字符串数组时抛错，由 seed 流程整体失败。
 */
export function writeOfficialPluginRuntimeManifest(input: OfficialRuntimeManifestInput): void {
  const manifestPath = join(input.rootPath, ".zcode-plugin", "plugin.json");
  const currentContents = readFileSync(manifestPath, "utf8");
  // 缓存里的入口可能已被旧客户端覆盖，必须从内置原始 manifest 重新生成。
  const manifest = JSON.parse(input.sourceManifestContents ?? currentContents) as Record<
    string,
    unknown
  >;
  // skill-only / command-only 类型的 official plugin 不带 mcpServers，直接跳过 rewrite。
  // 之前这里无脑 asRecord(manifest.mcpServers) 会对 undefined 抛错，
  // 把 seed 流程整个阻断，连带 listZCodeSkills 拉不出 plugin skill。
  if (manifest.mcpServers === undefined) return;
  const mcpServers = asRecord(manifest.mcpServers);
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return;

  // 保留对其他历史 official plugin MCP 的通用重写；zcode-cua 当前是 skill/SDK-only，
  // 不会进入这个分支，也不会生成独立的 CUA MCP server。
  for (const [serverKey, serverRaw] of Object.entries(mcpServers)) {
    const mcpServer = asRecord(serverRaw);
    // HTTP/SSE 插件没有本地入口；按 stdio 校验会让 image-search 阻断整个会话初始化。
    if (mcpServer.type !== undefined && mcpServer.type !== "stdio") continue;
    const mcpServerEnv = isRecord(mcpServer.env) ? mcpServer.env : {};
    const serverArgs =
      input.sourceManifestContents === undefined
        ? [join(input.rootPath, ...MCP_SERVER_RELATIVE_PATH)]
        : mcpServer.args;
    if (
      !Array.isArray(serverArgs) ||
      !serverArgs.every((arg): arg is string => typeof arg === "string") ||
      serverArgs.length === 0
    ) {
      throw new Error("Official plugin manifest has invalid MCP server args.");
    }
    mcpServer.command = process.execPath;
    // 文档插件使用 dist/server.mjs；统一覆盖成 dist/mcp/server.js 会导致启动失败。
    mcpServer.args = [
      ...hostPrefixArgs,
      ...serverArgs.map((arg) => arg.replaceAll("${ZCODE_PLUGIN_ROOT}", input.rootPath)),
    ];
    mcpServer.env = {
      ...mcpServerEnv,
      // 桌面打包态的 process.execPath 是 ZCode Helper。
      // 官方插件 MCP server 缺少 Node 模式 env 时会误进 Electron main，触发 deep-link 注册等桌面副作用。
      ELECTRON_RUN_AS_NODE: "1",
      // 权威写入插件身份（pluginName@marketplace，来自本地 plugin registry，manifest/user env 不可覆盖）。
      // 其他 official plugin 仍带上不可伪造的 plugin identity；CUA broker 凭据由 shared
      // node_repl 的可信配置注入，不再写入独立 server。
      [ZCODE_PLUGIN_ID_ENV_KEY]: `${input.pluginName}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
    };
    mcpServers[serverKey] = mcpServer;
  }
  manifest.mcpServers = mcpServers;

  const nextContents = `${JSON.stringify(manifest, null, 2)}\n`;
  // 启动时无条件 rename 同内容的 plugin.json 会放大 Windows 杀毒/索引器
  // 的短暂文件占用。字节完全一致时不触碰文件；真正有更新时仍保持原子的失败语义。
  if (nextContents === currentContents) return;
  writeTextFileAtomicallyWithRetry(
    manifestPath,
    nextContents,
    input.retryBudget ?? createOfficialPluginCacheRetryBudget(),
  );
}

/**
 * 官方插件宿主进程的前缀参数（放在 MCP server 脚本路径之前）。
 *
 * SEA 二进制：进程内已带插件宿主实现，只发命令名 `ZCODE_PLUGIN_HOST_COMMAND`。
 * 普通 Node：`process.execArgv`（保留 `--experimental-*` 等运行时开关）+ 当前入口脚本绝对路径
 * + 命令，子进程因此用同一份代码启动插件宿主。
 * 无 `argv[1]` 时回 `undefined`——这是“当前形态无法派生插件宿主”的事实，不猜路径。
 */
export function officialPluginHostPrefixArgs(): string[] | undefined {
  if (isSeaRuntime()) return [ZCODE_PLUGIN_HOST_COMMAND];

  const entrypoint = process.argv[1];
  if (!entrypoint) return undefined;

  return [...process.execArgv, resolve(entrypoint), ZCODE_PLUGIN_HOST_COMMAND];
}

function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Official plugin manifest has invalid mcpServers.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
