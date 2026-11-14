/**
 * MCP 用户目录模块 - 主入口
 */

// INV-01 用户级配置根目录恒为操作系统 home（HOME 优先、USERPROFILE 次之、os.homedir 兜底），绝不跟随 appData 或安装位置；守住位置：resolveUserHomeDir；改错故障：与 CLI 读到两份不同文件，用户手改的 MCP 在桌面端消失
// INV-02 环境变量为空串或纯空白必须视为未设置并继续回落，不得直接取用；守住位置：resolveUserHomeDir 的 trim 判空；改错故障：拼出相对路径把配置写进进程当前目录，换工作目录或重启后配置凭空消失
// INV-03 workspace 作用域缺少 workspacePath 必须抛错，禁止静默退回 home；守住位置：buildDirectoryConfigPath 的 baseDir 判空；改错故障：项目级保存落进用户级文件，污染整机配置且卸载项目后仍然存在
// INV-04 配置路径的层级恒为 base 加描述符目录段再加文件名，段序与层级不得改动；守住位置：buildDirectoryConfigPath 的 join；改错故障：目录约定偏离 CLI，桌面端写入的 server 永远读不到
// INV-05 目录定位恒取配置文件路径的 dirname，而不是文件名本身；守住位置：buildDirectoryMcpLocation；改错故障：遗留覆盖项按错误的键匹配，残留的 enabled 覆盖把用户已停用的 server 重新拉起
// INV-06 mcp.servers 读写嵌套的 mcp.servers 对象，mcpServers 读写顶层平铺键，两套形状必须互不混用；守住位置：readServerMapFromJson 与 writeServerMapToJson 的键名分支；改错故障：servers 被写到 mcp 顶层，CLI 解析不到，界面 MCP 列表全空
// INV-07 server 表读取时非记录、数组与 null 一律折成空表，绝不把畸形结构当表遍历；守住位置：readServerMapFromJson 的每处类型判定；改错故障：数组被遍历出下标键名，列表冒出 name 为 0 的幽灵 server 并在写回时覆盖用户数据
// INV-08 写回只替换目标 server 表并保留文件其余字段，不整份重建；守住位置：writeServerMapToJson 的两个返回分支；改错故障：同一文件里用户的模型、权限、主题等其它配置被一并抹掉
// INV-09 启用是默认态，只在停用时落盘 enabled:false，恢复启用则删除该键；守住位置：setServerEnabled 的两个返回分支；改错故障：配置里出现 enabled:true 与 enable:false 并存，两套口径互相矛盾导致停用不生效
// INV-10 任何写回都必须先剥离遗留的 enable 键，不允许新旧字段同时存在；守住位置：setServerEnabled 的解构；改错故障：外部工具按 enable 读取时把已停用的 server 当成启用并继续拉起
// INV-11 遗留迁移中 enable 与 enabled 冲突时以停用为准；守住位置：migrateLegacyEnableFlag 的 disabled 计算；改错故障：按 enabled 取值会把用户关掉的 server 重新注册进 agent
// INV-12 迁移只在真的命中遗留键时标记 changed，没有残留时不写文件；守住位置：migrateLegacyEnableFlag 的 changed 与加载侧写回分支；改错故障：每次加载都重写配置，mtime 抖动触发外部 watch 反复重载
// INV-13 迁移落盘失败只降级为告警，内存结果照常返回；守住位置：readDirectoryServersFromFile 的内层 catch；改错故障：只读目录或权限不足时整份列表加载失败，用户以为配置全部丢失
// INV-14 配置不存在折成空列表，其余读盘、解析、权限错误必须上抛；守住位置：readDirectoryServersFromFile 的 catch 分支；改错故障：坏文件被当成空配置送入替换路径，正在运行的 server 被断开
// INV-15 .zcode 与 .agents 是同作用域互斥来源，.zcode 一旦读到 server 就不再读 .agents；守住位置：readDirectoryServersFromPreferredSources 的早返回；改错故障：两源合并后同名项互相覆盖，界面出现重名条目且停用打错对象
// INV-16 加载顺序恒为先 workspace 后 user，且用户级永远参与，不能被项目级命中短路；守住位置：loadCliMcpFromUserDirectory 的两次 push；改错故障：项目里有配置时全局 server 全部消失，切换项目后原本可用的服务不可见
// INV-17 加载侧不对同名 server 去重，重复项靠 location 区分；守住位置：两处 servers.push；改错故障：按名字合并会丢掉另一作用域的配置，停用其中一个等于两个一起消失
// INV-18 set-enabled 必须作用于 payload.location 指定的文件，不能按 projectPath 重新推导；守住位置：saveCliMcpToUserDirectory 的 set-enabled 分支；改错故障：开关被写到另一个文件，界面开关回弹而进程里 server 仍在运行
// INV-19 upsert 与 remove 走读现有表、改一项、整表写回，且只写 .zcode 来源；守住位置：saveCliMcpToUserDirectory 的下半段；改错故障：直接覆盖写会丢掉表里其它 server，删除一个等于清空全部
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  CliMcpSource,
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  McpScope,
  SettingsDirectoryLocation,
  SettingsDirectorySource,
  NativeMcpServerRecord,
  SaveCliMcpToUserDirectoryRequest,
} from "@zcode/shared";
import type { McpConfigKeyName } from "./types.js";
import { isRecord, readJsonObject, writeTextAtomic } from "./utils.js";
import { migrateLegacyCommonMcp } from "./legacy.js";

