// INV-01 文件配置在前、清单在后且后者同名覆盖：守住位置 合并顺序；改错故障 文件配置覆盖清单配置。
// INV-02 命名空间键固定为插件名加服务器名：守住位置 命名函数；改错故障 跨插件同名覆盖。
// INV-03 单个服务器失败只记诊断并跳过：守住位置 循环捕获；改错故障 一个坏服务器拖垮整个插件。
// INV-04 变量缺失与配置无效使用不同错误码：守住位置 错误类型判断；改错故障 诊断无法区分。
// INV-05 清单中的服务器路径必须在插件根内：守住位置 根内解析；改错故障 任意文件被读取。
// INV-06 清单数组逐项合并且后者覆盖：守住位置 合并调用；改错故障 前项配置生效。
// INV-07 文件不存在视为空映射：守住位置 未找到分支；改错故障 缺文件产生错误诊断。
// INV-08 服务器映射接受包装与裸映射两种形状：守住位置 形状归一；改错故障 标准格式无法识别。
// INV-09 非对象条目一律过滤：守住位置 过滤条件；改错故障 字符串被当作配置。
// INV-10 用户配置默认值只接受合法标量：守住位置 默认值收集；改错故障 非法默认值进入展开。
// INV-11 传输类型只支持三种：守住位置 支持集合；改错故障 未知类型静默降级。
// INV-12 未声明类型时按命令存在推断：守住位置 推断函数；改错故障 有命令却走网络分支。
// INV-13 官方鉴权只允许 http 与 stdio：守住位置 类型判断；改错故障 推送型传输携带无效鉴权。
// INV-14 官方鉴权与 oauth 互斥：守住位置 两处冲突检查；改错故障 双鉴权配置出现不确定行为。
// INV-15 官方鉴权路径拒绝保留头：守住位置 保留头检查；改错故障 静态头覆盖身份。
// INV-16 插件身份环境变量最后由解析器覆写：守住位置 覆写语句；改错故障 第三方伪造内置身份。
// INV-17 敏感变量只允许进入环境与请求头：守住位置 敏感开关；改错故障 密钥展开到地址或参数。
// INV-18 无法识别的占位符原样保留：守住位置 默认分支；改错故障 用户文本被清空。
//
// 模块职责：汇总插件内 MCP 服务器定义，展开变量并产出带命名空间的配置。
// 状态所有权：无状态；读取插件文件，凭据只做传递不落盘。
// 阅读顺序：先看定义汇总与解析入口，再读形状归一与单服务器解析，最后看模板展开。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findOfficialMcpReservedHeaders } from "@zcode/shared";
import type {
  McpOAuthConfig,
  McpServerConfig,
  McpServerConfigBase,
  PluginDiagnostic,
  PluginManifest,
  PluginOptionValues,
} from "@zcode/contracts";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import { ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared";
import type { LoadedPlugin } from "./types.js";
import { isNotFoundError, isPluginOptionValue, isRecord, resolveInside } from "./helpers.js";
import { buildOfficialProvenance, parseZCodeOfficialAuth } from "./mcp-official-auth.js";

/*
 * ============================================================
 * plugins / mcp.ts —— 插件 MCP server 定义发现、变量展开与配置解析
 *
 * 定位：把插件内 .mcp.json 与 manifest.mcpServers 汇聚成 MCP server 定义，再做
 * `${VAR}` 模板展开，产出带命名空间的 McpServerConfig。
 *
 * 输入输出：输入插件根、dataPath、user_config 选项与环境变量；输出
 * `plugin:<manifest.name>:<serverName>` 键的配置映射。
 *
 * 副作用：读取插件目录内文件；不写文件、不发网络请求（凭据只做传递不落盘）。
 *
 * 失败语义：单个 server 解析失败只记 diagnostic 并跳过该 server（不拖垮整插件）；
 * 路径越界/变量缺失/鉴权冲突/保留头冲突都归入错误诊断；sse 等不支持 transport 报错。
 *
 * 不变量：变量按 sink 分级解析——user_config sensitive 值只允许进 env/headers 等敏感字段，
 * 禁止展开到 url/args/cwd；插件身份 env 由 resolver 最后覆写，manifest 无法伪造；
 * official 鉴权与静态 oauth/保留头互斥。
 * ============================================================
 */

const SUPPORTED_MCP_TYPES = new Set(["stdio", "http", "sse"]);
const TEMPLATE_PATTERN = /\$\{([^}]+)\}/g;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 汇总插件内 MCP 定义：.mcp.json 在前、manifest.mcpServers 在后（后者同名覆盖前者）。 */
// 合并方向不可反：先 loadMcpServersFromFile(join(rootPath, ".mcp.json"))，再 loadMcpServersFromSpec(manifest.mcpServers)，最后 `{ ...fromFile, ...fromManifest }` 让清单同名项覆盖文件项；反序会让磁盘上的 .mcp.json 悄悄改掉 manifest 声明的服务器。
// 两条来源都先过 normalizeMcpServersShape，因此 resolvePluginMcpServers 只面对 Record<string, unknown>；本函数只读，不写回 manifest 或文件。
export function loadPluginMcpServerDefinitions(input: {
  diagnostics: PluginDiagnostic[];
  loaded: LoadedPlugin;
}): Record<string, unknown> {
  const fromFile = loadMcpServersFromFile(join(input.loaded.rootPath, ".mcp.json"), input);
  const fromManifest = loadMcpServersFromSpec(input.loaded.manifest.mcpServers, input);
  return { ...fromFile, ...fromManifest };
}

