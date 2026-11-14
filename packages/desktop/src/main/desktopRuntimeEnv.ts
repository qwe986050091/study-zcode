/* eslint-disable max-lines -- desktop runtime/env 解析需要集中维护 main/host/remote assets 的启动边界，拆分会扩大远程连接回归面。 */
// 模块说明：desktop 运行时环境解析入口，必须把 Electron 运行形态、编译期身份、shell 与 .env 文件收敛成一套确定的 host 环境。
// 模块说明：读取优先级固定为 显式进程环境 高于 本地 .env 文件 高于 编译期常量 高于 平台默认目录，低层只做补位。
// 模块说明：任何空白、非法或类型不符的取值都会回落到上一层，绝不把半成品透传给 host、agent 或子进程。
// 模块说明：开发与打包（含 preview）分支必须在模块加载期求值一次，后续所有解析共享同一结论，模块内不保留可变全局状态。
// INV-01 空白字符串不等于覆盖值；守住位置：readRuntimeEnvOverride 的 trim 判空；改错故障：ZCODE_DESKTOP_HOME_DIR 设为空格时被当成有效路径，测试数据写进解析为相对目录的意外位置。
// INV-02 布尔开关只认 1/true/yes/on 且大小写不敏感；守住位置：isTruthyRuntimeEnvOverride 与 isTruthyEnvFlag；改错故障：写成 true 的 e2e 开关被静默忽略，Chromedriver 拿不到隔离的用户数据目录。
// INV-03 应用名按未打包、preview 打包、正式打包三段取值且环境覆盖优先；守住位置：runtimeApplicationName；改错故障：三段塌缩成一段后 e2e 与正式版共用 userData，单实例锁抢占导致测试进程收不到窗口。
// INV-04 未打包 runtime 一律视为 development；守住位置：desktopRuntimeEnv 的取反判断；改错故障：dev 构建被标成 production 后 host 走线上资源与生产鉴权分支，本地改动无法生效。
// INV-05 打包态不读取用户机器上的任何 .env；守住位置：loadHostProcessEnvFromLocalFiles 的打包早返回；改错故障：安装包沿用开发者残留配置，OAuth 与 CDN 指向非预期环境。
// INV-06 开发态 .env 加载顺序保证越靠近包目录的文件越后合并；守住位置：loadHostProcessEnvFromLocalFiles 的 fileCandidates 顺序；改错故障：先后顺序颠倒会让仓库根配置覆盖包内覆盖值，本地调试开关失效。
// INV-07 同一绝对路径只解析一次；守住位置：loadHostProcessEnvFromLocalFiles 的 seen 去重；改错故障：重复候选把先合并的新值翻回旧值，覆盖优先级不再单调。
// INV-08 .env 解析只接受合法键名并丢弃畸形行；守住位置：parseDotenv 的键名正则与等号判断；改错故障：带空格或连字符的键被当成合法变量下发，host 侧永远读不到期望的名字。
// INV-09 ZCode 与 ZAI 链接只在缺省时补齐；守住位置：applySelectedZCodeEnvLinks 的空值兜底；改错故障：无条件重算会用默认域名覆盖用户显式配置的自建端点，登录直接失败。
// INV-10 打包态二进制优先取内嵌制品，用户环境变量只作兜底；守住位置：resolveHostProcessBinaryEnv 的 bundledPath 提前返回；改错故障：本机遗留 CLI 覆盖随包 runtime，Agent 与桌面协议版本错配后启动即崩。
// INV-11 开发态必须默认走仓库 mock-cdn，显式开关才切公网 CDN；守住位置：resolveRemoteAssetDirs 的 isElectronAppPackaged 或开关分支；改错故障：默认切 CDN 后离线开发直接失败，远程连接拿不到资源。
// INV-12 mock-cdn 版本目录缺失时不得下发该路径；守住位置：resolveAvailableDevelopmentMockCdnDir；改错故障：WSL 或 SSH 重连先命中必然缺失的本地目录，遮蔽已有的 CDN 与 cache 回退。
// INV-13 remote 缓存目录可单独覆盖而不改 userData；守住位置：resolveRemoteAssetCacheDir 的 override 分支；改错故障：为复用正式版缓存而整体切换 userData，登录态与窗口状态被开发数据污染。
// INV-14 Main 对 Dynamic Workflow 键只有写与删两种动作，从不原样透传；守住位置：resolveDynamicWorkflowModeHostEnv 的三层分支；改错故障：透传后 production 包被本机环境变量自行打开灰度。
// INV-15 production 包必须删除继承的 Dynamic Workflow 键；守住位置：buildHostProcessEnv 里 delete 再 spread 的顺序；改错故障：空对象盖不住 inheritedEnv，灰度开关通过 shell 泄漏进正式版。
// INV-16 打包态必须删除 ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL；守住位置：buildHostProcessEnv 的 packagedDesktop 分支；改错故障：签名包拒绝已验证的随包 Helper，引导流程跳到过期的开发版应用。
// INV-17 telemetry 身份字段只由 host 可信注入，外部继承值一律被删除；守住位置：buildHostProcessEnv 的 delete 循环；改错故障：用户环境可伪造 uid、device 或 runtime surface，遥测数据失去可归因性。
// INV-18 运行形态走 ZCODE_RUNTIME_ENV 而不是 NODE_ENV；守住位置：buildHostProcessEnv 返回对象的运行时键；改错故障：被 shell 或测试框架复用的 NODE_ENV 污染 host、agent 与 Bash 的环境判断。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";
import type { ConnectOptions } from "@zcode/server/remote";
import { listSSHConfigAliasesFromLocalConfig } from "@zcode/services/node";
import { DEV_HELPER_APP_NAME, HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import {
  ZCODE_APP_VERSION_ENV,
  ZCODE_BUILD_COMMIT_ID_ENV,
  ZCODE_AGENT_RUNTIME,
  ZCODE_COMMIT,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  ZCODE_RUNTIME_ENV_KEY,
  ZCODE_VERSION,
  buildZCodeToolEnvPassthroughEnv,
  resolveRuntimeZCodeEndpointOrigin,
  resolveZaiBusinessBaseUrl,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
  normalizeDynamicWorkflowMode,
  readZCodeAgentTelemetryEnv,
  sanitizeZCodeRuntimeEnv,
  type SourceServerArtifactPolicy,
  type ZCodeRuntimeEnv,
} from "@zcode/shared";
import { resolvePlatformKeyForPackagedApp } from "../../scripts/target-platform.mjs";
import {
  getAppConfigDir,
  getDataBaseDir,
  ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV,
  ZCODE_WINDOWS_APP_INSTALL_DIR_ENV,
} from "@zcode/services/node";
import {
  resolveRemoteCdnBaseUrls as resolveOrderedRemoteCdnBaseUrls,
  type ResolveRemoteCdnOptions,
} from "./remoteCdn.js";
import { getElectronAppPath, isElectronAppPackaged } from "./desktopElectronApp.js";

declare const __ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__: Readonly<Record<string, string>> | undefined;

const isLocalDevelopmentRuntime = !isElectronAppPackaged();
export const desktopRuntimeEnv: ZCodeRuntimeEnv = isLocalDevelopmentRuntime
  ? "development"
  : "production";
// 身份看编译期 flavor 而不是 ZCODE_ENV：ZCODE_PREVIEW_IDENTITY=1 的生产后端构建同样是 Preview，
// 需要独立的应用名、Electron 数据目录和 Helper 安装子目录才能与正式版并排运行。
export const isPreviewPackagedRuntime =
  !isLocalDevelopmentRuntime && ZCODE_PRODUCT_FLAVOR === "preview";

// 归一：环境变量先 trim 再判空，纯空白等同于未设置，避免把一串空格当成合法覆盖值。
// 失败路径：读取缺失不抛错也不告警，直接回落调用方默认分支，保证启动期不因缺省环境中断。
function readRuntimeEnvOverride(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

// 不变量：该开关必须只认 1、true、yes、on 四种写法，大小写不敏感，其余取值一律视为关闭。
// 设计权衡：宁可误关不可误开，未知字符串按关闭处理，防止拼写错误意外打开测试隔离分支。
function isTruthyRuntimeEnvOverride(name: string): boolean {
  const value = readRuntimeEnvOverride(name)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

// e2e 运行的是生产构建，默认会和本机正式版 ZCode 共用 app name / userData，
// 触发 Electron 单实例锁后只激活已有窗口，Chromedriver 无法接管测试进程。
// 这里允许测试显式隔离运行时身份，正常桌面/远控路径保持原来的默认值。
// 覆盖优先级：ZCODE_DESKTOP_APPLICATION_NAME 高于运行形态默认值，e2e 靠它绕开 Electron 单实例锁。
// 分支：未打包必须取 ZCode Dev，preview 打包必须取 ZCode Preview，正式包必须取 ZCode，三者数据目录不能共享。
export const runtimeApplicationName =
  readRuntimeEnvOverride("ZCODE_DESKTOP_APPLICATION_NAME") ??
  (isLocalDevelopmentRuntime ? "ZCode Dev" : isPreviewPackagedRuntime ? "ZCode Preview" : "ZCode");
// Electron 的 app.getPath("home") 不一定跟随测试进程里的 HOME 覆盖。
// e2e 默认工作区依赖 home 路径，因此提供显式覆盖，避免测试写到开发者真实 ~/ZCodeProject。
// 失败路径：覆盖为空时返回 undefined，调用方回落到 Electron 的 home 目录推导，不会写进开发者真实工作区。
export const runtimeHomePath = readRuntimeEnvOverride("ZCODE_DESKTOP_HOME_DIR");
// Chromedriver 管理 Electron 时会注入临时 userData；e2e 默认路径模式下导入期不能提前读取 appData。
// 不变量：该开关只能在 e2e 显式注入时开启，正常桌面启动恒为 false，不改变线上目录布局。
// 资源生命周期：开启后不再计算 userData 路径，目录决定权交回 Chromedriver 注入的临时 user-data-dir。
export const shouldUseElectronDefaultUserDataPath = isTruthyRuntimeEnvOverride(
  "ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA",
);
// 覆盖优先级：ZCODE_DESKTOP_USER_DATA_DIR 高于 appData 下的应用名推导，测试可完全隔离用户数据。
// 分支：开关开启且无覆盖时返回 undefined，禁止在导入期提前触碰 appData，否则 Chromedriver 端口文件会写到另一个目录。
export const runtimeUserDataPath =
  readRuntimeEnvOverride("ZCODE_DESKTOP_USER_DATA_DIR") ??
  (shouldUseElectronDefaultUserDataPath
    ? undefined
    : join(getElectronAppPath("appData"), runtimeApplicationName));
// 不变量：session 目录必须永远挂在 userData 之下，userData 缺失时一并降级为 undefined，避免出现孤立 session 根。
export const runtimeSessionDataPath =
  readRuntimeEnvOverride("ZCODE_DESKTOP_SESSION_DATA_DIR") ??
  (runtimeUserDataPath ? join(runtimeUserDataPath, "session") : undefined);
// Chromedriver 会注入临时 --user-data-dir，并在该目录等待 DevToolsActivePort。
// e2e 如果再用 app.setPath 覆盖 userData/sessionData，端口文件会被写到另一个目录，
// 导致 Electron 已启动但 WebDriver session 一直创建失败。测试态打开该开关后保留 Chromedriver 的目录。
export const hostModulePath = join(import.meta.dirname, "../host/index.js");
export const schedulerModulePath = join(import.meta.dirname, "../scheduler/index.js");
export function getCredentialsDir() {
  return getAppConfigDir();
}

export type RemoteAssetDirs = Pick<
  ConnectOptions,
  "mockCdnDir" | "remoteCdnBaseUrl" | "remoteCdnBaseUrls" | "remoteCacheDir"
> & {
  sourceServerArtifactPolicy?: SourceServerArtifactPolicy;
};
type LocalRuntimeEnv = Record<string, string | undefined>;

export async function isDockerDaemonAvailable(): Promise<boolean> {
  const { isDockerAvailable } = await import("@zcode/server/remote");
  return isDockerAvailable();
}

export async function listAvailableWSLDistros() {
  const { listWSLDistros } = await import("@zcode/server/remote");
  return listWSLDistros();
}

export async function listAvailableDockerContainers() {
  const { listDockerContainers } = await import("@zcode/server/remote");
  return listDockerContainers();
}

export async function listSSHConfigAliases() {
  return await listSSHConfigAliasesFromLocalConfig();
}

// 不变量：只接受字母或下划线开头的变量名，注释行、空行与不含等号的行直接丢弃。
// 归一：剥离可选的 export 前缀与成对引号，值内部空格必须保留，使 .env 与 shell 写法行为一致。
// 失败路径：单行格式异常只跳过该行，不中断整个文件解析，缺一个键不至于让整批配置失效。
function parseDotenv(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let value = normalized.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

// 不变量：仅当候选根目录存在 pnpm-workspace.yaml 时才认作 workspace 根，否则返回 null 并跳过仓库级 .env。
function resolveWorkspaceRootForEnvFiles(): string | null {
  const workspaceRootCandidate = resolve(import.meta.dirname, "../../../..");
  return existsSync(join(workspaceRootCandidate, "pnpm-workspace.yaml"))
    ? workspaceRootCandidate
    : null;
}

// 分支：打包态直接返回编译期 telemetry 环境，不在用户机器上探测任何本地文件。
// 加载顺序：workspace 级 .env 先合并，desktop 级后合并，后者覆盖前者，符合就近配置优先原则。
// 并发与幂等：seen 集合保证同一绝对路径只解析一次，重复候选不会把旧值翻回新值之上。
// 设计权衡：加载范围收敛到 workspace 根与 desktop 包目录，不能做 cwd 向上泛搜，避免读到工作区外的同名配置。
export function loadHostProcessEnvFromLocalFiles(): Record<string, string> {
  if (isElectronAppPackaged()) {
    return resolvePackagedAgentTelemetryEnv();
  }

  const desktopRoot = resolve(import.meta.dirname, "../..");
  const workspaceRoot = resolveWorkspaceRootForEnvFiles();
  const fileCandidates = [
    ...(workspaceRoot
      ? [resolve(workspaceRoot, ".env"), resolve(workspaceRoot, ".env.local")]
      : []),
    // 开发态 host process 不经过 Vite，自行加载相同的 .env 文件以保持 OAuth 配置一致。
    ...(workspaceRoot && isLocalDevelopmentRuntime
      ? [
          resolve(workspaceRoot, ".env.development"),
          resolve(workspaceRoot, ".env.development.local"),
        ]
      : []),
    resolve(desktopRoot, ".env"),
    resolve(desktopRoot, ".env.local"),
    ...(isLocalDevelopmentRuntime
      ? [resolve(desktopRoot, ".env.development"), resolve(desktopRoot, ".env.development.local")]
      : []),
  ];

  const merged: Record<string, string> = {};
  const seen = new Set<string>();

  for (const candidate of fileCandidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (!existsSync(candidate)) {
      continue;
    }

    // 之前按 cwd 向上级目录泛搜 .env，容易误读到工作区外的同名文件。
    // 这里将加载范围收敛为 workspace 根与 desktop 包目录，避免配置来源漂移。
    const parsed = parseDotenv(readFileSync(candidate, "utf-8"));
    Object.assign(merged, parsed);
  }

  return applySelectedZCodeEnvLinks(merged);
}

// 不变量：只允许 OTLP 连接字段进入 Main，UID、Device MID 与 runtime surface 绝不能从此处透出。
// 失败路径：编译期未注入该常量时返回空对象，Agent 侧按未配置处理，不会因 undefined 抛错。
export function resolvePackagedAgentTelemetryEnv(
  compiledEnv:
    | Readonly<Record<string, string>>
    | undefined = typeof __ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__ === "undefined"
    ? undefined
    : __ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__,
): Record<string, string> {
  if (!compiledEnv) {
    return {};
  }

  // 修复原因：开发版通过启动进程继承 OTLP 配置，正式安装包从 Finder/开始菜单启动时没有
  // 这组运行时环境，Agent 因而静默落入 Noop。构建默认值只允许连接字段进入 Main；
  // UID、Device MID 和 runtime surface 仍由 Host 的可信运行时上下文生成。
  return readZCodeAgentTelemetryEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: compiledEnv.OTEL_EXPORTER_OTLP_ENDPOINT,
    OTEL_EXPORTER_OTLP_HEADERS: compiledEnv.OTEL_EXPORTER_OTLP_HEADERS,
    OTEL_SERVICE_NAME: compiledEnv.OTEL_SERVICE_NAME,
    ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION: compiledEnv.ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION,
  });
}

function resolveDevelopmentMockCdnDir(): string {
  return join(import.meta.dirname, "../../mock-cdn");
}

// 不变量：只有当前版本的 releases 子目录存在时才返回 mock-cdn，否则返回 undefined 让上层走 CDN。
// 失败路径：版本目录缺失仍下发 mock 路径，会让远程重连先命中必然缺失的本地目录，遮蔽已有的缓存回退。
function resolveAvailableDevelopmentMockCdnDir(): string | undefined {
  const mockCdnDir = resolveDevelopmentMockCdnDir();
  const releaseDir = join(mockCdnDir, "releases", ZCODE_VERSION);
  // 开发态 mock-cdn 是可选离线缓存。当前版本目录不存在时继续传 mockCdnDir，
  // 会让 WSL/SSH 重连先命中一个必然缺失的本地路径，遮蔽已有的 CDN/cache fallback。
  return existsSync(releaseDir) ? mockCdnDir : undefined;
}

// 归一：undefined 与空白先判否，再统一转小写比较，避免大小写差异让开关静默失效。
function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

// 不变量：开发态默认走 mock-cdn，只有 ZCODE_DEV_REMOTE_ASSET_USE_CDN 为真时才切到公网 CDN。
function shouldUseRemoteCdnInDevelopment(localEnv: LocalRuntimeEnv = {}): boolean {
  return isTruthyEnvFlag(resolveEnvValue("ZCODE_DEV_REMOTE_ASSET_USE_CDN", localEnv));
}

function resolveRemoteCdnBaseUrls(
  options: ResolveRemoteCdnOptions = {},
  localEnv: LocalRuntimeEnv = {},
): string[] {
  const raw = resolveEnvValue("ZCODE_REMOTE_ASSET_CDN_BASE_URL", localEnv);
  return resolveOrderedRemoteCdnBaseUrls({
    ...options,
    env: ZCODE_ENV,
    overrideBaseUrl: raw,
    version: ZCODE_VERSION,
  });
}

// 覆盖优先级：process.env 高于传入的本地 env 快照，命令行临时验证不必改写 .env 文件。
// 归一：两层取值都先 trim 再去空，空串视为未设置，禁止空值遮蔽下层的有效配置。
function resolveEnvValue(envName: string, localEnv: LocalRuntimeEnv = {}): string | undefined {
  return process.env[envName]?.trim() || localEnv[envName]?.trim() || undefined;
}

// 优先级链：ZCODE_BASE_URL 高于 ZCODE_ENDPOINT_ORIGIN 高于按 ZCODE_ENV 选中的 scoped 变量，进程环境整层高于本地 env。
// 分支：production 必须取 ZCODE_PRODUCTION_BASE_URL，其余环境必须取 ZCODE_TEST_BASE_URL，两者不能串用。
// 失败路径：六层全部为空时返回 undefined，由上层回落到线上默认地址，而不是返回空串。
export function resolveZCodeEndpointEnvBaseOrigin(
  localEnv: LocalRuntimeEnv = {},
): string | undefined {
  const scopedEnvName =
    ZCODE_ENV === "production" ? "ZCODE_PRODUCTION_BASE_URL" : "ZCODE_TEST_BASE_URL";
  // Bugfix: main 进程临时验证更新服务时不会重新写 .env，命令行传入的 endpoint 必须优先于本地文件。
  return (
    process.env["ZCODE_BASE_URL"]?.trim() ||
    process.env["ZCODE_ENDPOINT_ORIGIN"]?.trim() ||
    process.env[scopedEnvName]?.trim() ||
    localEnv.ZCODE_BASE_URL?.trim() ||
    localEnv.ZCODE_ENDPOINT_ORIGIN?.trim() ||
    localEnv[scopedEnvName]?.trim() ||
    undefined
  );
}

// 不变量：只拷贝字符串型条目，必须过滤已删除或非字符串的键，产出可直接展开的纯净快照。
function readDefinedProcessEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      values[key] = value;
    }
  }
  return values;
}

