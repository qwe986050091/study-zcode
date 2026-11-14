// Workspace Hook 的发现、排序、信任判定与落盘（Node 侧唯一实现）。
// 上层（UI / RPC / runtime adapters）只消费 Hook[]，不重新解析配置文件。
// 本文件不执行 hook，只产出「谁、按什么顺序、是否已信任」；超时与失败隔离由
// runtime 执行器按 hook.timeout 处理，因此这里不引入任何默认超时。
//
// INV-01：返回顺序即执行顺序「项目 → 项目 legacy → 用户 zcode → 用户 legacy」（守住位置：loadHooksImpl 的数组拼接；破坏：用户 hook 抢在项目前执行，拦截/改写被覆盖）。
// INV-02：location 决定回写 scope，无 location 才视为用户级 zcode hook（守住位置：saveHooksImpl 两个 filter；破坏：.claude 的 hook 被写进 config.json，产生幽灵 hook）。
// INV-03：配置读取失败一律降级为空，绝不抛出（守住位置：readJsonFile 的 catch；破坏：单个坏文件让设置页整页失败）。
// INV-04：trust store 是权限边界，读取失败/结构非法必须 fail-closed 且与 runtime 同判（守住位置：readPersistentWorkspaceHookTrustDigests；破坏：UI 显示已信任而 runtime 硬拦截）。
// INV-05：写入只做「保留既有键 + 覆盖 hooks」的原子替换（守住位置：writeZCodeHooksConfig 的 spread；破坏：features/storage 被清空，数据目录与登录态回退默认）。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  Hook,
  HookEvent,
  SettingsDirectoryLocation,
  SettingsDirectorySource,
} from "@zcode/shared";
import {
  buildWorkspaceHookBundleSnapshot,
  createWorkspaceHookSourceInput,
  readWorkspaceHookProjectSources,
  resolveWorkspaceHookRuntimeRoot,
  workspaceHooksConfigSchema,
  type WorkspaceHookBundleSnapshotData,
  type WorkspaceHookSourceInput,
  type WorkspaceHooksConfig,
} from "@zcode/shared/workspace-hook-discovery";
import { parseWorkspaceHookTrustStoreContent } from "@zcode/shared/workspace-hook-trust-store-file";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import type { IHooksService } from "./hooks.js";
import { atomicWriteWorkspaceHookConfig } from "./workspaceHookConfigMutation.js";
import {
  fromLegacyHooksConfig,
  fromProjectSnapshot,
  fromUserZCodeSource,
  resolveNextRootEnabled,
  toZCodeHooksEvents,
  type LegacyHooksConfig,
} from "./workspaceHookSettingsModel.js";

// 两个文件名固定：zcode 读写 config.json，legacy 兼容面只读 settings.json；
// 写反会让 runtime 加载不到 UI 刚保存的 hook。
const SETTINGS_FILE = "settings.json";
const ZCODE_CONFIG_FILE = "config.json";
const HOOK_EVENTS: readonly HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
];

interface ZCodeConfigFile {
  hooks?: WorkspaceHooksConfig;
  [key: string]: unknown;
}

// HOME/USERPROFILE 优先于 os.homedir()：宿主进程可能带被改写的 HOME（测试沙箱、
// 便携安装），直接取进程默认值会读到错误用户目录，表现为「hook 配置凭空消失」。
function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

// 目录布局是跨端契约：项目级 zcode 用 <workspace>/.zcode，用户级却是 <home>/.zcode/cli；少一层 cli 会让 UI 与 runtime 读到不同文件。
function getRootDir(source: SettingsDirectorySource, workspacePath?: string): string {
  const baseDir = workspacePath ?? resolveUserHomeDir();
  if (source === "zcode") {
    return workspacePath ? join(baseDir, ".zcode") : join(baseDir, ".zcode", "cli");
  }
  return join(baseDir, source === "agents" ? ".agents" : ".claude");
}