// 重新导出类型和函数
export type { McpConfigKeyName, OpenCodeMcpServerConfig, McpSourceDescriptor } from "./types.js";
export { MCP_SOURCE_DESCRIPTORS, getSourceDescriptor } from "./types.js";
export { migrateLegacyCommonMcp } from "./legacy.js";

interface DirectoryMcpDescriptor {
  source: CliMcpSource;
  directorySource: SettingsDirectorySource;
  userConfigDirSegments: string[];
  workspaceConfigDirSegments: string[];
  fileName: string;
  format: "json";
  configKeyName: McpConfigKeyName;
}

// 描述符把目录位置、文件名、键名形状与来源标识绑成一个 descriptor 常量，路径与解析规则只有这一处定义，避免读写两侧各自硬编码后慢慢漂移
// directorySource 同时充当 location.source 与按来源反查描述符的键，新来源不登记就会在 findDescriptorByLocation 处直接抛错，而不是悄悄写错文件
// 用户级段以 .zcode/cli 结尾而项目级只有 .zcode：CLI 把用户配置放在子目录、项目配置放在仓库根，两段不能互相复用
// configKeyName 取 mcp.servers 时读写都走嵌套结构，这个字段不是展示文案，改动它等于切换配置文件格式
// format 目前只有 json 一个取值，保留字段是为了让上层拿到的 file.format 有稳定来源，而不是为多格式预留
// [权衡] 用户级与项目级共用同一个 source 值，而不各造一个：来源描述的是「哪套目录约定」，作用域已经由 location.scope 单独承载
// 描述符表在运行期只读，没有任何写入路径，因此可以被并发的加载请求同时共享而不需要加锁
// 改动这里的目录段必须同步 CLI 侧约定，否则桌面端与 CLI 会各自读写一份互不可见的配置，表现为两边列表不一致
const ZCODE_MCP_DESCRIPTOR: DirectoryMcpDescriptor = {
  source: "zcodeagentmcp",
  directorySource: "zcode",
  userConfigDirSegments: [".zcode", "cli"],
  workspaceConfigDirSegments: [".zcode"],
  fileName: "config.json",
  format: "json",
  configKeyName: "mcp.servers",
};
const ENABLED_KEY = "enabled";
// 历史遗留：桌面端早期把停用状态写成 enable，而 CLI 契约字段（contracts McpServerConfigBase）
// 一直是 enabled，导致同一条 server 出现两套口径、停用后仍被 agent 拉起。
// 现在读写逻辑一律只认 enabled，这里只保留一次性迁移；存量配置清空后整块删除。
const LEGACY_ENABLE_KEY = "enable";