// 不变量：endpoint、OAuth origin、business base 与 client id 仅在缺省时补齐，显式配置永远优先。
// 设计权衡：以 ZCODE_ENV 作为解析上下文，测试与生产各自指向对应后端，不靠调用方重复传参。
function applySelectedZCodeEnvLinks(env: Record<string, string>): Record<string, string> {
  const endpointEnv = {
    ...env,
    ZCODE_ENV,
  };

  return {
    ...env,
    ZCODE_BASE_URL: env.ZCODE_BASE_URL ?? resolveRuntimeZCodeEndpointOrigin(endpointEnv),
    ZAI_OAUTH_ORIGIN: env.ZAI_OAUTH_ORIGIN ?? resolveZaiOAuthOrigin(endpointEnv),
    ZAI_BUSINESS_BASE_URL: env.ZAI_BUSINESS_BASE_URL ?? resolveZaiBusinessBaseUrl(endpointEnv),
    ZAI_OAUTH_CLIENT_ID: env.ZAI_OAUTH_CLIENT_ID ?? resolveZaiOAuthClientId(endpointEnv),
  };
}

// 不变量：host 运行形态只由 desktopRuntimeEnv 决定，不从会被 shell 复用的 NODE_ENV 反推。
function resolveHostProcessNodeEnv(): ZCodeRuntimeEnv {
  return desktopRuntimeEnv;
}