// 路径拼接统一走这里，避免各调用点各自拼 .zcode/config.json 而产生第二种布局。
function getConfigPath(source: SettingsDirectorySource, workspacePath?: string): string {
  return join(
    getRootDir(source, workspacePath),
    source === "zcode" ? ZCODE_CONFIG_FILE : SETTINGS_FILE,
  );
}

// scope 由 workspacePath 是否存在决定而非 source：同一个 .agents 目录在项目内是 project、用户目录下是 user，回写时据此分流。
function buildLocation(
  source: SettingsDirectorySource,
  workspacePath?: string,
): SettingsDirectoryLocation {
  return {
    source,
    scope: workspacePath ? "project" : "user",
    directoryPath: getRootDir(source, workspacePath),
    ...(workspacePath ? { projectPath: workspacePath } : {}),
  };
}

// 只接受普通对象：null 与数组也能通过 typeof 检查，放行会让后续属性访问抛错。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 白名单必须与 HookEvent 联合类型同步；漏一个事件名，legacy 配置里该事件会被静默丢弃。
function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

// 用 error.code 判定 ENOENT 而非匹配 message：message 会随系统语言本地化。
function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

// 统一「读不到就当没有」：缺失、JSON 损坏、顶层非对象都返回 null。
// [失败路径] 这是刻意不报错——设置页要读 5 个来源，坏文件不该拖垮整页；代价是坏 JSON 表现为空配置，用户重新保存即修复。
async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

// 用户级 zcode 是唯一可编辑来源：discoveryOrder 固定 0，写入也只会回写这一个文件。
async function readUserZCodeSource(): Promise<WorkspaceHookSourceInput | undefined> {
  const path = getConfigPath("zcode");
  const config = await readJsonFile<Record<string, unknown>>(path);
  const parsed = workspaceHooksConfigSchema.safeParse(config?.hooks);
  if (!parsed.success) return undefined;
  return {
    ...createWorkspaceHookSourceInput({
      path,
      workingDirectory: resolveUserHomeDir(),
      hooks: parsed.data,
      discoveryOrder: 0,
      explicitProjectConfig: true,
    }),
    editable: true,
  };
}

// .agents/.claude 是只读兼容来源；解析失败在 fromLegacyHooksConfig 内降级为空数组，不影响其它来源。
async function loadLegacyHooksFromLocation(
  source: "agents" | "claude",
  workspacePath?: string,
): Promise<Hook[]> {
  return fromLegacyHooksConfig({
    legacyConfig: await readJsonFile<LegacyHooksConfig>(getConfigPath(source, workspacePath)),
    location: buildLocation(source, workspacePath),
    isHookEvent,
  });
}

// [失败路径] trust 读取结论同时决定 UI 展示与 runtime 是否放行，
// 因此只允许返回「空集」或「完整可信集合」，绝不返回部分 digest。
/**
 * 读取持久化 workspace hook trust digest 集合。
 *
 * 整个函数不能包在 `try { ... } catch { return new Set(); }` 里：
 * 文件损坏/不可读与「无 trust 记录」无法区分且零诊断。根因：trust store 读取失败被
 * 吞掉后，调用方只能把所有 hook 标记为 `pending_trust`（"需要审核"），而 Runtime 侧
 * 对 trust store 损坏显式检测并以 `blocked_untrusted` 硬拦截——用户看到一条审核入口
 * 但无论怎样审批，Runtime 都不会放行。此为展示/运行时分歧（两侧均 fail-closed）。
 *
 * 手写的局部字段校验（isRecord + digest 正则）与 runtime/adapters
 * 使用的完整 strict schema 结论不一致——"JSON 合法但结构非法"（缺 schemaVersion、
 * 非法 decision、非法时间戳、未知字段等）的文件会被本层当作部分可信，runtime 却判
 * corrupt 全部阻断，UI 展示"已信任"而 Hook 永不执行。信任存储是权限边界，所有消费
 * 者必须对同一文件得出同一结论：改用 shared 的
 * parseWorkspaceHookTrustStoreContent（contracts schema 的单一权威下沉实现），
 * 任何 parse 失败一律 corrupt + fail-closed，不返回任何部分 digest。
 *
 * 注意：存储目录解析（storage.dir 的 ~/、相对路径处理）与 Runtime 侧
 * resolveWorkspaceHookTrustStorePath（adapters）逻辑等价但各自内联——架构上 services
 * 不应反向依赖 adapters，统一需下沉到 shared 层，此处仅记录该重复。
 */