const AGENTS_MCP_DESCRIPTOR: DirectoryMcpDescriptor = {
  source: "zcodeagentmcp",
  directorySource: "agents",
  userConfigDirSegments: [".agents"],
  workspaceConfigDirSegments: [".agents"],
  fileName: "mcp.json",
  format: "json",
  configKeyName: "mcpServers",
};

// 用户级 MCP 配置挂在操作系统 home 下而不是 Electron 的 appData：CLI 与桌面端必须看到同一份文件，跟着 appData 走会让同一用户出现两份配置
// 便携模式同样不参与：便携只改变程序自身的数据目录，MCP 配置属于用户身份而非安装位置，跟随可执行文件会让换机或移动目录后配置丢失
// HOME 先于 USERPROFILE 是为了兼容从 Git Bash、msys 启动的进程，那里 USERPROFILE 可能仍指向另一个账户或盘符
// [失败路径] 两个变量都存在但为空白时按未设置处理，否则会拼出相对路径，配置文件落到进程当前工作目录，换个启动方式就读不到
// os.homedir 作为最后兜底读系统账户库，不依赖环境变量被父进程正确继承
// 结果不在模块级缓存：会话中途切换 HOME 的启动器与测试场景需要立即生效，缓存会让后续读写继续落到旧目录
// 返回值必须是绝对路径，上游只做 join 不做补全，相对 home 会让 dirname 得到「.」并污染 location.directoryPath
// 每次调用只是一次环境读取加两次 trim，相比紧随其后的文件 IO 可以忽略，因此不做记忆化
function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

const DIRECTORY_MCP_DESCRIPTORS: readonly DirectoryMcpDescriptor[] = [
  ZCODE_MCP_DESCRIPTOR,
  AGENTS_MCP_DESCRIPTOR,
];

// 单一路径构造函数同时服务用户级与项目级，scope 是唯一分叉点，base 与目录段都由它选择，调用方不得自行拼接路径
// [失败路径] 项目级缺 workspacePath 时抛错而不是回落到 home：回落会把项目配置写进用户级文件，卸载项目后那条 server 仍留在全局列表
// [权衡] 用 join 而不是 resolve：resolve 会规范化上跳段与符号链接，写回后路径与调用方传入的字符串不再相等，按 location 匹配的清理逻辑全部失效
// 不做 realpath 与越界校验：workspacePath 来自宿主进程而非远端输入，真实路径解析只会在符号链接项目上让 location 与用户看到的路径不一致
// 目录段以展开形式交给 join，跨平台分隔符与盘符处理由 path 模块负责，自己拼字符串会在 Windows 上产出混合分隔符
// 目录不在这里创建：本函数只回答「应该在哪」，建目录与权限失败留给写盘时暴露，读路径不应因为探测而留下空目录
// fileName 只能来自描述符，调用方无法指定任意文件名，从源头避免配置写到约定之外的位置
// 抛错文案带上 directorySource，合并日志里才能区分缺参数的是 .zcode 还是 .agents
function buildDirectoryConfigPath(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): string {
  const baseDir = scope === "user" ? resolveUserHomeDir() : workspacePath;
  if (!baseDir) {
    throw new Error(`Missing workspace path for ${descriptor.directorySource} workspace MCP config`);
  }
  const segments = scope === "user" ? descriptor.userConfigDirSegments : descriptor.workspaceConfigDirSegments;
  return join(baseDir, ...segments, descriptor.fileName);
}

function getUserCliConfigPath(): string {
  return buildDirectoryConfigPath(ZCODE_MCP_DESCRIPTOR, "user");
}

function buildDirectoryMcpLocation(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): SettingsDirectoryLocation {
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);
  return {
    source: descriptor.directorySource,
    scope: scope === "workspace" ? "project" : "user",
    directoryPath: dirname(filePath),
    ...(workspacePath ? { projectPath: workspacePath } : {}),
  };
}