// 覆盖优先级：ZCODE_REMOTE_ASSET_CACHE_DIR 高于 userData 下的 remote-assets-cache 默认路径，便于复用正式版缓存验证下载判断。
// 设计权衡：只换缓存目录、不能换 userData，避免开发态污染登录态、窗口状态等其它数据。
function resolveRemoteAssetCacheDir(localEnv: LocalRuntimeEnv = {}): string {
  const overrideCacheDir = resolveEnvValue("ZCODE_REMOTE_ASSET_CACHE_DIR", localEnv);
  if (overrideCacheDir) {
    // 开发态需要复用正式版 remote cache 验证下载判断，但不能整体切换 Electron userData。
    // 因此只允许覆盖 remote assets cache 目录，避免污染登录态、窗口状态等其它开发数据。
    return resolve(overrideCacheDir);
  }

  return join(getElectronAppPath("userData"), "remote-assets-cache");
}

// 分支：打包态或开发态显式开启 CDN 时统一走 CDN 加本地缓存目录，不暴露安装包内 remote-assets 路径。
// 不变量：开发态默认只读仓库 mock-cdn，保证离线开发可用，同时保留提前验证真实 CDN 链路的入口。
// 资源生命周期：remote 资源不再与 desktop 本地 provider 共用包内路径，避免整套 Linux 运行时被打进安装包。
// 设计权衡：sourceServerArtifactPolicy 由未打包形态决定而非 ZCODE_ENV，dev:desktop 取 production 时仍能刷新同版本制品。
export function resolveRemoteAssetDirs(
  options: ResolveRemoteCdnOptions = {},
  localEnv: LocalRuntimeEnv = {},
): RemoteAssetDirs {
  const remoteCdnBaseUrls = resolveRemoteCdnBaseUrls(options, localEnv);
  const remoteCdnBaseUrl = remoteCdnBaseUrls[0];

  // remote 资源之前和 desktop 本地 provider 资源共用安装包内路径，
  // 结果打包后会把整套 Linux 远程运行时一起塞进 .app，和“remote 资源走 CDN / mock-cdn”的职责边界冲突。
  // 这里改成显式分流：开发态只读仓库里的 mock-cdn；生产态统一走 CDN + 本地缓存目录，
  // 不再暴露任何安装包内 remote-assets 路径，避免 remote 资源再次被塞回安装包。
  // 功能开关：开发态默认继续走 mock-cdn，只有显式打开开关才切到公网 CDN。
  // 这样能兼容离线开发场景，同时允许在开发环境提前验证真实 CDN 下载链路。
  if (isElectronAppPackaged() || shouldUseRemoteCdnInDevelopment(localEnv)) {
    return {
      remoteCdnBaseUrl,
      remoteCdnBaseUrls,
      remoteCacheDir: resolveRemoteAssetCacheDir(localEnv),
    };
  }

  const developmentMockCdnDir = resolveAvailableDevelopmentMockCdnDir();
  return {
    ...(developmentMockCdnDir ? { mockCdnDir: developmentMockCdnDir } : {}),
    // Bug 原因：ZCODE_ENV 表示测试/生产产品环境，dev:desktop 也可能取 production；
    // 同版本开发制品刷新必须由未打包 Electron 这一运行形态显式授权。
    sourceServerArtifactPolicy: "development-content-addressed",
    remoteCdnBaseUrl,
    remoteCdnBaseUrls,
    remoteCacheDir: resolveRemoteAssetCacheDir(localEnv),
  };
}