/**
 * 把定义逐个解析为 McpServerConfig，并以 `plugin:<插件名>:<server 名>` 命名空间输出。
 * 单个失败只写 diagnostic（区分变量缺失与配置无效），其余 server 继续生效。
 */
// 定义来源取 input.definitions ?? loadPluginMcpServerDefinitions(input)，随后 createVariableContext 一次性快照 dataPath/env/loaded/options/userConfigDefaults，循环内不再重算；因此同一批服务器的变量解析口径一致。
// result 只在 resolveMcpServerConfig 成功后写入 toNamespacedServerName 的键；抛错时按 error instanceof PluginVariableError 分成 plugin_variable_missing 与 plugin_mcp_server_disabled，已成功项不回滚。
export function resolvePluginMcpServers(input: {
  dataPath: string;
  definitions?: Record<string, unknown>;
  diagnostics: PluginDiagnostic[];
  env: Record<string, string | undefined>;
  loaded: LoadedPlugin;
  options: PluginOptionValues;
  workingDirectory: string;
}): Record<string, McpServerConfig> {
  const merged = input.definitions ?? loadPluginMcpServerDefinitions(input);
  const context = createVariableContext(input);
  const result: Record<string, McpServerConfig> = {};

  for (const [name, server] of Object.entries(merged)) {
    try {
      result[toNamespacedServerName(input.loaded, name)] = resolveMcpServerConfig(server, context, {
        mcpKey: name,
        pluginId: input.loaded.id,
      });
    } catch (error) {
      input.diagnostics.push({
        code:
          error instanceof PluginVariableError
            ? "plugin_variable_missing"
            : "plugin_mcp_server_disabled",
        message: error instanceof Error ? error.message : `Invalid MCP server: ${name}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
    }
  }

  return result;
}

/** 命名空间键：防止不同插件的同名 MCP server 在全局配置里互相覆盖。 */
function toNamespacedServerName(loaded: LoadedPlugin, serverName: string): string {
  return `plugin:${loaded.manifest.name}:${serverName}`;
}

/**
 * 解析 manifest.mcpServers 的多种形态：字符串→插件根内文件；数组→逐项合并（后者覆盖）；
 * 对象→按 mcpServers 包裹或直接 server 映射两种形状归一。
 */
// 按 spec 类型分派：undefined → {}；string → resolveInside(rootPath, spec) 后再 loadMcpServersFromFile，返回 null 表示路径越界，此时只推 plugin_component_path_invalid 且不读文件；数组 → Object.assign 逐项递归合并，后者覆盖前者；其余 → normalizeMcpServersShape。
// 递归保留是因为数组元素本身还可以是字符串/数组，合并顺序完全由展开顺序决定，不能改成先收集再校验。
function loadMcpServersFromSpec(
  spec: unknown,
  input: {
    diagnostics: PluginDiagnostic[];
    loaded: LoadedPlugin;
  },
): Record<string, unknown> {
  if (spec === undefined) return {};
  if (typeof spec === "string") {
    const path = resolveInside(input.loaded.rootPath, spec);
    if (!path) {
      input.diagnostics.push({
        code: "plugin_component_path_invalid",
        message: `Plugin mcpServers path escapes plugin root: ${spec}`,
        path: input.loaded.manifestPath,
        pluginId: input.loaded.id,
        severity: "error",
      });
      return {};
    }
    return loadMcpServersFromFile(path, input);
  }
  if (Array.isArray(spec)) {
    return Object.assign({}, ...spec.map((item) => loadMcpServersFromSpec(item, input)));
  }
  return normalizeMcpServersShape(spec, input);
}

/** 读取并归一 MCP JSON 文件；文件不存在返回空映射，其他读取/解析错误记 diagnostic 后返回空。 */
function loadMcpServersFromFile(
  path: string,
  input: {
    diagnostics: PluginDiagnostic[];
    loaded: LoadedPlugin;
  },
): Record<string, unknown> {
  try {
    return normalizeMcpServersShape(JSON.parse(readFileSync(path, "utf8")), input);
  } catch (error) {
    if (isNotFoundError(error)) return {};
    input.diagnostics.push({
      code: "plugin_mcp_read_failed",
      message: error instanceof Error ? error.message : `Failed to read MCP config: ${path}`,
      path,
      pluginId: input.loaded.id,
      severity: "error",
    });
    return {};
  }
}

/** 归一 server 映射：接受 {mcpServers:{...}} 或顶层映射，过滤掉非对象条目。 */
// 先 isRecord(value) 兜底：非对象直接推 plugin_mcp_invalid 并返回 {}；再判断 isRecord(value.mcpServers)，为真才取内层，否则把顶层当服务器映射；最后 Object.entries(...).filter(([, config]) => isRecord(config)) 丢掉字符串等非法条目，避免下游 resolveMcpServerConfig 在 !isRecord 分支抛错。
function normalizeMcpServersShape(
  value: unknown,
  input: {
    diagnostics: PluginDiagnostic[];
    loaded: LoadedPlugin;
  },
): Record<string, unknown> {
  if (!isRecord(value)) {
    input.diagnostics.push({
      code: "plugin_mcp_invalid",
      message: "Plugin MCP config must be an object",
      path: input.loaded.manifestPath,
      pluginId: input.loaded.id,
      severity: "error",
    });
    return {};
  }
  const servers = isRecord(value.mcpServers) ? value.mcpServers : value;
  return Object.fromEntries(Object.entries(servers).filter(([, config]) => isRecord(config)));
}

interface VariableContext {
  /** 插件持久化数据目录（ZCODE_PLUGIN_DATA）。 */
  dataPath: string;
  /** 进程环境变量快照，用于 ${ZCODE_*} 与敏感变量展开。 */
  env: Record<string, string | undefined>;
  /** 已加载插件（rootPath/id/manifest/marketplace 等）。 */
  loaded: LoadedPlugin;
  /** 调用方传入的 user_config 值。 */
  options: PluginOptionValues;
  /** manifest.userConfig 中声明的默认值，options 缺失时兜底。 */
  userConfigDefaults: PluginOptionValues;
  /** 当前工作目录（CLAUDE_PROJECT_DIR）。 */
  workingDirectory: string;
}

/** 组装模板展开上下文：叠加 manifest.userConfig 默认值，供后续所有字段解析复用。 */
function createVariableContext(input: {
  dataPath: string;
  env: Record<string, string | undefined>;
  loaded: LoadedPlugin;
  options: PluginOptionValues;
  workingDirectory: string;
}): VariableContext {
  return {
    dataPath: input.dataPath,
    env: input.env,
    loaded: input.loaded,
    options: input.options,
    userConfigDefaults: getUserConfigDefaults(input.loaded.manifest),
    workingDirectory: input.workingDirectory,
  };
}

/** 收集 manifest.userConfig 中合法的默认值（仅接受 PluginOptionValue 标量）。 */
function getUserConfigDefaults(manifest: PluginManifest): PluginOptionValues {
  const defaults: PluginOptionValues = {};
  for (const [key, option] of Object.entries(manifest.userConfig ?? {})) {
    if (isPluginOptionValue(option.default)) defaults[key] = option.default;
  }
  return defaults;
}

/**
 * 解析单个 MCP server：判定 transport、通用字段、官方鉴权与各 transport 专属字段。
 *
 * 失败语义：配置非法/transport 不支持/鉴权冲突/保留头冲突一律抛错，由调用方转 diagnostic。
 * 不变量：stdio 的插件身份 env 在 manifest env 之后覆写；official provenance 由宿主生成，
 * 不接受 .mcp.json 自述；敏感变量只允许出现在 env/headers 等敏感 sink。
 */
// 判定顺序固定：先 !isRecord(server) 抛错；type 取显式 server.type，缺失才 inferMcpType（有 string 类型 command → stdio，否则 http）；SUPPORTED_MCP_TYPES 不含的 type 在构造 baseConfig 前就抛，避免未知传输进入结果。
// baseConfig 的 alwaysLoad/enabled/timeoutMs/source 只解析一次，三条分支都 spread 它；stdio 必须在 env 展开后用 loaded.id 覆写 ZCODE_PLUGIN_ID_ENV_KEY，http 在 officialAuth 存在时先判 server.oauth 冲突、再判 findOfficialMcpReservedHeaders，顺序反了会让保留头在鉴权路径上被放行。
function resolveMcpServerConfig(
  server: unknown,
  context: VariableContext,
  identity: { mcpKey: string; pluginId: string },
): McpServerConfig {
  if (!isRecord(server)) throw new Error("MCP server config must be an object");
  const type = typeof server.type === "string" ? server.type : inferMcpType(server);
  if (!SUPPORTED_MCP_TYPES.has(type)) throw new Error(`Unsupported MCP transport: ${type}`);
  // 修复原因：各 transport 分别重建配置曾漏传 alwaysLoad，导致插件常驻工具被延迟。
  // 通用字段只在此解析；source 按 marketplace 归类，兼容 source 为 cache 的官方 CDN 插件。
  const baseConfig: McpServerConfigBase = {
    alwaysLoad: typeof server.alwaysLoad === "boolean" ? server.alwaysLoad : undefined,
    enabled: typeof server.enabled === "boolean" ? server.enabled : undefined,
    timeoutMs: typeof server.timeoutMs === "number" ? server.timeoutMs : undefined,
    source: {
      kind: context.loaded.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE ? "builtin" : "plugin",
    },
  };

  // zcode_official 允许 http 与 stdio，sse 出现即禁用该 MCP，不静默忽略——静默会让配置作者以为鉴权已生效。
  //
  // stdio 之所以能放开：请求由插件进程自己发出，身份头随每条出站协议消息的 _meta 下发
  // （见 adapters/src/mcp/index.ts）。sse 没有对应通道，继续拒绝。
  const officialAuth = parseZCodeOfficialAuth(server.auth, identity.mcpKey);
  if (officialAuth && type !== "http" && type !== "stdio") {
    throw new Error(
      `MCP server ${identity.mcpKey}: ${officialAuth.type} auth requires type "http" or "stdio", got "${type}"`,
    );
  }

  if (type === "stdio") {
    const command = requireString(server.command, "stdio MCP server requires command");
    // stdio 不走 OAuth 分支，声明 oauth 属无效配置；与 http 一样不做优先级裁决，直接禁用。
    if (officialAuth && server.oauth !== undefined) {
      throw new Error(
        `MCP server ${identity.mcpKey}: ${officialAuth.type} auth cannot be combined with oauth`,
      );
    }
    const env = resolveStringRecord(
      {
        CLAUDE_PROJECT_DIR: context.workingDirectory,
        ZCODE_PLUGIN_DATA: context.dataPath,
        ZCODE_PLUGIN_ROOT: context.loaded.rootPath,
        ZCODE_PROJECT_DIR: context.workingDirectory,
        CLAUDE_PLUGIN_DATA: context.dataPath,
        CLAUDE_PLUGIN_ROOT: context.loaded.rootPath,
        ...(isRecord(server.env) ? server.env : {}),
      },
      context,
      { allowSensitive: true },
    );
    // 插件 manifest 可自定义 env，但插件身份必须由 resolver 权威写入（loaded.id 来自本地 plugin
    // registry，不是可序列化配置），不能让第三方伪造 official zcode-cua 身份后获得只应定向注入给
    // 内置插件的 broker 凭据。manifest env spread 之后覆写，确保 user/manifest 无法覆盖。
    env[ZCODE_PLUGIN_ID_ENV_KEY] = context.loaded.id;
    return {
      ...baseConfig,
      type: "stdio",
      command: resolveTemplate(command, context, { allowSensitive: false }),
      args: Array.isArray(server.args)
        ? server.args
            .filter((arg): arg is string => typeof arg === "string")
            .map((arg) => resolveTemplate(arg, context, { allowSensitive: false }))
        : undefined,
      cwd:
        typeof server.cwd === "string"
          ? resolveTemplate(server.cwd, context, { allowSensitive: false })
          : undefined,
      env,
      ...(officialAuth
        ? {
            auth: officialAuth,
            // provenance 由宿主生成；即便 .mcp.json 里写了 official 字段也会被此处覆盖。
            official: buildOfficialProvenance(identity),
          }
        : {}),
    };
  }

  const url = requireString(server.url, `${type} MCP server requires url`);
  const headers = isRecord(server.headers)
    ? resolveStringRecord(server.headers, context, { allowSensitive: true })
    : undefined;
  const oauth = resolveMcpOAuthConfig(server.oauth, context);

  if (officialAuth) {
    // 第一阶段不做优先级裁决：两种鉴权同时声明属于配置错误，直接禁用。
    if (oauth) {
      throw new Error(
        `MCP server ${identity.mcpKey}: ${officialAuth.type} auth cannot be combined with oauth`,
      );
    }
    // 保留头只在官方鉴权路径下拦截。普通/第三方 MCP 静态携带 authorization 是既有合法用法，
    // 全局拦截会造成回归。
    const reserved = findOfficialMcpReservedHeaders(headers);
    if (reserved.length > 0) {
      throw new Error(
        `MCP server ${identity.mcpKey}: static headers must not contain reserved header(s): ${reserved.join(", ")}`,
      );
    }
    return {
      ...baseConfig,
      type: "http",
      url: resolveTemplate(url, context, { allowSensitive: false }),
      headers,
      auth: officialAuth,
      // provenance 由宿主生成；即便 .mcp.json 里写了 official 字段也会被此处覆盖。
      official: buildOfficialProvenance(identity),
    };
  }

  return {
    ...baseConfig,
    type,
    url: resolveTemplate(url, context, { allowSensitive: false }),
    headers,
    oauth,
  } as McpServerConfig;
}

/**
 * 严格解析 `auth` 的实现已移到 mcp-official-auth.ts（mcp.ts 已到 max-lines 上限）。
 *
 * 职责：把 oauth 配置解析为 client_credentials / authorization_code；clientSecret 走敏感 sink，
 * 其余字段走非敏感 sink；未知类型抛错并禁用该 server。
 */
function resolveMcpOAuthConfig(
  value: unknown,
  context: VariableContext,
): McpOAuthConfig | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "client_credentials") {
    return {
      type: "client_credentials",
      clientId: resolveTemplate(
        requireString(value.clientId, "MCP OAuth client_credentials requires clientId"),
        context,
        { allowSensitive: false },
      ),
      clientSecret: resolveTemplate(
        requireString(value.clientSecret, "MCP OAuth client_credentials requires clientSecret"),
        context,
        { allowSensitive: true },
      ),
      ...(typeof value.clientName === "string"
        ? {
            clientName: resolveTemplate(value.clientName, context, { allowSensitive: false }),
          }
        : {}),
      ...(typeof value.scope === "string"
        ? {
            scope: resolveTemplate(value.scope, context, { allowSensitive: false }),
          }
        : {}),
    };
  }
  if (value.type === "authorization_code") {
    return {
      type: "authorization_code",
      ...(typeof value.clientId === "string"
        ? {
            clientId: resolveTemplate(value.clientId, context, { allowSensitive: false }),
          }
        : {}),
      ...(typeof value.clientSecret === "string"
        ? {
            clientSecret: resolveTemplate(value.clientSecret, context, { allowSensitive: true }),
          }
        : {}),
      ...(typeof value.clientName === "string"
        ? {
            clientName: resolveTemplate(value.clientName, context, { allowSensitive: false }),
          }
        : {}),
      ...(typeof value.redirectPath === "string"
        ? {
            redirectPath: resolveTemplate(value.redirectPath, context, { allowSensitive: false }),
          }
        : {}),
      ...(typeof value.scope === "string"
        ? {
            scope: resolveTemplate(value.scope, context, { allowSensitive: false }),
          }
        : {}),
    };
  }
  throw new Error(`Unsupported MCP OAuth type: ${String(value.type)}`);
}

/** transport 推断：有 command 视为 stdio，否则默认 http（不猜 sse）。 */
function inferMcpType(server: Record<string, unknown>): string {
  return typeof server.command === "string" ? "stdio" : "http";
}

/** 必填非空字符串校验；缺失或空串抛错（空串同样视为未配置）。 */
function requireString(value: unknown, message: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(message);
}

/** 把字符串映射逐项展开模板；非字符串值被丢弃（返回空映射而非报错）。 */
function resolveStringRecord(
  record: Record<string, unknown>,
  context: VariableContext,
  options: { allowSensitive: boolean },
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") result[key] = resolveTemplate(value, context, options);
  }
  return result;
}

/**
 * 展开 `${VAR}` 模板：插件根/数据/工作目录为内建变量；会话/技能上下文变量无值即报错；
 * user_config 少值报错、sensitive 键仅在 allowSensitive sink 可用；ZCODE_* 与环境变量
 * 按需解析；无法识别的占位符原样保留。
 */
function resolveTemplate(
  value: string,
  context: VariableContext,
  options: { allowSensitive: boolean },
): string {
  return value.replace(TEMPLATE_PATTERN, (match, name: string) => {
    switch (name) {
      case "CLAUDE_PLUGIN_ROOT":
      case "ZCODE_PLUGIN_ROOT":
        return context.loaded.rootPath;
      case "CLAUDE_PLUGIN_DATA":
      case "ZCODE_PLUGIN_DATA":
        return context.dataPath;
      case "CLAUDE_PROJECT_DIR":
      case "ZCODE_PROJECT_DIR":
        return context.workingDirectory;
      case "CLAUDE_CODE_SESSION_ID":
      case "CLAUDE_SESSION_ID":
      case "ZCODE_SESSION_ID":
        throw new PluginVariableError(
          `Plugin variable requires a runtime session context: ${name}`,
        );
      case "CLAUDE_SKILL_DIR":
      case "ZCODE_SKILL_DIR":
        throw new PluginVariableError(`Plugin variable requires a skill context: ${name}`);
      default:
        break;
    }

    if (name.startsWith("user_config.")) {
      const key = name.slice("user_config.".length);
      if (
        context.loaded.manifest.userConfig?.[key]?.sensitive === true &&
        !options.allowSensitive
      ) {
        throw new PluginVariableError(
          `Sensitive plugin user_config value cannot be used in this field: ${key}`,
        );
      }
      const configValue = context.options[key] ?? context.userConfigDefaults[key];
      if (configValue === undefined) {
        throw new PluginVariableError(`Missing plugin user_config value: ${key}`);
      }
      return String(configValue);
    }
    if (name.startsWith("ZCODE_")) {
      const envValue = context.env[name];
      if (envValue === undefined)
        throw new PluginVariableError(`Missing environment variable: ${name}`);
      return envValue;
    }
    if (options.allowSensitive && ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {

      // token。只在敏感 sink 解析，避免 secret 被展开到 args、URL 或其它可见字段。
      const envValue = context.env[name];
      if (envValue === undefined)
        throw new PluginVariableError(`Missing environment variable: ${name}`);
      return envValue;
    }

    return match;
  });
}

/** 变量展开错误：调用方据此归入 plugin_variable_missing 诊断（区别于一般配置错误）。 */
class PluginVariableError extends Error {}