// 一个读取入口吞掉嵌套与平铺两种形状，调用方只面对 name 到 config 的表，不必关心文件原本的结构
// mcp.servers 分支先判 mcp 是记录再取 servers：整个 mcp 缺失是常态，直接对 undefined 取属性会抛错
// 三处数组判定不是冗余：数组同样满足 typeof 对象，放行后 entries 会产出下标键，写回时数组被替换成对象，用户数据变成不可用结构
// 不校验 config 内部字段：字段语义属于各个 server 自己的 schema，在这里越权校验会把合法的新字段当成脏数据
// 任何异常形状都退化成空表而不是抛错，一份写坏的文件不会让整个加载路径失败
// [权衡] 不区分「键缺失」与「键为空表」：调用方对两者处理完全相同，多一种状态只会让写回分支多一次判空
// 空表与文件不存在在调用侧必须同样不可区分，这是刻意的：上层只关心最终有几个 server，不关心文件是否存在
// 函数无副作用且不读盘（pure），形状规则因此在迁移、加载与写回三处复用同一份实现
function readServerMapFromJson(
  parsed: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
): Record<string, Record<string, unknown>> {
  if (configKeyName === "mcp.servers") {
    const mcp = parsed.mcp;
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) {
      return {};
    }
    const servers = (mcp as Record<string, unknown>).servers;
    return servers && typeof servers === "object" && !Array.isArray(servers)
      ? servers as Record<string, Record<string, unknown>>
      : {};
  }

  const rawServerMap = parsed[configKeyName];
  return rawServerMap && typeof rawServerMap === "object" && !Array.isArray(rawServerMap)
    ? rawServerMap as Record<string, Record<string, unknown>>
    : {};
}

function writeServerMapToJson(
  current: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
  servers: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  if (configKeyName !== "mcp.servers") {
    return {
      ...current,
      [configKeyName]: servers,
    };
  }

  const currentMcp = current.mcp && typeof current.mcp === "object" && !Array.isArray(current.mcp)
    ? current.mcp as Record<string, unknown>
    : {};
  return {
    ...current,
    mcp: {
      ...currentMcp,
      servers,
    },
  };
}

async function readUserCliConfig(): Promise<Record<string, unknown>> {
  return (await readJsonObject(getUserCliConfigPath())) ?? {};
}