async function readPersistentWorkspaceHookTrustDigests(
  workspaceIdentity: string,
  logger: ServiceLogger,
): Promise<{ digests: Set<string>; corrupt: boolean }> {
// storage.dir 允许 ~/、绝对路径、相对路径三种写法，必须按序归一；漏掉相对路径分支会让 trust 文件落到 cwd，换个启动目录就读不到既往信任。
  const userConfig = (await readJsonFile<Record<string, unknown>>(getConfigPath("zcode"))) ?? {};
  const storage = isRecord(userConfig.storage) ? userConfig.storage : {};
  const configured = typeof storage.dir === "string" ? storage.dir.trim() : "";
  const home = resolveUserHomeDir();
  const storageRoot = configured
    ? configured.startsWith("~/")
      ? join(home, configured.slice(2))
      : isAbsolute(configured)
        ? resolve(configured)
        : resolve(home, configured)
    : join(home, ".zcode");
// 文件名带 -v1：格式升级必须换文件名，旧版本才能安全地把它当作「不存在」。
  const trustFilePath = join(storageRoot, "security", "workspace-hook-trust-v1.json");

  // 异步读取 + ENOENT 区分：不用 existsSync 预检——同步调用会阻塞服务
  // 线程，且「检查→读取」之间存在 TOCTOU 窗口；readFile 的 ENOENT 本身就是
  // 权威的"文件不存在"信号。
  let content: string;
  try {
    content = await readFile(trustFilePath, "utf8");
  } catch (error) {
// [失败路径] 只有 ENOENT 算「无记录」；EACCES/EMFILE 必须标记 corrupt 并告警，否则权限问题会被误判成「从未信任」。
    if (isNodeError(error, "ENOENT")) {
      // 文件不存在 ⇒ 合理无记录，返回空集且不标记 corrupt。
      return { digests: new Set<string>(), corrupt: false };
    }
    // services 层曾直接 console.warn，无法进入统一服务日志文件，也无法在
    // 测试中注入 sink。改用可注入 ServiceLogger；此为低频可恢复降级，使用 warn。
    logger.warn(
      undefined,
      "Workspace Hook Trust store 不可读，已 fail-closed 忽略全部持久信任记录",
      {
        path: trustFilePath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return { digests: new Set<string>(), corrupt: true };
  }

  // JSON 语法错误与 schema 校验失败统一判 corrupt（与 runtime/adapters 同判）。
// 复用 shared 的 strict schema：services 与 adapters 必须对同一份文件得出同一结论，否则展示与执行分歧。
  const parsedStore = parseWorkspaceHookTrustStoreContent(content);
  if (parsedStore.status === "invalid") {
    logger.warn(
      undefined,
      "Workspace Hook Trust store 结构不符合 schema，已 fail-closed 忽略全部持久信任记录",
      { path: trustFilePath },
    );
    return { digests: new Set<string>(), corrupt: true };
  }

// 只按 workspaceIdentity 过滤，不按路径聚合：远程 workspace 的 identity 与本地路径不同，按路径过滤会让远端信任永远匹配不上。
  const digests = new Set<string>(
    parsedStore.file.records
      .filter((record) => record.workspaceIdentity === workspaceIdentity)
      .map((record) => record.hookDeclarationDigest),
  );
  return { digests, corrupt: false };
}

async function loadHooksImpl(
  params: {
    workspaceIdentity?: string;
    workspacePath: string;
    scope?: "all" | "user";
  },
  logger: ServiceLogger,
): Promise<{
  hooks: Hook[];
  hooksEnabled: boolean;
  workspaceHookSnapshot?: WorkspaceHookBundleSnapshotData;
}> {
// 先 resolve：后续所有路径比较（saveHooks 的 configuredState.sourcePath）都基于绝对路径；
// 保留用户传入的相对路径会让同一 workspace 出现两种键。
  const workspacePath = resolve(params.workspacePath);
// [权衡] user scope 只读用户目录：从某个项目进入 Source Settings 不代表要展示该项目 hook；
// 复用 project 分支的话，用户在该页保存会把项目 hook 复制进用户级。
  if (params.scope === "user") {
    const userSource = await readUserZCodeSource();
    const runtimeRoot = resolveWorkspaceHookRuntimeRoot([userSource?.hooks]);
    const hooks = [
      ...fromUserZCodeSource({
        source: userSource,
        runtimeRoot,
        workspacePath,
        location: buildLocation("zcode"),
      }),
      ...(await loadLegacyHooksFromLocation("agents")),
      ...(await loadLegacyHooksFromLocation("claude")),
    ];
    return { hooks, hooksEnabled: hooks.some((hook) => hook.enabled) };
  }
// 身份键与全仓约定一致：workspaceIdentity 优先、workspacePath 兜底；
// 混用会让同一 workspace 的 trust 记录在远程/本地切换时失效。
  const workspaceIdentity = params.workspaceIdentity?.trim() || workspacePath;
// [并发] 项目来源与用户来源互不依赖，并行读取缩短设置页首帧；
// 各自内部仍串行，保持 discoveryOrder 与 refs 下标一致（顺序是 digest 输入）。
  const [{ sources: projectSources }, userSource] = await Promise.all([
    readWorkspaceHookProjectSources({ workingDirectory: workspacePath }),
    readUserZCodeSource(),
  ]);
  const runtimeRoot = resolveWorkspaceHookRuntimeRoot([
    userSource?.hooks,
    ...projectSources.map((source) => source.hooks),
  ]);
// runtimeRoot 是所有来源的公共前缀，决定 hook 命令的 cwd：用户与项目来源必须一起参与计算，只传其一会让相对命令解析到错误目录。
// [事务] snapshot/digest 是信任记录的输入，必须用与 runtime 相同的 sources + discoveryOrder 重建；
// 任一处顺序变化都会让既有 trust 记录全部失效，用户被要求重新审批全部 hook。
  const workspaceHookSnapshot = buildWorkspaceHookBundleSnapshot({
    workspaceIdentity,
    workspacePath,
    sources: projectSources,
    runtimeRoot,
  });
// 持久信任在发现之后读取：只有拿到 canonical digest 才能判断哪些条目已获批。
  const persistentTrust = await readPersistentWorkspaceHookTrustDigests(workspaceIdentity, logger);
  const persistentTrustedDigests = persistentTrust.digests;
  const hooks = [
// 拼接顺序即执行顺序（INV-01）：项目来源在前，用户与 legacy 兼容来源在后。
    ...fromProjectSnapshot({
      sources: projectSources,
      snapshot: workspaceHookSnapshot,
      workspaceIdentity,
      workspacePath,
      persistentTrustedDigests,
    }),
// 项目 legacy 排在项目 zcode 之后：新格式优先、旧格式补齐；
// 两者都保留是为了不丢已有的 .claude/.agents 配置，而不是为了合并去重。
    ...(await loadLegacyHooksFromLocation("agents", workspacePath)),
    ...(await loadLegacyHooksFromLocation("claude", workspacePath)),
    ...fromUserZCodeSource({
      source: userSource,
      runtimeRoot,
      workspacePath,
      location: buildLocation("zcode"),
    }),
    ...(await loadLegacyHooksFromLocation("agents")),
    ...(await loadLegacyHooksFromLocation("claude")),
  ];
  return {
    hooks,
    hooksEnabled: hooks.some((hook) => hook.enabled),
    ...(workspaceHookSnapshot ? { workspaceHookSnapshot } : {}),
// [失败路径] trustStoreCorrupt 只在损坏时出现：调用方据此提示「需重新确认」，
// 与「无信任记录」区分开（前者要修复文件，后者正常审批即可）。
    ...(persistentTrust.corrupt ? { trustStoreCorrupt: true } : {}),
  };
}

async function writeZCodeHooksConfig(
  workspacePath: string | undefined,
  hooks: Hook[],
): Promise<void> {
// [事务] 读旧配置 → 合并 → 原子写，中间态只存在于内存；
// 若只写 hooks 字段，features/storage 等键会被整体覆盖丢失。
  const configPath = getConfigPath("zcode", workspacePath);
// 读失败按空对象处理（INV-03）：首次创建配置是正常路径，不应报错。
  const existingConfig = (await readJsonFile<ZCodeConfigFile>(configPath)) ?? {};
// 根开关由本次提交的 hook 列表推导而非沿用旧值：
// 用户删光全部 hook 时开关必须随之关闭，否则 runtime 仍会尝试执行空配置。
  const enabled = resolveNextRootEnabled(existingConfig.hooks?.enabled, hooks);
// 原子写保证崩溃窗口不留下半截 JSON，否则下次读取会把整份配置判为损坏。
  await atomicWriteWorkspaceHookConfig(configPath, {
    ...existingConfig,
    hooks: {
      ...existingConfig.hooks,
      ...(enabled !== undefined ? { enabled } : {}),
      events: toZCodeHooksEvents(hooks),
    },
  });
}

async function saveHooksImpl(params: {
  workspaceIdentity?: string;
  workspacePath: string;
  scope?: "all" | "user";
  hooks: Hook[];
}): Promise<void> {
// 用于识别「这条 hook 是否来自当前项目」：多窗口同时编辑不同 workspace 时，
// 不能把 A 项目的 hook 写进 B 项目的 config.json。
  const currentProjectConfigPath = resolve(params.workspacePath, ".zcode", "config.json");
// [权衡] 只回写 zcode 来源：.claude/.agents 是兼容读取面，写回会制造第二份事实。
// editable === false 的条目直接丢弃：它们来自只读视图（远端快照），写入会把展示态固化成配置。
  const userHooks = params.hooks.filter(
    (hook) =>
      hook.editable !== false &&
      (!hook.location || (hook.location.source === "zcode" && hook.location.scope === "user")),
  );
// configuredState 缺失视为新条目（允许写入）；存在时必须指向当前项目配置，
// 防止把别处读到的 hook 顺手落到本 workspace。
  const projectHooks = params.hooks.filter(
    (hook) =>
      hook.editable !== false &&
      hook.location?.source === "zcode" &&
      hook.location.scope === "project" &&
      (!hook.configuredState ||
        resolve(hook.configuredState.sourcePath) === currentProjectConfigPath),
  );
// 先写用户级再写项目级：用户级失败会中止整个保存，项目级失败则向调用方抛错，
// 不会出现「用户级已改、项目级未改」却静默成功的半提交状态。
  await writeZCodeHooksConfig(undefined, userHooks);
// user scope 禁止触碰 workspace 配置：Source Settings 的写入路径必须与读取对称。
  if (params.scope !== "user") {
    await writeZCodeHooksConfig(params.workspacePath, projectHooks);
  }
}

export function createHooksService(
  options: {
    logger?: ServiceLogger;
    grantWorkspaceHookTrust?: NonNullable<IHooksService["grantWorkspaceHookTrust"]>;
  } = {},
): IHooksService {
// logger 可注入：测试要断言 fail-closed 告警，生产用统一 scope 落盘。
// 只装配三个方法；grantWorkspaceHookTrust 由 Agent authority 注入，services 不自行写 trust store。
  const logger = options.logger ?? createServiceLogger("hooks-service");
  return {
// 每次调用都重新读盘：配置可被外部编辑，缓存会让设置页与 runtime 长期不一致。
    loadHooks: (params) => loadHooksImpl(params, logger),
    saveHooks: saveHooksImpl,
    ...(options.grantWorkspaceHookTrust
      ? { grantWorkspaceHookTrust: options.grantWorkspaceHookTrust }
      : {}),
  };
}