// 候选顺序：打包态先取 resourcesPath 内嵌目录，再依次尝试 cwd 与模块相对路径，命中首个存在的文件即返回。
// 失败路径：全部候选都不存在时返回 undefined，由调用方决定报错还是回落用户显式路径。
function resolveBundledZCodeAgentBinaryPath(): string | undefined {
  const runtime = ZCODE_AGENT_RUNTIME;
  const entrySegments = runtime.resolveEntrySegments(process.platform);
  const platformKey = resolvePlatformKeyForPackagedApp();
  const candidates = [
    isElectronAppPackaged()
      ? join(process.resourcesPath, runtime.bundledResourceDir, ...entrySegments)
      : null,
    // desktop 开发态的启动 cwd 可能是 packages/desktop，也可能是仓库根，
    // 之前这里只按 import.meta.dirname 的相对路径推导 bundled-agents，
    // 这里补齐和 services 侧一致的多候选根目录，避免开发/构建/重启入口不同导致资源解析漂移。
    join(
      process.cwd(),
      "bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
    join(
      process.cwd(),
      "packages",
      "desktop",
      "bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
    join(
      import.meta.dirname,
      "../../bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}

// 归一：win32 必须自动补 .exe 后缀，其余平台用裸名，避免同一工具在不同平台拼出错误文件名。
function resolveBundledRuntimeToolBinaryPath(
  toolDir: string,
  binaryName: string,
): string | undefined {
  const candidateBinaryName = process.platform === "win32" ? `${binaryName}.exe` : binaryName;
  const candidates = [
    isElectronAppPackaged()
      ? join(process.resourcesPath, "tools", toolDir, candidateBinaryName)
      : null,
    join(
      import.meta.dirname,
      "../../bundled-tools",
      resolvePlatformKeyForPackagedApp(),
      toolDir,
      candidateBinaryName,
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}

// 不变量：lark-cli 只从内嵌工具目录解析，不读用户 PATH，防止外部版本漂移破坏协议适配。
function resolveBundledLarkCliBinaryPath(): string | undefined {
  return resolveBundledRuntimeToolBinaryPath("lark-cli", "lark-cli");
}

export function resolveBundledGlmBinaryPath(): string | undefined {
  return resolveBundledZCodeAgentBinaryPath();
}

// 优先级：随包 runtime 恒高于 GLM_BINARY_PATH 等显式路径，保证 Agent 与桌面协议版本严格绑定。
// 失败路径：内嵌缺失且显式路径不存在时返回 undefined，绝不返回一个必然打不开的路径。
// 设计权衡：仅在制品缺失时才信任用户环境变量，既保留可调试性又不让本机 CLI 覆盖内嵌版本。
function resolveHostProcessBinaryEnv(
  envVar: string,
  hostProcessLocalEnv: Record<string, string>,
  bundledPath: string | undefined,
): string | undefined {
  // ZCode Agent 与 app 协议适配强绑定版本，生产包必须优先使用随包携带的固定 runtime。
  // 用户机器或本地 .env 里残留的 GLM_BINARY_PATH 即使存在，也可能版本不兼容。
  // 只有 bundled runtime 缺失时才把显式路径作为兜底，避免用户本机 CLI 覆盖内嵌版本。
  if (bundledPath) {
    return bundledPath;
  }
  const explicitPath = process.env[envVar]?.trim() || hostProcessLocalEnv[envVar]?.trim();
  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }
  return undefined;
}

// 不变量：仅 win32 且打包态返回安装根目录，其余组合一律 undefined，防止把非安装目录当成可清理的数据根。
export function resolveWindowsAppInstallDirForDataBaseDirGuard(
  options: {
    platform?: NodeJS.Platform | string;
    isPackaged?: boolean;
    resourcesPath?: string;
  } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const packaged = options.isPackaged ?? isElectronAppPackaged();
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  if (platform !== "win32" || !packaged) {
    return undefined;
  }

  const trimmedResourcesPath = resourcesPath?.trim();
  if (!trimmedResourcesPath) {
    return undefined;
  }

  return win32.dirname(trimmedResourcesPath);
}

/**
 * Dynamic Workflow 灰度的本地覆盖按构建档位分三层
 *
 *   - 未打包 dev：透传 shell 里的合法取值，方便手工切档；非法值直接丢弃而不是转发给 Host，
 *     Host 因此不必再判一次来源；
 *   - 打包 preview：固定写入 `alwaysOn`，忽略 shell，preview 用户始终拥有该功能；
 *   - 打包 production：不写入，且继承值必须被删除，否则本机环境变量就能自行打开灰度。
 * Main 是唯一决策者：对这个键只有「写」和「删」两种动作，绝不原样透传，
 * Host 端的 resolveDynamicWorkflowClientConfig 才能无条件相信读到的值。
 */
// 分支：未打包透传经归一后的合法取值，packaged preview 固定 alwaysOn，packaged production 返回空对象。
// 失败路径：未打包时非法取值被丢弃而非转发，Host 端因此无需再判来源即可信任读到的值。
// 不变量：Main 对该键只有写与删两种动作，从不原样透传继承值。
export function resolveDynamicWorkflowModeHostEnv(options: {
  inheritedValue: string | undefined;
  isPackaged: boolean;
  isPreview: boolean;
}): Record<string, string> {
  if (!options.isPackaged) {
    const mode = normalizeDynamicWorkflowMode(options.inheritedValue);
    return mode ? { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: mode } : {};
  }
  if (options.isPreview) {
    return { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: "alwaysOn" };
  }
  return {};
}

// 不变量：telemetry 身份字段在合并后统一删除，外部环境无法伪造 uid、device 或 runtime surface。
// 失败路径：Dynamic Workflow 键先无条件删除再按决策 spread 回去，否则空对象盖不住继承值，正式包会被本机变量打开。
// 资源生命周期：OTLP 凭据必须只定向注入 host，host 初始化后即从进程环境清除，不能进入 Bash、MCP 与 tool env。
// 设计权衡：preview 只隔离 computer-use 运行组件，不能改写业务数据根，两个版本得以共享任务、配置与凭据。
export function buildHostProcessEnv(hostProcessLocalEnv: Record<string, string>) {
  const glmBinaryPath = resolveBundledGlmBinaryPath();
  const larkCliBinaryPath = resolveBundledLarkCliBinaryPath();
  const resolvedGlmBinaryPath = resolveHostProcessBinaryEnv(
    "GLM_BINARY_PATH",
    hostProcessLocalEnv,
    glmBinaryPath,
  );
  const resolvedLarkCliBinaryPath = resolveHostProcessBinaryEnv(
    "ZCODE_LARK_CLI_BINARY",
    hostProcessLocalEnv,
    larkCliBinaryPath,
  );
  const dataBaseDir = getDataBaseDir();
  const rawInheritedEnv = {
    ...hostProcessLocalEnv,
    ...readDefinedProcessEnv(),
  };
  const packagedDesktop = isElectronAppPackaged();
  const bundledCuaHelperAppPath =
    process.platform !== "darwin"
      ? undefined
      : packagedDesktop
        ? join(process.resourcesPath, "cua-helper", HELPER_APP_NAME)
        : // Truthy grammar must match the producer's isUnsignedHelperLocalDevRequested
          // (1|true|on, case-insensitive). Accepting only the literal "1" silently
          // ignored `true`/`on` set by scripts following the documented dev flow.
          ["1", "true", "on"].includes(
              rawInheritedEnv.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL?.trim().toLowerCase() ?? "",
            )
          ? rawInheritedEnv.ZCODE_CUA_BUNDLED_HELPER_APP_PATH?.trim() ||
            join(
              rawInheritedEnv.ZCODE_HOME?.trim() || join(homedir(), ".zcode"),
              "computer-use",
              "dev",
              DEV_HELPER_APP_NAME,
            )
          : undefined;
  const windowsAppInstallDir = resolveWindowsAppInstallDirForDataBaseDirGuard();
  const agentTelemetryEnv = readZCodeAgentTelemetryEnv(rawInheritedEnv);
  // Desktop 身份由 host 从凭据仓库和本机状态读取后可信注入；外部环境只能配置 OTLP 连接，
  // 不能伪造 uid/device/runtime surface 或绕过本地 identity state 的隔离边界。
  for (const key of [
    "ZCODE_TELEMETRY_USER_ID",
    "ZCODE_TELEMETRY_USER_ID_HASH",
    "ZCODE_TELEMETRY_USER_SUBJECT_ID",
    "ZCODE_TELEMETRY_IDENTITY_STATE",
    "ZCODE_TELEMETRY_DEVICE_MID",
    "ZCODE_TELEMETRY_RUNTIME_SURFACE",
  ]) {
    delete agentTelemetryEnv[key];
  }
  const inheritedEnv = applySelectedZCodeEnvLinks({
    ...sanitizeZCodeRuntimeEnv(rawInheritedEnv),
    ...buildZCodeToolEnvPassthroughEnv(rawInheritedEnv),
  });
  // A release app must never inherit the local unsigned-Helper escape hatch.
  // Otherwise a developer shell/launchctl variable can make the signed app
  // reject its verified bundled Helper and route onboarding to a stale dev app.
  if (packagedDesktop) {
    delete inheritedEnv.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL;
  }
  const dynamicWorkflowModeHostEnv = resolveDynamicWorkflowModeHostEnv({
    inheritedValue: rawInheritedEnv[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV],
    isPackaged: packagedDesktop,
    isPreview: isPreviewPackagedRuntime,
  });
  // 三层里有两层不写这个键，空对象无法覆盖 inheritedEnv，所以先无条件删掉继承值再按决策 spread 回去。
  // 少了这一行，production 包和 dev 的非法取值都会原样穿透到 Host。
  delete inheritedEnv[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV];

  return {
    ...inheritedEnv,
    // OTLP 凭据只定向传到 host；host 初始化 services 时会立即捕获并从 process.env 清除，
    // 后续只在启动 Agent 时短暂注入，不会进入 Bash/MCP/tool env。
    ...agentTelemetryEnv,
    // ZCode 运行时不再使用 NODE_ENV；它会被用户 shell、包管理器和测试框架复用。
    // 这里显式下发 ZCODE_RUNTIME_ENV，并在继承环境里清掉 NODE_ENV，避免 host/agent/Bash 被污染。
    [ZCODE_RUNTIME_ENV_KEY]: resolveHostProcessNodeEnv(),
    // 显式注入编译期产品身份，保证主进程与 host 的身份语义一致；地址独立解析。
    // inheritedEnv 从 .env 通用变量补齐 ZCode/ZAI 链接，未覆盖时统一使用线上默认值。
    ZCODE_ENV,
    // Preview 与生产版共享任务、配置和凭据，但不同版本的 Helper 不能互相覆盖或触发降级保护。
    // 只隔离 computer-use 下的运行组件，不改写 ZCODE_HOME / ZCODE_DATA_BASE_DIR 业务数据根。
    ...(isPreviewPackagedRuntime ? { ZCODE_CUA_HELPER_INSTALL_VARIANT: "preview" } : {}),
    // Dynamic Workflow 灰度的本地覆盖：Main 决策后写入，production 包为空对象（继承值已在上面删除）。
    ...dynamicWorkflowModeHostEnv,
    // 模型请求默认 header 由 agent 进程构造，过去只继承 shell env 导致桌面启动时拿不到 app 版本。
    // 这里从 main 进程显式下发，agent 子进程继承 host env 后即可稳定写入请求 header。
    [ZCODE_APP_VERSION_ENV]: ZCODE_VERSION,
    // Telemetry 的构建身份必须来自 Desktop 编译期元数据，不能让 Agent 在运行时读取
    // 工作树或根据安装路径猜测；否则同一产品版本的不同修复包无法在 ARMS 中区分。
    [ZCODE_BUILD_COMMIT_ID_ENV]: ZCODE_COMMIT,
    ...(dataBaseDir !== homedir() ? { ZCODE_DATA_BASE_DIR: dataBaseDir } : {}),
    ...(windowsAppInstallDir ? { [ZCODE_WINDOWS_APP_INSTALL_DIR_ENV]: windowsAppInstallDir } : {}),
    ...(bundledCuaHelperAppPath
      ? { [ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV]: bundledCuaHelperAppPath }
      : {}),
    ...(resolvedGlmBinaryPath ? { GLM_BINARY_PATH: resolvedGlmBinaryPath } : {}),
    ...(resolvedLarkCliBinaryPath ? { ZCODE_LARK_CLI_BINARY: resolvedLarkCliBinaryPath } : {}),
  };
}