async function writeUserCliConfig(config: Record<string, unknown>): Promise<void> {
  await writeTextAtomic(getUserCliConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

function readServerEnabled(config: Record<string, unknown>): boolean {
  return config[ENABLED_KEY] !== false;
}

function setServerEnabled(config: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  // 启用是默认态，不落盘冗余字段；同时清掉可能残留的 legacy enable，
  // 避免再产出 enable:false + enabled:true 这类自相矛盾的配置。
  const { [LEGACY_ENABLE_KEY]: _legacyEnable, [ENABLED_KEY]: _enabled, ...rest } = config;
  if (enabled) {
    return rest;
  }
  return { ...rest, [ENABLED_KEY]: false };
}

// 迁移是纯内存折叠，是否落盘由返回的 changed 决定，函数自身不做 IO，只读场景也能拿到正确口径
// 结果逐项写入 migrated 而不是原地删除键：原地改会改动调用方传入的对象，而该对象仍被 parsed 引用，写回时新旧状态混在同一份数据里
// 不含遗留键的 server 原样引用透传，不做深拷贝：这些配置后续只读，复制只会增加一次无意义的对象图分配
// [失败路径] config 不是记录时透传而不是丢弃，丢弃等于静默抹掉一个用户可见的 server 名
// changed 只在真的命中遗留键时置真，保证没有存量时写回分支不执行，配置 mtime 保持稳定
// [资源] 未迁移项与入参共享引用，调用方在写回前不得修改 serverMap，否则内存结果与磁盘内容分叉
// 迁移不改名、不排序、不合并，server 名是上层停用与删除的唯一键，重排会让操作打到错误的项上
function migrateLegacyEnableFlag(
  serverMap: Record<string, Record<string, unknown>>,
): { servers: Record<string, Record<string, unknown>>; changed: boolean } {
  let changed = false;
  const migrated: Record<string, Record<string, unknown>> = {};

  for (const [name, config] of Object.entries(serverMap)) {
    if (!isRecord(config) || !(LEGACY_ENABLE_KEY in config)) {
      migrated[name] = config;
      continue;
    }
    changed = true;
    // 两个字段冲突时以「停用」为准：桌面端写 enable:false 时不会清理外部导入残留的
    // enabled:true，若按 enabled 取值会把用户关掉的 server 重新拉起。
    const disabled = config[LEGACY_ENABLE_KEY] === false || config[ENABLED_KEY] === false;
    migrated[name] = setServerEnabled(config, !disabled);
  }

  return { servers: migrated, changed };
}

function removeLegacyMcpEnabledOverride(
  config: Record<string, unknown>,
  location: SettingsDirectoryLocation,
  name: string,
): { config: Record<string, unknown>; changed: boolean } {
  if (!isRecord(config.mcp) || !isRecord(config.mcp[location.directoryPath])) {
    return { config, changed: false };
  }

  const mcpConfig = isRecord(config.mcp) ? { ...config.mcp } : {};
  const pathConfig = isRecord(mcpConfig[location.directoryPath])
    ? { ...(mcpConfig[location.directoryPath] as Record<string, unknown>) }
    : {};
  if (!(name in pathConfig)) {
    return { config, changed: false };
  }

  delete pathConfig[name];

  if (Object.keys(pathConfig).length > 0) {
    mcpConfig[location.directoryPath] = pathConfig;
  } else {
    delete mcpConfig[location.directoryPath];
  }

  return {
    config: {
      ...config,
      mcp: mcpConfig,
    },
    changed: true,
  };
}

function findDescriptorByLocation(location: SettingsDirectoryLocation): DirectoryMcpDescriptor {
  const descriptor = DIRECTORY_MCP_DESCRIPTORS.find((item) => item.directorySource === location.source);
  if (!descriptor) {
    throw new Error(`Unsupported MCP settings directory source: ${location.source}`);
  }
  return descriptor;
}

async function cleanupLegacyMcpEnabledOverride(
  location: SettingsDirectoryLocation,
  name: string,
): Promise<void> {
  const userConfig = await readUserCliConfig();
  const result = removeLegacyMcpEnabledOverride(userConfig, location, name);
  if (result.changed) {
    await writeUserCliConfig(result.config);
  }
}

async function writeServerEnabledToFile(
  descriptor: DirectoryMcpDescriptor,
  location: SettingsDirectoryLocation,
  name: string,
  enabled: boolean,
): Promise<void> {
  const scope: Exclude<McpScope, "common"> = location.scope === "project" ? "workspace" : "user";
  const workspacePath = scope === "workspace" ? location.projectPath : undefined;
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);
  const current = (await readJsonObject(filePath)) ?? {};
  const serverMap = readServerMapFromJson(current, descriptor.configKeyName);
  const currentServer = serverMap[name];
  if (!isRecord(currentServer)) {
    return;
  }

  // MCP 自身已有 mcp.servers/mcpServers 结构；禁用状态写在 server 配置对象内，
  // 避免把目录路径写到 mcp 顶层后和真实 MCP 配置混在一起。
  const nextServerMap = {
    ...serverMap,
    [name]: setServerEnabled(currentServer, enabled),
  };
  let next = writeServerMapToJson(current, descriptor.configKeyName, nextServerMap);
  const legacyCleanup = removeLegacyMcpEnabledOverride(next, location, name);
  if (legacyCleanup.changed) {
    next = legacyCleanup.config;
  }
  await writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

// 读盘、迁移、投影在一次调用里完成，返回记录已经带好作用域、位置与文件信息，上层不需要再推导任何路径
// 整个保护块覆盖读盘、解析与迁移三步，任何一步抛出都汇入同一个兜底分支；解析被挪出保护块会变成上层未捕获异常
// [失败路径] catch 必须只把表示不存在的 ENOENT 折成空列表，其余错误码一律上抛，不按错误码做降级猜测
// 写回使用刚解析出的 parsed 而不是重新读盘，避免在迁移与写回之间被外部进程改动后写回一份不完整快照
// 投影原样透传 config，不在这里剔除遗留字段：迁移已保证它们不存在，再过滤一次等于每次加载多一次遍历
// projectPath 只在项目级写入，用户级记录的该字段恒为 undefined，避免上层把全局 server 误判成项目级
// location 与 filePath 由同一次计算得出，两者必然指向同一文件，上层据此回写时不会定位到另一份配置
async function readDirectoryServersFromFile(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): Promise<NativeMcpServerRecord[]> {
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);

  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const migration = migrateLegacyEnableFlag(readServerMapFromJson(parsed, descriptor.configKeyName));
    const serverMap = migration.servers;

    if (migration.changed) {
      // 就地把存量 enable 折叠成 enabled 并落盘，用户无感；没有残留时不写文件，保证幂等。
      // 写盘失败（只读目录、权限不足等）不应阻断加载：内存结果已是正确口径，下次加载会重试。
      try {
        const next = writeServerMapToJson(parsed, descriptor.configKeyName, serverMap);
        await writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
      } catch (error) {
        console.warn("[mcp-user-directory] legacy enable migration failed:", filePath, error);
      }
    }

    const location = buildDirectoryMcpLocation(descriptor, scope, workspacePath);
    return Object.entries(serverMap).map(([name, config]) => ({
      source: descriptor.source,
      scope,
      name,
      config,
      enabled: readServerEnabled(config),
      projectPath: scope === "workspace" ? workspacePath : undefined,
      location,
      file: {
        format: descriptor.format,
        filePath,
      },
    }));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    // 解析/权限失败不等于没有 MCP 配置；吞掉异常会让 renderer 把空列表
    // 作为显式配置送入 replace 路径，进而断开已经运行的 server。
    throw error;
  }
}

// 两个目录是互斥来源而不是可合并来源：它们代表同一份用户意图的两种约定，合并会让同一条 server 在两处各有一份状态，停用只改到其中一份
// 判据是读到的 server 数量而不是文件是否存在：.zcode 文件在但表为空时应继续尝试 .agents，否则从 CLI 迁移过来的用户会看到空列表
// [权衡] 两层串行等待而不是并发读取：先读 .zcode 能在命中时短路掉 .agents 的读盘，常见情况下少一次文件 IO
// 本函数必须只负责选来源，不做作用域校验、不去重、不排序，顺序即文件内顺序，展示顺序交给上层决定
// 两个来源共用同一份 descriptor 结构，新增来源只需登记描述符并在这里加一层回退，读取与投影逻辑不必改动
// 每次调用都重新读盘而不在模块级缓存：外部编辑器与 CLI 会直接改这两个文件，缓存会让界面长期显示过期列表
async function readDirectoryServersFromPreferredSources(
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): Promise<NativeMcpServerRecord[]> {
  const zcodeServers = await readDirectoryServersFromFile(ZCODE_MCP_DESCRIPTOR, scope, workspacePath);
  // `.zcode` 是强优先级来源；只要读到 MCP server，同 scope 的 `.agents` 就不再参与。
  if (zcodeServers.length > 0) {
    return zcodeServers;
  }
  return readDirectoryServersFromFile(AGENTS_MCP_DESCRIPTOR, scope, workspacePath);
}

async function writeZCodeServersToFile(
  scope: Exclude<McpScope, "common">,
  servers: Record<string, Record<string, unknown>>,
  workspacePath?: string,
): Promise<void> {
  const filePath = buildDirectoryConfigPath(ZCODE_MCP_DESCRIPTOR, scope, workspacePath);
  const current = (await readJsonObject(filePath)) ?? {};
  const next = writeServerMapToJson(current, ZCODE_MCP_DESCRIPTOR.configKeyName, servers);
  await writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

// 请求参数可选：不传时只加载用户级，主窗口在尚未打开项目的情况下也能列出全局 server
// 先项目级后用户级的顺序是契约的一部分，消费侧按数组顺序展示，调换会让全局 server 排到项目级之上
// 两个作用域各自读盘并各自失败：项目级抛出会中断整次加载而不是带着半份列表返回，避免上层把残缺结果当成完整配置
// [并发] 同一次加载内两次 readFile 串行执行，避免两个作用域同时命中同一文件时读到不同的中间状态
// 不能跨作用域去重，同名 server 靠 location 区分，这是上层能够分别停用项目级与全局级同名项的前提
// 返回值恒为对象且 servers 恒为数组，空结果也返回空数组，调用方不需要再做判空分支
export async function loadCliMcpFromUserDirectory(
  request?: LoadCliMcpFromUserDirectoryRequest,
): Promise<LoadCliMcpFromUserDirectoryResult> {
  const servers: NativeMcpServerRecord[] = [];

  // 去掉其他 provider 后，ZCode Agent 只按目录约定读取；先 workspace，再 user。
  if (request?.workspacePath) {
    servers.push(...await readDirectoryServersFromPreferredSources("workspace", request.workspacePath));
  }

  servers.push(...await readDirectoryServersFromPreferredSources("user", request?.workspacePath));

  return { servers };
}

// 三类动作必须共用一个入口，set-enabled 走独立分支：它只改一条 server 的一个字段，不参与整表重建
// set-enabled 以 payload.location 为准而不是按 projectPath 推导，location 已经过渲染层确认，重新推导会把开关写到另一个文件
// projectPath 是否存在决定作用域，协议里没有显式 scope 字段，这是与调用方唯一的约定，改动会让旧调用方静默写错层级
// [失败路径] set-enabled 缺 enabled 直接抛错而不默认成启用：默认值会在字段缺失时把用户刚停用的 server 又打开
// upsert 与 remove 先把现有表读成名字到配置的映射再改一项，整表重建只发生在 .zcode 文件上，.agents 永不被写
// [并发] 读改写之间没有文件锁，两个窗口同时对同一文件操作会互相覆盖；桌面端同一时刻只有一个保存入口，因此接受该风险
// 遗留覆盖清理排在主写之后，两次写盘不构成事务，中途崩溃会留下已停用但覆盖项仍在的中间态，下次加载的迁移会再纠正一次
// remove 用删除键而不是置空对象：空对象仍会被投影成一条 server，用户会看到删除后名字还在但配置为空
export async function saveCliMcpToUserDirectory(
  payload: SaveCliMcpToUserDirectoryRequest,
): Promise<void> {
  if (payload.action === "set-enabled") {
    if (typeof payload.enabled !== "boolean") {
      throw new Error("Missing enabled value for MCP set-enabled action");
    }
    const scope: Exclude<McpScope, "common"> = payload.projectPath ? "workspace" : "user";
    const location = payload.location ?? buildDirectoryMcpLocation(ZCODE_MCP_DESCRIPTOR, scope, payload.projectPath);
    await writeServerEnabledToFile(findDescriptorByLocation(location), location, payload.name, payload.enabled);
    await cleanupLegacyMcpEnabledOverride(location, payload.name);
    return;
  }

  const scope: Exclude<McpScope, "common"> = payload.projectPath ? "workspace" : "user";
  const existingServers = await readDirectoryServersFromFile(ZCODE_MCP_DESCRIPTOR, scope, payload.projectPath);
  const nextServers = Object.fromEntries(existingServers.map((server) => [server.name, server.config]));

  if (payload.action === "upsert") {
    if (!payload.config) {
      throw new Error("Missing MCP config for upsert action");
    }
    nextServers[payload.name] = payload.config;
  } else {
    delete nextServers[payload.name];
  }

  await writeZCodeServersToFile(scope, nextServers, payload.projectPath);
}
